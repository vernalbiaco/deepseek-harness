import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as fallback from '../src/index.ts'
import type { Config } from '../src/config.ts'

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function failure(code: string, message = 'scripted failure'): StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { message, code } } }]
}

/** Serves a scripted queue of chunk batches per `provider/model` route. */
class RouteAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: Record<string, StreamChunk[][]>) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const key = `${options.provider}/${options.model}`
    const queue = this.script[key]
    if (queue === undefined || queue.length === 0) {
      throw new Error(`fallback test script exhausted for route "${key}"`)
    }
    // A single remaining batch repeats, so a route can fail indefinitely.
    yield* queue.length === 1 ? queue[0]! : queue.shift()!
  }

  // Declares 'low' and 'high' so a test can round-trip a reasoning effort, and
  // change one, without the adapter rejecting it as unsupported.
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
      },
    })
  }
}

async function harness(
  adapter: RouteAdapter,
  config: Config,
  beforeFallback?: (ctx: Context) => void,
  afterFallback?: (ctx: Context) => void,
): Promise<{ ctx: Context; fiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  // Exposes the assembled route on GenerateOptions.system, so a test can
  // prove the prompt and the request agree on which model is being asked.
  // `complete: true` keeps the rendered prompt to exactly this text.
  ctx.systemPrompt.section({ name: 'route', order: 0, text: '{{provider}}/{{model}}', complete: true })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  beforeFallback?.(ctx)
  const fiber = await ctx.plugin(Object.assign((inner: Context) => {
    fallback.apply(inner, config)
  }, { inject: fallback.inject }))
  afterFallback?.(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['primary', 'b1', 'b2'], adapter)
  return { ctx, fiber }
}

function fallbackEvents(agent: Agent): SessionEvent<'llm/fallback'>[] {
  return agent.session.events.filter(
    (event): event is SessionEvent<'llm/fallback'> => event.type === 'llm/fallback',
  )
}

