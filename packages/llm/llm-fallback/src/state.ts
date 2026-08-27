/**
 * Per-agent failover cursor and the route decisions taken from it.
 *
 * @module @deepseek-ai/dsh-llm-fallback/state
 */

import type { ResolvedFallbackConfig } from './config.ts'
import type { FallbackRoute } from './types.ts'

/** A provider route plus the reasoning effort captured with it. */
export interface SelectedRoute {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort captured with the route, when it had one. */
  reasoningEffort?: string
}

/** Mutable failover state for one agent. */
export interface FallbackState {
  /** `0` selects the primary; `n` selects `backups[n - 1]`. */
  cursor: number
  /** Route captured before the first move, re-asserted when the cursor returns to zero. */
  primary: SelectedRoute | undefined
  /** Route adopted from outside this plugin, applied at the next assembly. */
  pending: SelectedRoute | undefined
  /**
   * Route this plugin applied to the most recent request it overrode. A
   * promotion moves `primary` off that route, which would otherwise leave the
   * plugin's own last write in no suppression set at all.
   */
  lastWritten: FallbackRoute | undefined
  /**
   * Highest cursor held since the current turn began, so
   * `backups[0 .. reachedThisTurn - 1]` are the backups written within it.
   * Raised only by `advance()`, past its length guard, so it never exceeds
   * `backups.length`. A promotion leaves it alone: the routes written earlier in
   * the open turn can still be delegated back after it.
   */
  reachedThisTurn: number
  /**
   * What `reachedThisTurn` held when the previous turn ended. Carried because a
   * turn is delegated the header the previous one left, and its own steps can
   * write before that delegation is examined.
   */
  reachedPreviousTurn: number
  /** Turn that last reset the cursor, so mid-turn steering cannot reset again. */
  lastResetTurn: number | undefined
}

/**
 * Create the initial state for one agent.
 * @returns state with the cursor on the primary and nothing captured.
 */
export function createState(): FallbackState {
  return {
    cursor: 0,
    primary: undefined,
    pending: undefined,
    lastWritten: undefined,
    reachedThisTurn: 0,
    reachedPreviousTurn: 0,
    lastResetTurn: undefined,
  }
}

// Route identity only, by design: `provider`/`model` decide where the cursor
// points, and the effort riding on a selection has its own path through
// refreshPrimaryEffort. Comparing the effort here would let an effort change
// restart the chain and pull an open turn back to a route that just failed.
function sameRoute(left: FallbackRoute, right: FallbackRoute): boolean {
  return left.provider === right.provider && left.model === right.model
}

/**
 * Return the cursor to the primary once per turn, and roll the reach marks.
 * `agent/inbox/claimed` also fires for mid-turn steering, so a repeated turn
 * number must not re-probe a route that just failed inside the open turn, nor
 * discard the reach the open turn has accumulated.
 *
 * @param state - the agent's failover state.
 * @param turn - the turn that claimed a message.
 */
export function resetForTurn(state: FallbackState, turn: number): void {
  if (state.lastResetTurn === turn) return
  state.lastResetTurn = turn
  state.cursor = 0
  state.reachedPreviousTurn = state.reachedThisTurn
  state.reachedThisTurn = 0
}

/**
 * Move to the next backup after a failure this plugin owns.
 * The first move captures the failing route so a later reset can restore it,
 * and every move records how far the cursor has reached.
 *
 * @param state - the agent's failover state.
 * @param chain - the resolved backup chain.
 * @param failed - the route whose request failed, read from the durable header.
 * @returns the route the retry turn requests, or `undefined` when the chain is exhausted.
 */
export function advance(
  state: FallbackState,
  chain: ResolvedFallbackConfig,
  failed: SelectedRoute,
): FallbackRoute | undefined {
  if (state.cursor === 0) state.primary = { ...failed }
  if (state.cursor >= chain.backups.length) return undefined
  state.cursor += 1
  // The guard above already returned when the cursor reached the chain's
  // length, so the incremented cursor indexes a route this chain holds.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const backup = chain.backups[state.cursor - 1]!
  if (state.cursor > state.reachedThisTurn) state.reachedThisTurn = state.cursor
  return { ...backup }
}

/**
 * Name the route the cursor currently selects.
 * `undefined` means this plugin has never moved and owns no opinion, which is
 * distinct from a cursor returned to a primary it captured earlier: after a
 * failover the primary must be asserted, because the durable header the
 * session reads back records the backup.
 *
 * @param state - the agent's failover state.
 * @param chain - the resolved backup chain.
 * @returns the route to apply, or `undefined` to leave the request untouched.
 */
