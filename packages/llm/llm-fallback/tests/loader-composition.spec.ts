import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as LlmFallback from '../src/index.ts'

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

/**
 * Serves a scripted response queue per `provider/model` route. A minimal
 * local copy of `tests/fallback.spec.ts`'s `RouteAdapter` rather than a
 * cross-file import: that file is being edited by a concurrent fix round.
 */
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
      throw new Error(`loader-composition test script exhausted for route "${key}"`)
    }
    yield* queue.length === 1 ? queue[0]! : queue.shift()!
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-fallback-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-llm-retry', LlmRetry],
    ['@deepseek-ai/dsh-llm-fallback', LlmFallback],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

const MOUNT_PREFIX: readonly string[] = [
  "- name: '@deepseek-ai/dsh-llm'",
  "- name: '@deepseek-ai/dsh-session'",
  "- name: '@deepseek-ai/dsh-system-prompt'",
  "- name: '@deepseek-ai/dsh-tools'",
  "- name: '@deepseek-ai/dsh-agent'",
]

/**
 * Find one mounted Loader entry by plugin name.
 * @param loaded - the context returned by {@link loadYaml}.
 * @param name - the plugin name as written in the composition.
 * @returns the entry, which must exist.
 */
function entryFor(loaded: Context, name: string) {
  const entry = [...loaded.loader.entries()].find(candidate => candidate.options.name === name)
  if (entry === undefined) throw new Error(`loader entry "${name}" not mounted`)
  return entry
}

describe('real Loader composition', () => {
  it('mounts dsh-llm-retry and dsh-llm-fallback through the real Loader and fails over to the resolved chain', async () => {
    const loaded = await loadYaml([
      ...MOUNT_PREFIX,
      "- name: '@deepseek-ai/dsh-llm-retry'",
      "- name: '@deepseek-ai/dsh-llm-fallback'",
      '  config:',
      '    backups:',
      '      - provider: b1',
      '        model: m1',
      '      - provider: b2',
      '        model: m2',
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])

    const names = [...loaded.loader.entries()].map(entry => entry.options.name)
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(names).toContain('@deepseek-ai/dsh-llm-retry')
    expect(names).toContain('@deepseek-ai/dsh-llm-fallback')
    // `unloaded` reads `entry.fiber === undefined`, which a fiber left PENDING
    // on an unsatisfied `inject` does not match. Assert the state directly so
    // this composition cannot pass with the plugin waiting for `agents`.
    expect(entryFor(loaded, '@deepseek-ai/dsh-llm-fallback').fiber?.state)
      .toBe(FiberState.ACTIVE)

    // `unloaded`/`names` are Loader bookkeeping: they hold even if `apply()`
    // called `resolveConfig()` and then registered no listeners, silently
    // discarding the parsed `backups`. Only driving a real failure through
    // the config parsed from this YAML — via schemastery normalization, the
    // real Loader, and `apply()` — proves the chain it resolved is live.
    // AUTH is outside dsh-llm-retry's default retryable codes but inside
    // dsh-llm-fallback's default failover codes, so it delegates straight
    // to failover with no same-route retry delay.
    const adapter = new RouteAdapter({
      'primary/p': [failure('AUTH', 'bad key')],
      'b1/m1': [textResponse('served by the backup')],
    })
    loaded.llm.registerAdapter(['primary', 'b1', 'b2'], adapter)
    const agent = loaded.agentLoop.create(SessionId('loader-fallback'), {
      provider: 'primary',
      model: 'p',
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'go' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(adapter.requests.map(r => `${r.provider}/${r.model}`)).toEqual(['primary/p', 'b1/m1'])
    const fallbackEvents = agent.session.events.filter(
      (event): event is SessionEvent<'llm/fallback'> => event.type === 'llm/fallback',
    )
    expect(fallbackEvents).toHaveLength(1)
    expect(fallbackEvents[0]!.data.to).toEqual({ provider: 'b1', model: 'm1' })
  })

  it('fails load with an empty backups list', async () => {
    await expect(loadYaml([
      ...MOUNT_PREFIX,
      "- name: '@deepseek-ai/dsh-llm-fallback'",
      '  config:',
      '    backups: []',
    ])).rejects.toThrow('llm-fallback: backups must list at least one route')
  })

  it('fails load with a duplicate backup route', async () => {
    await expect(loadYaml([
      ...MOUNT_PREFIX,
      "- name: '@deepseek-ai/dsh-llm-fallback'",
      '  config:',
      '    backups:',
      '      - provider: b1',
      '        model: m1',
      '      - provider: b1',
      '        model: m1',
    ])).rejects.toThrow('llm-fallback: duplicate backup route "b1/m1"')
  })

  it('fails load with a backups value that is not a list', async () => {
    await expect(loadYaml([
      ...MOUNT_PREFIX,
      "- name: '@deepseek-ai/dsh-llm-fallback'",
      '  config:',
      '    backups: notanarray',
    ])).rejects.toThrow(/\$\.backups expected array but got notanarray/)
  })

  it('fails load with no config block, naming the missing backups field', async () => {
    await expect(loadYaml([
      ...MOUNT_PREFIX,
      "- name: '@deepseek-ai/dsh-llm-fallback'",
    ])).rejects.toThrow(/\$\.backups missing required value/)
  })

  it('waits for the agents service instead of applying without it', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-llm-fallback'",
      '  config:',
      '    backups:',
      '      - provider: b1',
      '        model: m1',
    ])
    expect(entryFor(loaded, '@deepseek-ai/dsh-llm-fallback').fiber?.state)
      .toBe(FiberState.PENDING)
  })

  it('fails load with an unknown config key', async () => {
    await expect(loadYaml([
      ...MOUNT_PREFIX,
      "- name: '@deepseek-ai/dsh-llm-fallback'",
      '  config:',
      '    backups:',
      '      - provider: b1',
      '        model: m1',
      '    nope: 1',
    ])).rejects.toThrow('llm-fallback: unknown key "nope"')
  })
})