function prompt(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

const ONE_BACKUP: Config = { backups: [{ provider: 'b1', model: 'm1' }] }
const TWO_BACKUPS: Config = {
  backups: [{ provider: 'b1', model: 'm1' }, { provider: 'b2', model: 'm2' }],
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('backup-model failover', () => {
  it('fails over to the first backup after a rate limit', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT', 'limited')],
      'b1/m1': [textResponse('served by the backup')],
    })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP))
    const agent = context.agentLoop.create(SessionId('failover-basic'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests.map(r => `${r.provider}/${r.model}`))
      .toEqual(['primary/m', 'b1/m1'])
    const events = fallbackEvents(agent)
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toEqual({
      turn: 1,
      step: 1,
      from: { provider: 'primary', model: 'm' },
      to: { provider: 'b1', model: 'm1' },
      cursor: 1,
      failure: { message: 'limited', code: 'RATE_LIMIT' },
    })
  })

  it('fails over on the first AUTH failure with no same-route retry', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('AUTH', 'bad key')],
      'b1/m1': [textResponse('ok')],
    })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP))
    const agent = context.agentLoop.create(SessionId('failover-auth'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests.map(r => `${r.provider}/${r.model}`))
      .toEqual(['primary/m', 'b1/m1'])
    expect(fallbackEvents(agent)).toHaveLength(1)
  })

  it('leaves a code it does not own to a downstream policy', async () => {
    let reached = 0
    const adapter = new RouteAdapter({
      'primary/m': [failure('CONTEXT_WINDOW_EXCEEDED', 'too long')],
    })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP, (ctx) => {
      ctx.on('agent/request-error', (_payload, next): Promise<RequestErrorAction> => {
        reached += 1
        return next()
      })
    }))
    const agent = context.agentLoop.create(SessionId('failover-overflow'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'go')
    await agent.whenIdle()

    expect(reached).toBe(1)
    expect(fallbackEvents(agent)).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
  })

  it('walks the whole chain and then leaves the failure terminal', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('SERVER')],
      'b1/m1': [failure('SERVER')],
      'b2/m2': [failure('SERVER')],
    })
    ;({ ctx: context } = await harness(adapter, TWO_BACKUPS))
    const agent = context.agentLoop.create(SessionId('failover-exhausted'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests.map(r => r.provider)).toEqual(['primary', 'b1', 'b2'])
    expect(fallbackEvents(agent).map(event => event.data)).toEqual([
      {
        turn: 1,
        step: 1,
        from: { provider: 'primary', model: 'm' },
        to: { provider: 'b1', model: 'm1' },
        cursor: 1,
        failure: { message: 'scripted failure', code: 'SERVER' },
      },
      {
        turn: 1,
        step: 1,
        from: { provider: 'b1', model: 'm1' },
        to: { provider: 'b2', model: 'm2' },
        cursor: 2,
        failure: { message: 'scripted failure', code: 'SERVER' },
      },
    ])
    // The exhausted cascade surfaces as a terminal error, not a silent stop.
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'SERVER', message: 'scripted failure' } } },
    })
  })

  it('returns to the primary on the next user turn', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT'), textResponse('primary recovered')],
      'b1/m1': [textResponse('backup')],
    })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP))
    const agent = context.agentLoop.create(SessionId('failover-reset'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'first')
    await agent.whenIdle()
    prompt(agent, 'second')
    await agent.whenIdle()

    expect(adapter.requests.map(r => `${r.provider}/${r.model}`))
      .toEqual(['primary/m', 'b1/m1', 'primary/m'])
    expect(fallbackEvents(agent)).toHaveLength(1)
  })

  it('prefers a downstream retry over failover, then acts once its budget is exhausted', async () => {
    const maxDownstreamRetries = 1
    let downstreamRetries = 0
    // SERVER is a code both a real retry policy and this plugin's default
    // failoverCodes own; AUTH (used elsewhere in this file) reaches failover
    // directly with no same-route retry and could not exercise this path.
    const adapter = new RouteAdapter({
      'primary/m': [failure('SERVER'), failure('SERVER')],
      'b1/m1': [textResponse('backup')],
    })
    // Shaped like a bounded downstream retry policy (dsh-llm-retry's real
    // decision surface): retries the same route while its budget remains,
    // then declines by calling `next()`, letting the plugin's own next()
    // (which reaches this listener since it's registered afterFallback, INNER)
    // see no retry and take over.
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP, undefined, (ctx) => {
      ctx.on('agent/request-error', async (_payload, next): Promise<RequestErrorAction> => {
        if (downstreamRetries >= maxDownstreamRetries) return next()
        downstreamRetries += 1
        return { kind: 'retry' }
      })
    }))
    const agent = context.agentLoop.create(SessionId('failover-retry-wins'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests.map(r => r.provider)).toEqual(['primary', 'primary', 'b1'])
    expect(fallbackEvents(agent).map(event => event.data)).toEqual([{
      turn: 1,
      step: 1,
      from: { provider: 'primary', model: 'm' },
      to: { provider: 'b1', model: 'm1' },
      cursor: 1,
      failure: { message: 'scripted failure', code: 'SERVER' },
    }])
  })

  it('stops failing over once its listeners are disposed', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT')],
      'b1/m1': [textResponse('backup')],
    })
    const mounted = await harness(adapter, ONE_BACKUP)
    context = mounted.ctx
    await mounted.fiber.dispose()

    const agent = context.agentLoop.create(SessionId('failover-disposed'), {
      provider: 'primary',
      model: 'm',
    })
    prompt(agent, 'go')
    await agent.whenIdle()

    expect(fallbackEvents(agent)).toHaveLength(0)
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('composition with other route owners', () => {
  it('does not re-probe the primary when steering lands mid-turn', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT')],
      'b1/m1': [textResponse('backup settled')],
    })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP, (ctx) => {
      ctx.on('agent/request-error', async ({ agent }, next): Promise<RequestErrorAction> => {
        // Steer into the open turn's next step, before the failover decision is taken.
        if (adapter.requests.length === 1) {
          agent.steer(createUserMessage({ content: [{ type: 'text', text: 'steer' }], source: { kind: 'user' } }))
        }
        return next()
      })
    }))
    const agent = context.agentLoop.create(SessionId('failover-steering'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'go')
    await agent.whenIdle()

    // The primary is requested once, at the start of the turn. Steering must not
    // reset the cursor back to it, so every later request stays on the backup.
    expect(adapter.requests.map(r => r.provider)).toEqual(['primary', 'b1', 'b1'])
    expect(fallbackEvents(agent).map(event => event.data)).toEqual([{
      turn: 1,
      step: 1,
      from: { provider: 'primary', model: 'm' },
      to: { provider: 'b1', model: 'm1' },
      cursor: 1,
      failure: { message: 'scripted failure', code: 'RATE_LIMIT' },
    }])
  })

  // Keeps one turn open across `count` further steps by steering once per
  // request already made, so a test can observe the cursor across a whole turn.
  function steerAcrossSteps(ctx: Context, agent: Agent, adapter: RouteAdapter, count: number): void {
    let steers = 0
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      if (steers < count && adapter.requests.length >= 1 + steers) {
        steers += 1
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: 'more' }],
          source: { kind: 'user' },
        }))
      }
      return resolved
    })
  }

  it('keeps the cursor on the backup while a standing selection re-asserts the primary', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT')],
      'b1/m1': [textResponse('backup settled')],
    })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP))
    const agent = context.agentLoop.create(SessionId('failover-standing-selection'), {
      provider: 'primary',
      model: 'm',
    })
    // dsh-bundle-headless installs exactly this: a selection ref fixed at agent
    // setup that never re-reads the durable header, so every request in the
    // session is overridden back to the deployment's primary. The delegated
    // route therefore always differs from the route this plugin last wrote,
    // without any user having changed anything.
    installModelSelection(agent.ctx, {
      current: { provider: 'primary', model: 'm' },
      assembled: undefined,
    })
    steerAcrossSteps(context, agent, adapter, 2)

    prompt(agent, 'go')
    await agent.whenIdle()

    // The primary is requested once, at the start of the turn. A standing
    // selection re-asserted on every step must not read as a user pick, so no
    // step inside the open turn returns to the route that just failed.
    expect(adapter.requests.map(r => `${r.provider}/${r.model}`))
      .toEqual(['primary/m', 'b1/m1', 'b1/m1', 'b1/m1'])
    expect(fallbackEvents(agent)).toHaveLength(1)
  })

  it('adopts an explicit pick of the route the cursor is already serving', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT')],
      'b1/m1': [textResponse('backup')],
    })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP))
    const agent = context.agentLoop.create(SessionId('failover-pick-asserted-backup'), {
      provider: 'primary',
      model: 'm',
    })
    const selected: ModelSelectionRef = {
      current: { provider: 'primary', model: 'm' },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selected)

    prompt(agent, 'first')
    await agent.whenIdle()
    // The picker reports the backup as the live route once the failover lands,
    // so picking it is the user staying on the route that answers.
    selected.current = { provider: 'b1', model: 'm1' }
    prompt(agent, 'second')
    await agent.whenIdle()
    prompt(agent, 'third')
    await agent.whenIdle()
    prompt(agent, 'fourth')
    await agent.whenIdle()

    // The pick is recognized one request after it first appears, because that
    // first delegation is this plugin's own write echoed back. Turn 2 still
    // re-probes the primary, and from turn 3 the picked route is the primary
    // the chain restarts from, so the failing route is never requested again.
    expect(adapter.requests.map(r => `${r.provider}/${r.model}`))
      .toEqual(['primary/m', 'b1/m1', 'primary/m', 'b1/m1', 'b1/m1', 'b1/m1'])
    expect(fallbackEvents(agent)).toHaveLength(2)
  })

  it('holds the cursor across turns while a standing selection re-asserts a failing primary', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT')],
      'b1/m1': [textResponse('backup')],
    })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP))
    const agent = context.agentLoop.create(SessionId('failover-standing-selection-turn-two'), {
      provider: 'primary',
      model: 'm',
    })
    installModelSelection(agent.ctx, {
      current: { provider: 'primary', model: 'm' },
      assembled: undefined,
    })

    prompt(agent, 'first')
    await agent.whenIdle()
    // Steering only from here, so turn 1 is one step and turn 2 spans two.
    steerAcrossSteps(context, agent, adapter, 2)
    prompt(agent, 'second')
    await agent.whenIdle()

    // Turn 2 re-probes the primary once, at its start. The standing selection
    // it re-asserts on every later step must not read as a user pick there
    // either, so no step of the open turn returns to the failing route.
    expect(adapter.requests.map(r => `${r.provider}/${r.model}`))
      .toEqual(['primary/m', 'b1/m1', 'primary/m', 'b1/m1', 'b1/m1'])
    expect(fallbackEvents(agent)).toHaveLength(2)
  })

  it('cascades from the settled backup when no route owner is mounted', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT')],
      'b1/m1': [textResponse('backup'), textResponse('backup again'), failure('RATE_LIMIT')],
      'b2/m2': [textResponse('second backup')],
    })
    // No route owner: the delegated route is the durable header read back, so
    // it changes once, when the failover's own write lands in the log. Treating
    // that as an external pick would promote the backup to primary and lose the
    // chain position, sending the next failure back to the route that failed.
    ;({ ctx: context } = await harness(adapter, TWO_BACKUPS))
    const agent = context.agentLoop.create(SessionId('failover-cascade-no-owner'), {
      provider: 'primary',
      model: 'm',
    })
    steerAcrossSteps(context, agent, adapter, 2)

    prompt(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests.map(r => `${r.provider}/${r.model}`))
      .toEqual(['primary/m', 'b1/m1', 'b1/m1', 'b1/m1', 'b2/m2'])
    expect(fallbackEvents(agent).map(event => event.data.from)).toEqual([
      { provider: 'primary', model: 'm' },
      { provider: 'b1', model: 'm1' },
    ])
    expect(fallbackEvents(agent).map(event => event.data.cursor)).toEqual([1, 2])
  })

  it('adopts a reasoning effort changed between turns while the cursor holds', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT'), textResponse('primary recovered')],
      'b1/m1': [textResponse('backup')],
    })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP))
    const agent = context.agentLoop.create(SessionId('failover-effort-change'), {
      provider: 'primary',
      model: 'm',
    })
    // `ModelSelectionRef.current` is the entry point's own mutable selection, so
    // changing it between turns is the real user-pick path rather than a test
    // artifice. Only the effort moves: the route is the primary throughout.
    const selected: ModelSelectionRef = {
      current: { provider: 'primary', model: 'm', reasoningEffort: ReasoningEffortId('low') },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selected)

    prompt(agent, 'first')
    await agent.whenIdle()
    selected.current = { provider: 'primary', model: 'm', reasoningEffort: ReasoningEffortId('high') }
    prompt(agent, 'second')
    await agent.whenIdle()
    prompt(agent, 'third')
    await agent.whenIdle()

    // The effort captured with the primary at failover time must not outlive the
    // selection it came from: the re-asserted primary carries the effort the
    // session now selects, not the one it selected when the failover happened.
    expect(adapter.requests.map(r => `${r.provider}/${r.model}:${r.reasoningEffort}`))
      .toEqual(['primary/m:low', 'b1/m1:undefined', 'primary/m:high', 'primary/m:high'])
    expect(fallbackEvents(agent)).toHaveLength(1)
  })

  it('does not move the cursor when only the reasoning effort changes mid-turn', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT')],
      'b1/m1': [textResponse('backup')],
    })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP))
    const agent = context.agentLoop.create(SessionId('failover-effort-midturn'), {
      provider: 'primary',
      model: 'm',
    })
    const selected: ModelSelectionRef = {
      current: { provider: 'primary', model: 'm', reasoningEffort: ReasoningEffortId('low') },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selected)
    steerAcrossSteps(context, agent, adapter, 2)
    context.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      selected.current = { provider: 'primary', model: 'm', reasoningEffort: ReasoningEffortId('high') }
      return resolved
    })

    prompt(agent, 'go')
    await agent.whenIdle()

    // An effort change is not a route change: it must not restart the chain, so
    // no step of the open turn returns to the route that just failed.
    expect(adapter.requests.map(r => `${r.provider}/${r.model}:${r.reasoningEffort}`))
      .toEqual(['primary/m:low', 'b1/m1:undefined', 'b1/m1:undefined', 'b1/m1:undefined'])
    expect(fallbackEvents(agent)).toHaveLength(1)
  })

  it('defers an externally replaced route to the following turn', async () => {
    let override: { provider: string; model: string } | undefined = undefined
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT'), textResponse('primary again')],
      'b1/m1': [textResponse('backup')],
      'b2/m2': [textResponse('picked')],
    })
    ;({ ctx: context } = await harness(adapter, TWO_BACKUPS, undefined, (ctx) => {
      ctx.on('agent/request', async (_payload, next) => {
        const resolved = await next()
        return override === undefined ? resolved : { ...resolved, ...override }
      })
    }))
    const agent = context.agentLoop.create(SessionId('failover-adopt'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'first')
    await agent.whenIdle()
    override = { provider: 'b2', model: 'm2' }
    prompt(agent, 'second')
    await agent.whenIdle()
    prompt(agent, 'third')
    await agent.whenIdle()

    // Turn 2 adopts b2 into state but still serves the re-asserted primary, so
    // the prompt assembled for that turn cannot disagree with its request.
    // Turn 3 assembles the adopted route and uses it.
    expect(adapter.requests.map(r => `${r.provider}/${r.model}`))
      .toEqual(['primary/m', 'b1/m1', 'primary/m', 'b2/m2'])
    // The rendered prompt (harness()'s `{{provider}}/{{model}}` section) never
    // disagrees with the request it accompanies for a step's FIRST attempt —
    // turn 2 and turn 3 each assemble once, before their request, and the two
    // agree (primary/m, then b2/m2). Turn 1's second entry is a same-step
    // retry after the primary's failure: `AgentLoop.step()` assembles once per
    // step and re-enters its request loop without reassembling, so the prompt
    // committed to "primary/m" at step start stays put even though the retried
    // request correctly reroutes to b1/m1 — a different guarantee than the
    // deferral ruling, which this same assertion also distinguishes.
    expect(adapter.requests.map(r => r.system))
      .toEqual(['primary/m', 'primary/m', 'primary/m', 'b2/m2'])
    expect(fallbackEvents(agent)).toHaveLength(1)
  })
})

