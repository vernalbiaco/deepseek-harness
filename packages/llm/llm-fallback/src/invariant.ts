/** Package-owned durable failover-event invariants. @module @deepseek-ai/dsh-llm-fallback/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { FallbackRoute, LlmFallbackEventData } from './types.ts'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-fallback'

/** Cordis companion plugin name. */
export const name = 'llm-fallback-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate the complete provider-neutral failure payload at the durable boundary. */
function validateFailure(value: unknown, fail: InvariantFailure): asserts value is LlmFailure {
  if (typeof value !== 'object' || value === null) {
    fail('llm/fallback failure must be an object')
  }
  const failure = value as Partial<LlmFailure>
  if (typeof failure.message !== 'string' || failure.message.length === 0) {
    fail('llm/fallback failure.message must be a non-empty string')
  }
  if (typeof failure.code !== 'string' || failure.code.length === 0) {
    fail('llm/fallback failure.code must be a non-empty string')
  }
  if (failure.status !== undefined
    && (!Number.isInteger(failure.status) || failure.status < 100 || failure.status > 599)) {
    fail('llm/fallback failure.status must be an integer from 100 through 599 when present')
  }
  if (failure.providerRetryAfterMs !== undefined
    && (!Number.isFinite(failure.providerRetryAfterMs) || failure.providerRetryAfterMs <= 0)) {
    fail('llm/fallback failure.providerRetryAfterMs must be a positive finite number when present')
  }
  if (failure.requestId !== undefined
    && (typeof failure.requestId !== 'string' || failure.requestId.length === 0)) {
    fail('llm/fallback failure.requestId must be a non-empty string when present')
  }
}

/**
 * Find the route the most recent durable request header in `history` names.
 * A header stays in force across turn and step boundaries until a newer full
 * snapshot changes it, so this is an unbounded backward scan, not one gated
 * to the currently open step.
 */
function routeInForce(history: readonly SessionEvent[]): FallbackRoute | undefined {
  const header = history.findLast((prior): prior is SessionEvent<'request/header'> =>
    prior.type === 'request/header')
  if (header === undefined) return undefined
  return { provider: header.data.header.config.provider, model: header.data.header.config.model }
}

/**
 * Validate one durable request header against the failover record it may complete.
 * `AgentLoop.step()` never closes the step for a `{ kind: 'retry' }` action
 * (packages/core/agent-loop/src/agent.ts:333-390): the retried request's own
 * `request/header` is the next event this package can observe after
 * `llm/fallback`, so the forward relationship between the two is checked from
 * here, backward, rather than from `llm/fallback` looking ahead for a header
 * that does not exist yet at append time.
 *
 * The scan stops at the owning step's `step/end`, which `AgentLoop.turn()`
 * appends from a `finally` (packages/core/agent-loop/src/agent.ts:279-292):
 * a record whose retry appends no header is retired with its step instead of
 * staying armed against a header some later turn appends. A retry appends no
 * header when its route already equals the one in force, because
 * `buildRequest` appends `request/header` only when the header differs
 * (packages/core/agent-loop/src/agent.ts:483-488), and `resolveConfig`
 * (./config.ts) rejects a duplicate route within `backups` but not one that
 * duplicates the session's own primary — that route is not itself a member of
 * `backups` — so `backups: [primary, b1]` against a session already on
 * `primary` is reachable configuration. A retry abandoned before
 * `buildRequest` runs leaves the same record unconfirmed.
 */
function validateHeaderFollowsFallback(
  history: readonly SessionEvent[],
  event: SessionEvent<'request/header'>,
  fail: InvariantFailure,
): void {
  const prior = history.findLast(candidate =>
    candidate.type === 'llm/fallback'
    || candidate.type === 'request/header'
    || candidate.type === 'step/end')
  if (prior?.type !== 'llm/fallback') return
  const { to } = prior.data
  const { provider, model } = event.data.header.config
  if (provider !== to.provider || model !== to.model) {
    fail(`request/header route ${provider}/${model} must match the pending llm/fallback target ${to.provider}/${to.model}`)
  }
}

