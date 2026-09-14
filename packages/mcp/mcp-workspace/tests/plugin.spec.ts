import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as plugin from '../src/index.ts'
import { activePools } from '../src/active-pools.ts'
import { fingerprintEntry } from '../src/mcp-json.ts'
import { TrustStore } from '../src/trust-store.ts'

const echoPath = fileURLToPath(new URL('./fixtures/echo-server.ts', import.meta.url))
const silentPath = fileURLToPath(new URL('./fixtures/silent-server.ts', import.meta.url))
const ECHO = 'mcp__fixture__echo'

class PersistenceProbe extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }
}

/** Minimal `workspaceRegistry` providing only `list()`. */
class WorkspaceRegistryStub extends Service {
  private readonly paths: readonly string[]

  constructor(ctx: Context, config: { paths: readonly string[] }) {
    super(ctx, 'workspaceRegistry')
    this.paths = config.paths
  }

  list(): Array<{ path: string }> {
    return this.paths.map(path => ({ path }))
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
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
  await ctx.plugin(PersistenceProbe)
  ctx.on('session/flush', () => {})
  await ctx.plugin(MemoryCredentials, { TOKEN: 'token-value' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
  return { ctx, workspace, trustFile: join(root, 'home', 'mcp-trust.yaml'), pidDir }
}

/** A complete plugin config with the schema defaults; the export-form test asserts they match {@link plugin.Config}. */
function config(overrides: Partial<plugin.Config> & Pick<plugin.Config, 'trustFile'>): plugin.Config {
  return { preconnect: true, preconnectTimeoutMs: 10_000, toolCallTimeoutMs: 60_000, ...overrides }
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
    expect(plugin.inject).toEqual(['agents', 'tools', 'credentials'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(plugin)).toBe(plugin)
  })

  it('requires trustFile and defaults every other field', () => {
    expect(() => plugin.Config({} as never)).toThrow()
    const resolved = plugin.Config({ trustFile: '/home/user/.dsh/mcp-trust.yaml' } as never)
    expect(resolved).toMatchObject({
      trustFile: '/home/user/.dsh/mcp-trust.yaml',
      preconnect: true,
      preconnectTimeoutMs: 10_000,
      toolCallTimeoutMs: 60_000,
    })
    expect(resolved).toMatchObject(config({ trustFile: '/home/user/.dsh/mcp-trust.yaml' }))
  })

  it('preconnects the process cwd, attaches from the first step, and unwinds on disposal', async () => {
    const { ctx, workspace, trustFile, pidDir } = await harness()
    await allowServer(trustFile, workspace, {
      command: process.execPath,
      args: [echoPath],
      env: { MCP_FIXTURE_PID_DIR: pidDir, MCP_FIXTURE_TOKEN: '${TOKEN}' },
    })
    vi.spyOn(process, 'cwd').mockReturnValue(workspace)

    const fiber = await ctx.plugin(plugin, config({ trustFile }))
    const [pid] = await pids(pidDir)
    expect(activePools().get(ctx.root)).toBeDefined()
    const agent = await createAgent(ctx, 'plugin-hmr', workspace)
    const idle = new Promise<void>((resolve) => {
      const stop = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') {
          stop()
          resolve()
        }
      })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle
    const header = agent.session.events.find(event => event.type === 'request/header')
    expect(header?.type === 'request/header' && header.data.header.tools?.map(tool => tool.name)).toEqual([ECHO])

    await fiber.dispose()

    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    expect(activePools().get(ctx.root)).toBeUndefined()
    await until(() => !isAlive(pid!))
    const later = await createAgent(ctx, 'plugin-hmr-later', workspace)
    expect(ctx.tools.get(ECHO, later)).toBeUndefined()
  })

  it('stops waiting for preconnect after preconnectTimeoutMs', async () => {
    const { ctx, workspace, trustFile, pidDir } = await harness()
    await allowServer(trustFile, workspace, { command: process.execPath, args: [silentPath], env: { MCP_FIXTURE_PID_DIR: pidDir } })
    vi.spyOn(process, 'cwd').mockReturnValue(workspace)

    const started = performance.now()
    const fiber = await ctx.plugin(plugin, config({ trustFile, preconnectTimeoutMs: 300 }))
    const elapsed = performance.now() - started

    expect(elapsed).toBeGreaterThanOrEqual(290)
    expect(elapsed).toBeLessThan(2_300)
    const [pid] = await pids(pidDir)
    expect(isAlive(pid!)).toBe(true)
    await fiber.dispose()
    await until(() => !isAlive(pid!))
  })

  it('settles fiber disposal requested while activation awaits a connecting server', async () => {
    const { ctx, workspace, trustFile, pidDir } = await harness()
    await allowServer(trustFile, workspace, { command: process.execPath, args: [echoPath], env: { MCP_FIXTURE_PID_DIR: pidDir } })
    vi.spyOn(process, 'cwd').mockReturnValue(workspace)

    const fiber = ctx.plugin(plugin, config({ trustFile }))
    await until(async () => (await pids(pidDir)).length === 1)
    const [pid] = await pids(pidDir)
    const started = performance.now()
    await fiber.dispose()

    expect(performance.now() - started).toBeLessThan(5_000)
    expect(activePools().get(ctx.root)).toBeUndefined()
    await until(() => !isAlive(pid!))
  }, 15_000)

  it('settles fiber disposal requested while activation awaits a silent server within preconnectTimeoutMs', async () => {
    const { ctx, workspace, trustFile, pidDir } = await harness()
    await allowServer(trustFile, workspace, { command: process.execPath, args: [silentPath], env: { MCP_FIXTURE_PID_DIR: pidDir } })
    vi.spyOn(process, 'cwd').mockReturnValue(workspace)

    const fiber = ctx.plugin(plugin, config({ trustFile, preconnectTimeoutMs: 1_000 }))
    await until(async () => (await pids(pidDir)).length === 1)
    const [pid] = await pids(pidDir)
    const started = performance.now()
    await fiber.dispose()

    expect(performance.now() - started).toBeLessThan(1_000 + 5_000)
    await until(() => !isAlive(pid!))
  }, 15_000)

  it('connects nothing at activation without preconnect', async () => {
    const { ctx, workspace, trustFile, pidDir } = await harness()
    await allowServer(trustFile, workspace, { command: process.execPath, args: [echoPath], env: { MCP_FIXTURE_PID_DIR: pidDir } })
    vi.spyOn(process, 'cwd').mockReturnValue(workspace)
    await ctx.plugin(WorkspaceRegistryStub, { paths: [workspace] })

    await ctx.plugin(plugin, config({ trustFile, preconnect: false }))
    await sleep(200)

    expect(await pids(pidDir)).toEqual([])
  })

  it('preconnects the workspaces of a registry that appears after activation', async () => {
    const { ctx, workspace, trustFile, pidDir } = await harness()
    await allowServer(trustFile, workspace, { command: process.execPath, args: [echoPath], env: { MCP_FIXTURE_PID_DIR: pidDir } })
    const empty = join(workspace, '..', 'pids')
    vi.spyOn(process, 'cwd').mockReturnValue(empty)

    await ctx.plugin(plugin, config({ trustFile }))
    expect(await pids(pidDir)).toEqual([])
    await ctx.plugin(WorkspaceRegistryStub, { paths: [workspace] })

    await until(async () => (await pids(pidDir)).length === 1)
  })
})