describe('boundaries the ordinary loop rarely exercises', () => {
  it('preserves a reasoning effort captured on the primary across a return to it', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT'), textResponse('primary recovered')],
      'b1/m1': [textResponse('backup')],
    })
    // Tags every resolved route with a reasoning effort, as a host or a
    // per-model default would. Registered afterFallback (INNER) so the
    // plugin's own request handler still gets the final say once it has an
    // opinion — it only lets this through for the very first request.
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP, undefined, (ctx) => {
      ctx.on('agent/request', async (_payload, next) => ({
        ...await next(),
        reasoningEffort: ReasoningEffortId('high'),
      }))
    }))
    const agent = context.agentLoop.create(SessionId('failover-reasoning-effort'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'first')
    await agent.whenIdle()
    prompt(agent, 'second')
    await agent.whenIdle()

    expect(adapter.requests.map(r => ({ provider: r.provider, model: r.model, reasoningEffort: r.reasoningEffort })))
      .toEqual([
        { provider: 'primary', model: 'm', reasoningEffort: 'high' },
        { provider: 'b1', model: 'm1', reasoningEffort: undefined },
        { provider: 'primary', model: 'm', reasoningEffort: 'high' },
      ])
  })

  it('re-asserts the primary with the effort a standing selection carries after a turn reset', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT'), textResponse('primary recovered')],
      'b1/m1': [textResponse('backup')],
    })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP))
    const agent = context.agentLoop.create(SessionId('failover-effort-standing-owner'), {
      provider: 'primary',
      model: 'm',
    })
    // A route owner asserting one unchanged selection on every request: the
    // composition where a turn's first delegation differs from the backup this
    // plugin wrote while naming the route the reset returns to.
    installModelSelection(agent.ctx, {
      current: { provider: 'primary', model: 'm', reasoningEffort: ReasoningEffortId('high') },
      assembled: undefined,
    })

    prompt(agent, 'first')
    await agent.whenIdle()
    prompt(agent, 'second')
    await agent.whenIdle()
    // A third turn, because an assembly that promotes a route staged in turn 2
    // is the earliest one that could replace the captured primary — and with it
    // the effort captured alongside the route.
    prompt(agent, 'third')
    await agent.whenIdle()

    // The effort captured with the primary at failover time reaches the request
    // that returns to it, so crossing a turn boundary under a route owner costs
    // the session's effort nothing.
    expect(adapter.requests.map(r => `${r.provider}/${r.model}:${r.reasoningEffort}`))
      .toEqual(['primary/m:high', 'b1/m1:undefined', 'primary/m:high', 'primary/m:high'])
    expect(fallbackEvents(agent)).toHaveLength(1)
  })

  it('leaves the assembly untouched for a context with no agent', async () => {
    const adapter = new RouteAdapter({ 'primary/m': [textResponse('unused')] })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP))

    // system-prompt/assemble can run for a context with no agent (its
    // AssembleContext.agent defaults to undefined); the plugin has no cursor
    // to apply and must leave the assembly untouched rather than throw.
    await expect(context.systemPrompt.assemble()).resolves.toBeDefined()
  })

  it('leaves an already-aborted signal to a downstream policy without moving the cursor', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT')],
      'b1/m1': [textResponse('must not run')],
    })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP, (ctx) => {
      ctx.on('agent/request-error', async ({ agent }, next): Promise<RequestErrorAction> => {
        agent.cancel({ kind: 'user' })
        return next()
      })
    }))
    const agent = context.agentLoop.create(SessionId('failover-aborted-signal'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(fallbackEvents(agent)).toHaveLength(0)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('leaves a failure to a downstream policy when no request header exists yet', async () => {
    const adapter = new RouteAdapter({ 'primary/m': [textResponse('unused')] })
    ;({ ctx: context } = await harness(adapter, ONE_BACKUP))
    // Never prompted: no `request/header` has ever been logged for this agent,
    // so the durable route `loggedRoute()` reads back is `undefined`.
    const agent = context.agentLoop.create(SessionId('failover-no-header'), {
      provider: 'primary',
      model: 'm',
    })

    const outcome = await context.waterfall(
      'agent/request-error',
      {
        agent,
        turn: 1,
        step: 1,
        provider: 'primary',
        failure: { message: 'limited', code: 'RATE_LIMIT' },
        retryPolicy: undefined,
        signal: new AbortController().signal,
      },
      () => Promise.resolve(undefined),
    )

    expect(outcome).toBeUndefined()
    expect(fallbackEvents(agent)).toHaveLength(0)
  })
})
