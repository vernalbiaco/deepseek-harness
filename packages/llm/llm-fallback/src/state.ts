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
  /** Route this plugin most recently applied, used to detect an external change. */
  lastWritten: FallbackRoute | undefined
  /** Turn that last reset the cursor, so mid-turn steering cannot reset again. */
  lastResetTurn: number | undefined
  /** Route snapshotted when the current step entered prompt assembly. */
  assembled: SelectedRoute | undefined
}

/**
 * Create the initial state for one agent.
 * @returns state with the cursor on the primary and nothing captured.
 */
export function createState(): FallbackState {
  return {
    cursor: 0,
    primary: undefined,
    lastWritten: undefined,
    lastResetTurn: undefined,
    assembled: undefined,
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
  const backup = chain.backups[state.cursor - 1]
  return backup === undefined ? undefined : { ...backup }
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
  const backup = chain.backups[state.cursor - 1]
  return backup === undefined ? undefined : { ...backup }
}

/**
 * Adopt a route changed outside this plugin as the new primary.
 * A delegated route equal to this plugin's last write is the durable log
 * echoing that write; anything else is a user selection or settings change,
 * which outranks the cursor and restarts the chain from the new route.
 *
 * @param state - the agent's failover state.
 * @param delegated - the route the rest of the `agent/request` waterfall produced.
 * @returns whether the delegated route was adopted and must be left unchanged.
 */
export function adoptIfChanged(state: FallbackState, delegated: FallbackRoute): boolean {
  if (state.lastWritten === undefined) return false
  if (sameRoute(delegated, state.lastWritten)) return false
  state.primary = { provider: delegated.provider, model: delegated.model }
  state.cursor = 0
  state.lastWritten = undefined
  state.assembled = undefined
  return true
}
