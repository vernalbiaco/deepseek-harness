import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { resolveReconnectPolicy } from '@deepseek-ai/dsh-mcp-client'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { activePools } from '../src/active-pools.ts'
import * as companion from '../src/invariant.ts'
import { WorkspacePool } from '../src/pool.ts'
import type { ServerLease } from '../src/pool.ts'
import type { DeclaredServer } from '../src/types.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/echo-server.ts', import.meta.url))
const ECHO = 'mcp__fixture__echo'
const HEADER = { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' } as unknown as SessionEventMap['request/header']

class PersistenceProbe extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

interface Harness {
  readonly ctx: Context
  readonly pool: WorkspacePool
  readonly root: string
  readonly workspace: string
  readonly pidDir: string
}

async function harness(): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mcp-invariant-')))
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
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(companion)
  const pool = new WorkspacePool(ctx, {
    toolCallTimeoutMs: 15_000,
    reconnect: resolveReconnectPolicy({ enabled: false }, 'test.reconnect'),
    resolveCredential: async () => undefined,
  })
  cleanups.push(() => pool.dispose())
  activePools().set(ctx.root, pool)
  cleanups.push(async () => { activePools().delete(ctx.root) })
  return { ctx, pool, root, workspace, pidDir }
}

function fixtureServer(pidDir: string): DeclaredServer {
  return {
    name: 'fixture',
    fingerprint: 'sha256:one',
    credentialRefs: [],
    entry: { transport: 'stdio', command: process.execPath, args: [fixturePath], env: { MCP_FIXTURE_PID_DIR: pidDir } },
  }
}

async function create(ctx: Context, id: string, cwd?: string): Promise<AgentHandle> {
  return await ctx.agents.create({
    sessionId: SessionId(id),
    ...cwd === undefined ? {} : { meta: { cwd } },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
}

async function readyLease(pool: WorkspacePool, workspace: string, pidDir: string): Promise<ServerLease> {
  const lease = pool.acquire(workspace, fixtureServer(pidDir))
  await lease.ready
  return lease
}

async function killLeftovers(dir: string): Promise<void> {
  for (const pid of (await readdir(dir)).map(Number)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // ESRCH: the child already exited.
    }
  }
}

describe('mcp-workspace invariant companion', () => {
  it('accepts attachments of live agents in their canonical workspace', async () => {
    const { ctx, pool, workspace, pidDir } = await harness()
    const { agent } = await create(ctx, 'invariant-valid', workspace)
    const lease = await readyLease(pool, workspace, pidDir)
    lease.attach(agent.ctx)
    expect(ctx.tools.get(ECHO, agent)).toBeDefined()

    expect(() => { agent.session.append('turn/start', { turn: 1 }) }).not.toThrow()
    expect(() => { agent.session.append('request/header', HEADER) }).not.toThrow()
  })

  it('stays silent without a mounted pool', async () => {
    const { ctx, pool, root, pidDir } = await harness()
    activePools().delete(ctx.root)
    const { agent } = await create(ctx, 'invariant-no-pool', root)
    const lease = await readyLease(pool, join(root, 'workspace'), pidDir)
    lease.attach(agent.ctx)

    expect(() => { agent.session.append('request/header', HEADER) }).not.toThrow()
  })

  it('rejects an attachment whose agent cwd is another directory', async () => {
    const { ctx, pool, root, workspace, pidDir } = await harness()
    const { agent } = await create(ctx, 'invariant-other-cwd', root)
    const lease = await readyLease(pool, workspace, pidDir)
    lease.attach(agent.ctx)

    expect(() => { agent.session.append('request/header', HEADER) })
      .toThrow(new RegExp(`agent invariant-other-cwd with cwd ${root} is attached to workspace ${workspace}`))
    expect(() => { agent.session.append('request/header', HEADER) }).toThrow(InvariantError)
  })

  it('rejects an attachment whose agent has no cwd', async () => {
    const { ctx, pool, workspace, pidDir } = await harness()
    const { agent } = await create(ctx, 'invariant-no-cwd')
    const lease = await readyLease(pool, workspace, pidDir)
    lease.attach(agent.ctx)

    expect(() => { agent.session.append('request/header', HEADER) }).toThrow(/with cwd undefined is attached/)
  })

  it('does not compare a cwd that was removed after attachment', async () => {
    const { ctx, pool, workspace, pidDir } = await harness()
    const nested = join(workspace, 'nested')
    await mkdir(nested)
    const { agent } = await create(ctx, 'invariant-removed-cwd', nested)
    const lease = await readyLease(pool, nested, pidDir)
    lease.attach(agent.ctx)
    await rm(nested, { recursive: true })

    expect(() => { agent.session.append('request/header', HEADER) }).not.toThrow()
  })

  it('rejects a registration withdrawn without detaching through the pool', async () => {
    const { ctx, pool, workspace, pidDir } = await harness()
    const { agent } = await create(ctx, 'invariant-bypass', workspace)
    const lease = await readyLease(pool, workspace, pidDir)
    const child = await agent.ctx.plugin((childCtx: Context) => { lease.attach(childCtx) })
    expect(ctx.tools.get(ECHO, agent)).toBeDefined()
    await child.dispose()
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()

    expect(() => { agent.session.append('request/header', HEADER) })
      .toThrow(/tool mcp__fixture__echo registered for agent invariant-bypass does not resolve/)
  })

  it('rejects an attachment that belongs to no live agent', async () => {
    const { ctx, pool, workspace, pidDir } = await harness()
    const observer = await create(ctx, 'invariant-observer', workspace)
    const departed = await create(ctx, 'invariant-departed', workspace)
    const lease = await readyLease(pool, workspace, pidDir)
    lease.attach(departed.agent.ctx)
    await departed.dispose()

    expect(() => { observer.agent.session.append('request/header', HEADER) })
      .toThrow(new RegExp(`attachment in ${workspace} belongs to no live agent`))
  })

  it('rejects an attachment to a context outside every agent', async () => {
    const { ctx, pool, workspace, pidDir } = await harness()
    const observer = await create(ctx, 'invariant-global', workspace)
    const lease = await readyLease(pool, workspace, pidDir)
    lease.attach(ctx)

    expect(() => { observer.agent.session.append('request/header', HEADER) }).toThrow(/belongs to no live agent/)
  })
})
