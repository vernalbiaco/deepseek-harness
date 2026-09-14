/**
 * Shared Loader composition for the mcp-workspace composition and end-to-end
 * tests. Each boot owns a temporary root holding the Harness home, a workspace
 * whose `.mcp.json` declares the echo fixture server with a saved `allow`, and
 * the fixture's pid directory. {@link disposeCompositions} disposes the
 * context, kills any fixture child still alive, restores `DSH_HOME`, and
 * removes the root.
 */

import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { boot, loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { decodeStorageRecord, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as McpWorkspace from '../src/index.ts'
import { fingerprintEntry } from '../src/mcp-json.ts'
import { TrustStore } from '../src/trust-store.ts'

const BIN = 'mcp-workspace-composition-test'
const configPath = fileURLToPath(new URL('./fixtures/composition.cordis.yml', import.meta.url))
const echoServer = fileURLToPath(new URL('./fixtures/echo-server.ts', import.meta.url))

/** Public name of the echo fixture's `echo` tool. */
export const ECHO = 'mcp__fixture__echo'
/** Public name of the echo fixture's `token` tool. */
export const TOKEN_TOOL = 'mcp__fixture__token'

/** One composition's setup. */
export interface CompositionOptions {
  /** `process.cwd()` during activation: the workspace, which preconnect then covers, or a directory without `.mcp.json`. */
  readonly activationCwd: 'workspace' | 'outside'
  /** Scripted model responses in request order. */
  readonly script: StreamChunk[][]
  /** `env` of the declared fixture server, added to its pid directory variable. */
  readonly serverEnv?: Record<string, string>
  /** Variables written to `$DSH_HOME/.env`. */
  readonly homeEnv?: Record<string, string>
}

/** A booted composition. */
export interface Composition {
  readonly ctx: Context
  /** Canonical workspace path declaring the `fixture` server. */
  readonly workspace: string
  /** Directory receiving one file per started fixture child, named by pid. */
  readonly pidDir: string
}

const cleanups: Array<() => Promise<void>> = []

/** Run every registered cleanup, newest first; register as `afterEach`. */
export async function disposeCompositions(): Promise<void> {
  while (cleanups.length > 0) await cleanups.pop()!()
}

/**
 * Boot `fixtures/composition.cordis.yml` against a fresh temporary Harness home and workspace.
 * @param options - activation cwd, model script, server env, and Harness-home `.env` values.
 * @returns the settled root context with the workspace and pid directory.
 */
export async function bootComposition(options: CompositionOptions): Promise<Composition> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mcp-composition-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  const pidDir = join(root, 'pids')
  for (const dir of [home, workspace, outside, pidDir]) await mkdir(dir)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  cleanups.push(async () => { restoreEnv('DSH_HOME', previousHome) })
  cleanups.push(() => killLeftovers(pidDir))

  const entry = { command: process.execPath, args: [echoServer], env: { MCP_FIXTURE_PID_DIR: pidDir, ...options.serverEnv } }
  await writeFile(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: entry } }))
  await new TrustStore(join(home, 'mcp-trust.yaml'))
    .record(workspace, [{ serverName: 'fixture', decision: 'allow', fingerprint: fingerprintEntry(entry) }], new Date())
  await writeFile(join(home, '.env'), Object.entries(options.homeEnv ?? {}).map(([name, value]) => `${name}=${value}\n`).join(''))
  const environment = loadIsolatedEnvironment(workspace)

  const scriptedModel = {
    name: 'mcp-workspace-test-scripted-model',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.registerAdapter(['mock'], new MockAdapter(options.script))
    },
  }
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(options.activationCwd === 'workspace' ? workspace : outside)
  try {
    const ctx = await boot(BIN, configPath, [], (bootCtx) => {
      cleanups.push(() => bootCtx.fiber.dispose())
      bootCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      Object.assign(bootCtx.loader.builtins, {
        'mcp-workspace-test-llm': LlmRuntime,
        'mcp-workspace-test-session': SessionStore,
        'mcp-workspace-test-system-prompt': SystemPrompt,
        'mcp-workspace-test-tools': ToolRuntime,
        'mcp-workspace-test-agent': AgentRegistry,
        'mcp-workspace-test-agent-loop': AgentLoop,
        'mcp-workspace-test-session-persistence-jsonl': JsonlSessionPersistence,
        'mcp-workspace-test-credentials': LocalCredentialProvider,
        'mcp-workspace-test-user-questions': UserQuestionService,
        'mcp-workspace-test-scripted-model': scriptedModel,
        'mcp-workspace-test-mcp-workspace': McpWorkspace,
      })
    })
    return { ctx, workspace, pidDir }
  } finally {
    cwd.mockRestore()
  }
}

