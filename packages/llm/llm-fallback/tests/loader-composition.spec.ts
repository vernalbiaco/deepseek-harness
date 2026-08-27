import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as LlmFallback from '../src/index.ts'

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

describe('real Loader composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('activates dsh-llm-retry and dsh-llm-fallback mounted together with two backups', { timeout: 60_000 }, async () => {
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

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
  })

  it('fails load with an empty backups list', { timeout: 60_000 }, async () => {
    await expect(loadYaml([
      ...MOUNT_PREFIX,
      "- name: '@deepseek-ai/dsh-llm-fallback'",
      '  config:',
      '    backups: []',
    ])).rejects.toThrow('llm-fallback: backups must list at least one route')
  })

  it('fails load with a duplicate backup route', { timeout: 60_000 }, async () => {
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

  it('fails load with an unknown config key', { timeout: 60_000 }, async () => {
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
