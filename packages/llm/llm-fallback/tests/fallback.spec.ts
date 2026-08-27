import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
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
}

async function harness(
  adapter: RouteAdapter,
  config: Config,
  beforeFallback?: (ctx: Context) => void,
  afterFallback?: (ctx: Context) => void,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  beforeFallback?.(ctx)
  await ctx.plugin(Object.assign((inner: Context) => {
    fallback.apply(inner, config)
  }, { inject: fallback.inject }))
  afterFallback?.(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['primary', 'b1', 'b2'], adapter)
  return ctx
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
    context = await harness(adapter, ONE_BACKUP)
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
    context = await harness(adapter, ONE_BACKUP)
    const agent = context.agentLoop.create(SessionId('failover-auth'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(fallbackEvents(agent)).toHaveLength(1)
  })

  it('leaves a code it does not own to a downstream policy', async () => {
    let reached = 0
    const adapter = new RouteAdapter({
      'primary/m': [failure('CONTEXT_WINDOW_EXCEEDED', 'too long')],
    })
    context = await harness(adapter, ONE_BACKUP, (ctx) => {
      ctx.on('agent/request-error', (_payload, next): Promise<RequestErrorAction> => {
        reached += 1
        return next()
      })
    })
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
    context = await harness(adapter, TWO_BACKUPS)
    const agent = context.agentLoop.create(SessionId('failover-exhausted'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'go')
    await agent.whenIdle()

    expect(fallbackEvents(agent).map(event => event.data.cursor)).toEqual([1, 2])
    expect(adapter.requests.map(r => r.provider)).toEqual(['primary', 'b1', 'b2'])
  })

  it('returns to the primary on the next user turn', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT'), textResponse('primary recovered')],
      'b1/m1': [textResponse('backup')],
    })
    context = await harness(adapter, ONE_BACKUP)
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

  it('prefers a downstream retry over failover', async () => {
    let retried = false
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT'), textResponse('primary recovered')],
      'b1/m1': [textResponse('backup')],
    })
    context = await harness(adapter, ONE_BACKUP, (ctx) => {
      ctx.on('agent/request-error', async (_payload, next): Promise<RequestErrorAction> => {
        if (retried) return next()
        retried = true
        return { kind: 'retry' }
      })
    })
    const agent = context.agentLoop.create(SessionId('failover-retry-wins'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests.map(r => r.provider)).toEqual(['primary', 'primary'])
    expect(fallbackEvents(agent)).toHaveLength(0)
  })

  it('stops failing over once its listeners are disposed', async () => {
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT')],
      'b1/m1': [textResponse('backup')],
    })
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      fallback.apply(inner, ONE_BACKUP)
    }, { inject: fallback.inject }))
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['primary', 'b1'], adapter)
    await fiber.dispose()

    const agent = ctx.agentLoop.create(SessionId('failover-disposed'), {
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
    context = await harness(adapter, ONE_BACKUP, (ctx) => {
      ctx.on('agent/request-error', async ({ agent }, next): Promise<RequestErrorAction> => {
        // Steer into the open turn's next step, before the failover decision is taken.
        if (adapter.requests.length === 1) {
          agent.steer(createUserMessage({ content: [{ type: 'text', text: 'steer' }], source: { kind: 'user' } }))
        }
        return next()
      })
    })
    const agent = context.agentLoop.create(SessionId('failover-steering'), {
      provider: 'primary',
      model: 'm',
    })

    prompt(agent, 'go')
    await agent.whenIdle()

    // The primary is requested once, at the start of the turn. Steering must not
    // reset the cursor back to it, so every later request stays on the backup.
    expect(adapter.requests.map(r => r.provider)).toEqual(['primary', 'b1', 'b1'])
  })

  it('defers an externally replaced route to the following turn', async () => {
    // oxlint-disable-next-line prefer-const -- reassigned below; a whole-file scope quirk misreports it as never reassigned
    let override: { provider: string; model: string } | undefined
    const adapter = new RouteAdapter({
      'primary/m': [failure('RATE_LIMIT'), textResponse('primary again')],
      'b1/m1': [textResponse('backup')],
      'b2/m2': [textResponse('picked')],
    })
    context = await harness(adapter, TWO_BACKUPS, undefined, (ctx) => {
      ctx.on('agent/request', async (_payload, next) => {
        const resolved = await next()
        return override === undefined ? resolved : { ...resolved, ...override }
      })
    })
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
    expect(fallbackEvents(agent)).toHaveLength(1)
  })
})