/** Validate one failover record against the currently open request step. */
function validateFallback(
  history: readonly SessionEvent[],
  event: SessionEvent<'llm/fallback'>,
  fail: InvariantFailure,
): void {
  const { turn, step, from, to, cursor, failure }: LlmFallbackEventData = event.data
  validateFailure(failure, fail)
  if (typeof to.provider !== 'string' || to.provider.length === 0) {
    fail('llm/fallback to.provider must be a non-empty string')
  }
  if (typeof to.model !== 'string' || to.model.length === 0) {
    fail('llm/fallback to.model must be a non-empty string')
  }

  const turnBoundary = history.findLast(prior =>
    prior.type === 'turn/start' || prior.type === 'turn/end')
  if (turnBoundary?.type !== 'turn/start') {
    fail('llm/fallback must be appended inside an open turn')
  }
  if (turn !== turnBoundary.data.turn) {
    fail(`llm/fallback names turn ${turn}, but the open turn is ${turnBoundary.data.turn}`)
  }

  // The step stays open through a mid-step failover cascade: `next()` for
  // `agent/request-error` returning `{ kind: 'retry' }` re-enters `step()`'s
  // own request loop without appending `step/end`, so several `llm/fallback`
  // records can share one open turn/step, never a closed one.
  const stepBoundary = history.findLast(prior =>
    prior.type === 'step/start' || prior.type === 'step/end')
  if (stepBoundary?.type !== 'step/start') {
    fail('llm/fallback must be appended inside an open step')
  }
  if (step !== stepBoundary.data.step || turn !== stepBoundary.data.turn) {
    fail(`llm/fallback names turn ${turn}/step ${step}, but the open step is ${stepBoundary.data.turn}/${stepBoundary.data.step}`)
  }

  const loggedRoute = routeInForce(history)
  if (loggedRoute === undefined) {
    fail('llm/fallback must be appended after a durable request header')
  } else if (loggedRoute.provider !== from.provider || loggedRoute.model !== from.model) {
    fail(`llm/fallback from ${from.provider}/${from.model} does not match the failed request route ${loggedRoute.provider}/${loggedRoute.model}`)
  }

  // No durable chain-length bound to check against: `advance()` (./state.ts)
  // is the sole writer of `cursor` and returns `undefined` once the chain is
  // exhausted, and `index.ts` never appends `llm/fallback` when that happens,
  // so a durable record's cursor cannot exceed the configured chain length by
  // construction. Re-verifying that bound here would mean logging the chain
  // length on every record solely to re-check what a pure function already
  // enforces; a positive-safe-integer check is what remains checkable.
  if (!Number.isSafeInteger(cursor) || cursor < 1) {
    fail('llm/fallback cursor must be a positive safe integer')
  }
  // The scope is per-step, not per-turn: `promotePending` (./state.ts) can
  // reset the cursor at any `system-prompt/assemble`, which fires once per
  // step, so a later step in the same turn can legitimately restart at `1`
  // after an earlier step already advanced past it. That promotion is not
  // itself logged, so a cross-step comparison has no durable anchor — only a
  // same-step, consecutive-record comparison does, since assembly runs once
  // before a step's request loop starts and cannot fire again inside it.
  const priorStepFallback = history.findLast((prior): prior is SessionEvent<'llm/fallback'> =>
    prior.type === 'llm/fallback' && prior.data.turn === turn && prior.data.step === step)
  if (priorStepFallback !== undefined && cursor !== priorStepFallback.data.cursor + 1) {
    fail(`llm/fallback cursor ${cursor} must equal ${priorStepFallback.data.cursor + 1} for turn ${turn}/step ${step}`)
  }
}

/** Validate every failover and header record already present in one loaded session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    const history = session.events.slice(0, index)
    if (event.type === 'llm/fallback') validateFallback(history, event, fail)
    else if (event.type === 'request/header') validateHeaderFollowsFallback(history, event, fail)
  }
}

/* jscpd:ignore-start -- deliberately mirrors dsh-llm-retry's companion: both
   register a two-event validator through the same invariant protocol, so the
   installer and the `apply` export follow from that protocol rather than from
   anything this package chooses. */
/** Install validation for loaded and newly appended failover records. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'llm/fallback') validateFallback(session.events, event, fail)
    else if (event.type === 'request/header') validateHeaderFollowsFallback(session.events, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the LLM fallback invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