export function targetFor(
  state: FallbackState,
  chain: ResolvedFallbackConfig,
): SelectedRoute | undefined {
  if (state.cursor === 0) return state.primary === undefined ? undefined : { ...state.primary }
  // Every mutator of state.cursor (advance, resetForTurn, promotePending)
  // keeps it within [0, chain.backups.length] for the one chain resolved
  // once per apply() and never swapped, so a non-zero cursor here always
  // indexes a route this chain holds.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const backup = chain.backups[state.cursor - 1]!
  return { ...backup }
}

/**
 * Stage a route chosen outside this plugin, to take effect at the next assembly.
 * A delegated route is an external choice only when it names no route this
 * plugin has written recently enough for a delegation to still carry it. Both
 * sources reach back one step: with no route owner mounted the delegation is
 * the durable header, which names the last request, and under a route owner it
 * is the selection `installModelSelection` snapshotted at this step's assembly,
 * which is that header as of the previous step.
 *
 * Three suppressors stand for that reach, and each covers a case the others do
 * not.
 *
 * - `state.primary` is what cursor `0` writes, and is what a route owner
 *   re-asserting a standing selection delegates on every step of an open turn.
 * - `backups[0 .. reached - 1]`, for `reached` the larger of this turn's and the
 *   previous turn's high-water cursor. A turn that cascaded leaves its last
 *   backup in the durable header, and the next turn is delegated it while the
 *   cursor sits back at zero. This mark is per turn rather than per step because
 *   nothing records when within a turn each backup was written, and a promotion
 *   taken mid-turn strands the writes that preceded it. It is therefore wider
 *   than the reach it stands for: a cascade writes several backups in one step
 *   and only its last is delegable afterwards, yet all of them stay suppressed
 *   until the marks roll past them.
 * - `state.lastWritten` is the most recent write of all, which a promotion
 *   strands: it moves `state.primary` onto the adopted route and leaves the
 *   route written just before it outside the other two sets.
 *
 * Matching a suppressor is taken as this plugin's own echo. `state.primary` and
 * `state.lastWritten` are exact: a delegation naming either really is the
 * request a session with no pick produces. The turn marks trade precision for
 * the two unknowns above, so a pick they suppress is deferred rather than
 * undecidable — the marks roll past the route one turn later and it is adopted
 * then. A route matching none of the three is a choice and stages at once.
 *
 * `README.md` states what a permanently suppressed pick costs.
 *
 * Before the first failover the plugin holds no primary and overrides no
 * request, so a change of selection reaches the provider on its own and needs no
 * staging.
 *
 * Staging rather than applying keeps the prompt and the request naming the same
 * route for this step: the loop renders one system prompt per step, so a route
 * change this plugin chooses to make must wait for the next assembly.
 *
 * @param state - the agent's failover state.
 * @param chain - the resolved backup chain.
 * @param delegated - the route the rest of the `agent/request` waterfall produced.
 * @returns whether the delegated route was staged.
 */
export function adoptIfChanged(
  state: FallbackState,
  chain: ResolvedFallbackConfig,
  delegated: FallbackRoute,
): boolean {
  const primary = state.primary
  if (primary === undefined) return false
  if (sameRoute(delegated, primary)) return false
  const lastWritten = state.lastWritten
  if (lastWritten !== undefined && sameRoute(delegated, lastWritten)) return false
  const reached = Math.max(state.reachedThisTurn, state.reachedPreviousTurn)
  const written = chain.backups.slice(0, reached)
  if (written.some(backup => sameRoute(delegated, backup))) return false
  state.pending = { provider: delegated.provider, model: delegated.model }
  return true
}

/**
 * Refresh the effort captured with the primary from a delegation naming that route.
 * The effort is captured with the failing route so a later re-assertion can restore
 * it: after a failover the durable header records the backup, which carries no
 * effort, so the delegated config alone cannot supply it. That capture must not
 * outlive the selection it came from — a delegation that still names the primary
 * route carries the session's current effort, including its absence when the
 * selection cleared it, and is authoritative over the captured value.
 *
 * The cursor is untouched: an effort change is not a route change and must not
 * restart the chain.
 *
 * @param state - the agent's failover state.
 * @param delegated - the route the rest of the `agent/request` waterfall produced.
 */
export function refreshPrimaryEffort(state: FallbackState, delegated: SelectedRoute): void {
  const primary = state.primary
  if (primary === undefined) return
  if (primary.provider !== delegated.provider || primary.model !== delegated.model) return
  if (delegated.reasoningEffort === undefined) delete primary.reasoningEffort
  else primary.reasoningEffort = delegated.reasoningEffort
}

/**
 * Apply a staged external route as the new primary, restarting the chain from it.
 * Called once per assembly, before the step's target is computed.
 *
 * @param state - the agent's failover state.
 */
export function promotePending(state: FallbackState): void {
  if (state.pending === undefined) return
  state.primary = { ...state.pending }
  state.cursor = 0
  state.pending = undefined
}
