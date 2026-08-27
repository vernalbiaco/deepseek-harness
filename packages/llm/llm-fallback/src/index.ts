/**
 * Ordered backup-model failover on the agent loop's request-recovery and
 * request-configuration extension points. The plugin owns no route until a
 * failure moves its cursor: the primary is whatever route the session already
 * resolves, so a deployment default and a user selection both stay authoritative.
 *
 * Every listener registers at plugin load rather than per agent. Agent setup
 * runs before `agent/created`, and ApiProxy installs its own `agent/request`
 * override during that setup; a later registration is an inner listener and
 * would be overridden on the unwind.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

import type { Context, Events } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { Config, resolveConfig } from './config.ts'
import { adoptIfChanged, advance, createState, resetForTurn, targetFor } from './state.ts'
import type { FallbackState, SelectedRoute } from './state.ts'

export type { FallbackRoute, LlmFallbackEventData } from './types.ts'
export type { FallbackState, SelectedRoute } from './state.ts'
export { Config, DEFAULT_FAILOVER_CODES } from './config.ts'

/** Cordis plugin name. */
export const name = 'llm-fallback'
/** Services required before the plugin registers its listeners. */
export const inject = ['agents']

/**
 * Read the route the durable header records for the agent's latest request.
 * The `agent/request-error` payload names the provider but not the model, so
 * the failing route comes from the log rather than from the event.
 *
 * @param agent - the agent whose request failed.
 * @returns the logged route, or `undefined` before any header exists.
 */
function loggedRoute(agent: Agent): SelectedRoute | undefined {
  const config = agent.session.requestHeader()?.config
  if (config === undefined) return undefined
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: config.reasoningEffort },
  }
}

/**
 * Register ordered backup-model failover.
 *
 * @param ctx - the mounting plugin context.
 * @param config - the validated composition entry.
 */
export function apply(ctx: Context, config: Config): void {
  const chain = resolveConfig(config)
  const states = new WeakMap<Agent, FallbackState>()
  const stateFor = (agent: Agent): FallbackState => {
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    const created = createState()
    states.set(agent, created)
    return created
  }

  const disposeClaimed = ctx.on('agent/inbox/claimed', ({ agent, turn }) => {
    resetForTurn(stateFor(agent), turn)
  })

  const disposeAssemble = ctx.on(
    'system-prompt/assemble',
    async (
      _assembly: PromptAssembly,
      context: AssembleContext,
      next: () => Promise<PromptAssembly>,
    ): Promise<PromptAssembly> => {
      const agent = context.agent
      const assembled = await next()
      if (agent === undefined) return assembled
      const state = stateFor(agent)
      const target = targetFor(state, chain)
      state.assembled = target
      if (target === undefined) return assembled
      return {
        ...assembled,
        variables: {
          ...assembled.variables,
          provider: target.provider,
          model: target.model,
        },
      }
    },
  )

  const disposeRequest = ctx.on('agent/request', async ({ agent }, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    const state = stateFor(agent)
    // The prompt for this step already names the assembled snapshot, so the
    // request must use it even when an external route change is adopted here:
    // applying the adopted route now would make {{model}} name a model the
    // request does not use. Adoption still updates the cursor, so the new route
    // becomes the target at the next assembly — the one-step deferral
    // installModelSelection applies to a concurrent switch
    // (packages/core/agent/src/model-selection.ts:28-31).
    const selected = state.assembled
    adoptIfChanged(state, resolved)
    if (selected === undefined) return resolved
    state.lastWritten = { provider: selected.provider, model: selected.model }
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      provider: selected.provider,
      model: selected.model,
      ...selected.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(selected.reasoningEffort) },
    }
  })

  const disposeError = ctx.on('agent/request-error', async (
    { agent, turn, step, failure, signal }: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> => {
    // Delegating first makes same-route retry win under normal mode and keeps
    // this plugin correct when it is mounted outside dsh-llm-retry.
    const downstream = await next()
    if (downstream?.kind === 'retry') return downstream
    if (signal.aborted) return undefined
    if (!chain.failoverCodes.has(failure.code)) return undefined
    const failed = loggedRoute(agent)
    if (failed === undefined) return undefined
    const state = stateFor(agent)
    const to = advance(state, chain, failed)
    if (to === undefined) return undefined
    agent.session.append('llm/fallback', {
      turn,
      step,
      from: { provider: failed.provider, model: failed.model },
      to: { provider: to.provider, model: to.model },
      cursor: state.cursor,
      failure,
    })
    return { kind: 'retry' }
  })

  ctx.effect(() => () => {
    disposeClaimed()
    disposeAssemble()
    disposeRequest()
    disposeError()
  }, 'llm-fallback: remove failover listeners')
}

export default apply