/**
 * The product CLI's layered launch environment for `cwd`, with every variable
 * `loadLayeredEnv` added to `process.env` removed again, so `.env` values reach
 * the composition only through the snapshot.
 * @param cwd - the directory whose `.env` is the project layer.
 * @returns the launch environment snapshot.
 */
function loadIsolatedEnvironment(cwd: string): LaunchEnvironmentSnapshot {
  const inherited = new Set(Object.keys(process.env))
  const snapshot = loadLayeredEnv(BIN, cwd)
  for (const name of Object.keys(process.env)) {
    if (!inherited.has(name)) Reflect.deleteProperty(process.env, name)
  }
  return snapshot
}

/**
 * Create a root agent on the scripted model.
 * @param ctx - the composition context.
 * @param id - the session id.
 * @param cwd - the session cwd.
 * @returns the owned agent handle.
 */
export async function createAgent(ctx: Context, id: string, cwd: string): Promise<AgentHandle> {
  return await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd }, agentOptions: { provider: 'mock', model: 'mock' } })
}

/**
 * Send one user prompt and wait until the agent is idle again.
 * @param ctx - the composition context.
 * @param agent - the agent to prompt.
 */
export async function runTurn(ctx: Context, agent: Agent): Promise<void> {
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await idle
}

/**
 * Flush an agent's session and read its events back from the JSONL log under `$DSH_HOME/sessions`.
 * @param ctx - the composition context.
 * @param agent - the agent whose session log to read.
 * @returns the persisted events in log order.
 */
export async function durableEvents(ctx: Context, agent: Agent): Promise<SessionEvent[]> {
  await ctx.sessions.flush(agent.session)
  const root = join(process.env.DSH_HOME!, 'sessions')
  for (const file of await readdir(root, { recursive: true })) {
    if (basename(file) !== 'session.jsonl') continue
    const [header, ...records] = (await readFile(join(root, file), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as unknown)
    if ((header as { id?: unknown }).id === agent.id) return records.flatMap(record => decodeStorageRecord(record))
  }
  throw new Error(`no session log for ${agent.id} under ${root}`)
}

/**
 * @param events - session events.
 * @returns each `request/header` event's reason and tool names.
 */
export function requestHeaders(events: readonly SessionEvent[]): Array<{ reason: string; tools: string[] }> {
  return events.flatMap(event => event.type === 'request/header'
    ? [{ reason: event.data.reason, tools: (event.data.header.tools ?? []).map(tool => tool.name) }]
    : [])
}

/**
 * @param events - session events.
 * @returns the text blocks of every `tool/result` event, joined per result.
 */
export function toolResultTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'tool/result'
    ? [event.data.message.content[0].content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')]
    : [])
}

/**
 * @param dir - a fixture pid directory.
 * @returns the pids of every fixture child started with that directory.
 */
export async function pids(dir: string): Promise<number[]> {
  return (await readdir(dir)).map(Number)
}

/**
 * @param pid - a process id.
 * @returns whether the process exists.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    // ESRCH: the process no longer exists.
    return false
  }
  return true
}

/**
 * Poll until a condition holds.
 * @param condition - the condition to poll.
 * @param timeoutMs - longest wait before throwing.
 */
export async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`)
    await sleep(25)
  }
}

async function killLeftovers(dir: string): Promise<void> {
  for (const pid of await pids(dir)) {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL')
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else process.env[name] = value
}
