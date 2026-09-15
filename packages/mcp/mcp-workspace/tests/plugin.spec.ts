import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as plugin from '../src/index.ts'
import { fingerprintEntry } from '../src/mcp-json.ts'
import { TrustStore } from '../src/trust-store.ts'

const echoPath = fileURLToPath(new URL('./fixtures/echo-server.ts', import.meta.url))
const ECHO = 'mcp__fixture__echo'
const TOKEN_TOOL = 'mcp__fixture__token'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

interface Harness {
  readonly ctx: Context
  readonly workspace: string
  readonly trustFile: string
  readonly pidDir: string
}

async function harness(): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mcp-plugin-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const pidDir = join(root, 'pids')
  await mkdir(workspace)
  await mkdir(pidDir)
  cleanups.push(() => killLeftovers(pidDir))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(MemoryCredentials, { TOKEN: 'token-value' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
  return { ctx, workspace, trustFile: join(root, 'home', 'mcp-trust.yaml'), pidDir }
}

/** Declare one server in `workspace/.mcp.json` and record `allow` for it. */
async function allowServer(trustFile: string, workspace: string, entry: Record<string, unknown>): Promise<void> {
  await writeFile(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: entry } }))
  await new TrustStore(trustFile).record(workspace, [{ serverName: 'fixture', decision: 'allow', fingerprint: fingerprintEntry(entry) }], new Date())
}

async function createAgent(ctx: Context, id: string, cwd: string): Promise<Agent> {
  return (await ctx.agents.create({
    sessionId: SessionId(id),
    meta: { cwd },
    agentOptions: { provider: 'mock', model: 'mock' },
  })).agent
}

async function runTurn(ctx: Context, agent: Agent): Promise<void> {
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

async function pids(dir: string): Promise<number[]> {
  return (await readdir(dir)).map(Number)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    // ESRCH: the process no longer exists.
    return false
  }
  return true
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
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

describe('mcp-workspace plugin', () => {
  it('has the Loader-safe function-plugin export form', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('mcp-workspace')
    expect(plugin.inject).toEqual(['agents', 'credentials'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(plugin)).toBe(plugin)
  })

  it('rejects a timeout above the longest timer delay', () => {
    const trustFile = '/home/user/.dsh/mcp-trust.yaml'
    expect(() => plugin.Config({ trustFile, admissionTimeoutMs: 2_147_483_648 } as never)).toThrow()
    expect(() => plugin.Config({ trustFile, toolCallTimeoutMs: 2_147_483_648 } as never)).toThrow()
    expect(plugin.Config({ trustFile, admissionTimeoutMs: 2_147_483_647, toolCallTimeoutMs: 2_147_483_647 }))
      .toMatchObject({ admissionTimeoutMs: 2_147_483_647, toolCallTimeoutMs: 2_147_483_647 })
  })

  it('requires trustFile and defaults every other field', () => {
    expect(() => plugin.Config({} as never)).toThrow()
    expect(plugin.Config({ trustFile: '/home/user/.dsh/mcp-trust.yaml' } as never)).toMatchObject({
      trustFile: '/home/user/.dsh/mcp-trust.yaml',
      admissionTimeoutMs: 10_000,
      toolCallTimeoutMs: 60_000,
    })
  })

  it('rejects a reconnect policy outside the mcp-client bounds at load', () => {
    const ctx = new Context()
    expect(() => {
      plugin.apply(ctx, { trustFile: '/home/user/.dsh/mcp-trust.yaml', admissionTimeoutMs: 0, toolCallTimeoutMs: 1, reconnect: { initialDelayMs: 0 } })
    }).toThrow()
  })

  it('mounts a saved-allow server before the first request and unmounts it on plugin disposal', async () => {
    const { ctx, workspace, trustFile, pidDir } = await harness()
    await allowServer(trustFile, workspace, {
      command: process.execPath,
      args: [echoPath],
      env: { MCP_FIXTURE_PID_DIR: pidDir, MCP_FIXTURE_EXPECT_TOKEN: '${TOKEN}', MCP_FIXTURE_TOKEN: '${TOKEN}' },
    })
    const fiber = ctx.plugin(plugin, { trustFile, admissionTimeoutMs: 10_000, toolCallTimeoutMs: 60_000, reconnect: { enabled: false } })
    await fiber

    const agent = await createAgent(ctx, 'plugin-first-step', workspace)
    await runTurn(ctx, agent)
    const header = agent.session.snapshotEvents().find(event => event.type === 'request/header')
    expect(header?.type === 'request/header' && header.data.header.tools?.map(tool => tool.name)).toEqual([ECHO, TOKEN_TOOL])
    const [pid] = await pids(pidDir) as [number]

    await fiber.dispose()
    await until(() => ctx.tools.get(ECHO, agent) === undefined)
    await until(() => !isAlive(pid))
  })
})
