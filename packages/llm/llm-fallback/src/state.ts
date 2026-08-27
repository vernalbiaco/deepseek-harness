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
  /** Route this plugin most recently applied, used to detect an external change. */
  lastWritten: FallbackRoute | undefined
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
    lastResetTurn: undefined,
  }
}

function sameRoute(left: FallbackRoute, right: FallbackRoute): boolean {
  return left.provider === right.provider && left.model === right.model
}

/**
 * Return the cursor to the primary once per turn.
 * `agent/inbox/claimed` also fires for mid-turn steering, so a repeated turn
 * number must not re-probe a route that just failed inside the open turn.
 *
 * @param state - the agent's failover state.
 * @param turn - the turn that claimed a message.
 */
export function resetForTurn(state: FallbackState, turn: number): void {
  if (state.lastResetTurn === turn) return
  state.lastResetTurn = turn
  state.cursor = 0
}

/**
 * Move to the next backup after a failure this plugin owns.
 * The first move captures the failing route so a later reset can restore it.
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
 * Stage a route changed outside this plugin, to take effect at the next assembly.
 * A delegated route equal to this plugin's last write is the durable log echoing
 * that write; anything else is a user selection or settings change. Staging
 * rather than applying keeps the prompt and the request naming the same route
 * for this step: the loop renders one system prompt per step, so a route change
 * this plugin chooses to make must wait for the next assembly.
 *
 * @param state - the agent's failover state.
 * @param delegated - the route the rest of the `agent/request` waterfall produced.
 * @returns whether the delegated route was staged.
 */
export function adoptIfChanged(state: FallbackState, delegated: FallbackRoute): boolean {
  if (state.lastWritten === undefined) return false
  if (sameRoute(delegated, state.lastWritten)) return false
  state.pending = { provider: delegated.provider, model: delegated.model }
  state.lastWritten = undefined
  return true
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
