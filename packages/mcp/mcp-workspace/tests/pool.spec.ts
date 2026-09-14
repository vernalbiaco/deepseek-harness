import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { resolveReconnectPolicy } from '@deepseek-ai/dsh-mcp-client'
import type { ReconnectConfig } from '@deepseek-ai/dsh-mcp-client'
import { SessionId } from '@deepseek-ai/dsh-session'
import type ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { WorkspacePool } from '../src/pool.ts'
import type { DeclaredServer } from '../src/types.ts'

const fixturePath = fileURLToPath(new URL('./fixtures/echo-server.ts', import.meta.url))
const silentPath = fileURLToPath(new URL('./fixtures/silent-server.ts', import.meta.url))
const ECHO = 'mcp__fixture__echo'
const REGISTRATION_FAILED = 'mcp-workspace(fixture): tool registration failed for one agent: '

type CallIdValue = Parameters<ToolRuntime['execute']>[0]['callId']

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
  /** Fixture pid files; also the workspace path. */
  readonly dir: string
  readonly errors: string[]
}

async function harness(
  credentials: Record<string, string | undefined> = {},
  reconnect: ReconnectConfig = { enabled: false },
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-pool-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  cleanups.push(() => killLeftovers(dir))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const errors: string[] = []
  ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(PersistenceProbe)
  ctx.on('session/flush', () => {})
  await ctx.plugin(AgentLoop, { agents: [] })
  const pool = new WorkspacePool(ctx, {
    toolCallTimeoutMs: 15_000,
    reconnect: resolveReconnectPolicy(reconnect, 'test.reconnect'),
    resolveCredential: async ref => credentials[ref],
  })
  cleanups.push(() => pool.dispose())
  return { ctx, pool, dir, errors }
}

interface FixtureOverrides {
  readonly fingerprint?: string
  readonly env?: Record<string, string>
  readonly credentialRefs?: string[]
}

function fixtureServer(dir: string, overrides: FixtureOverrides = {}): DeclaredServer {
  return {
    name: 'fixture',
    fingerprint: overrides.fingerprint ?? 'sha256:one',
    credentialRefs: overrides.credentialRefs ?? [],
    entry: {
      transport: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      env: { MCP_FIXTURE_PID_DIR: dir, ...overrides.env },
    },
  }
}

async function createAgent(ctx: Context, id: string): Promise<Agent> {
  return (await ctx.agents.create({ sessionId: SessionId(id) })).agent
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

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
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

function squat(name: string): ToolDefinition {
  return {
    name,
    description: 'Occupies the name.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'null' }, render: () => [] },
    async execute() { return null },
  }
}

describe('WorkspacePool', () => {
  it('shares one child between two acquires of the same server', async () => {
    const { pool, dir } = await harness()
    const first = pool.acquire(dir, fixtureServer(dir))
    const second = pool.acquire(dir, fixtureServer(dir))
    await expect(first.ready).resolves.toEqual({})
    await expect(second.ready).resolves.toEqual({})
    expect(await pids(dir)).toHaveLength(1)
    expect(first.toolNames()).toEqual([ECHO])
  })

  it('attach registers the tools on the agent layer only', async () => {
    const { ctx, pool, dir } = await harness()
    const agentA = await createAgent(ctx, 'pool-a')
    const lease = pool.acquire(dir, fixtureServer(dir))
    await lease.ready
    lease.attach(agentA.ctx)
    expect(ctx.tools.get(ECHO, agentA)).toBeDefined()
    expect(ctx.tools.get(ECHO)).toBeUndefined()
  })

  it('attach before the first sync registers the tools once they are published', async () => {
    const { ctx, pool, dir } = await harness()
    const agentA = await createAgent(ctx, 'pool-a')
    const lease = pool.acquire(dir, fixtureServer(dir))
    lease.attach(agentA.ctx)
    expect(ctx.tools.get(ECHO, agentA)).toBeUndefined()
    await lease.ready
    expect(ctx.tools.get(ECHO, agentA)).toBeDefined()
  })

  it('detach removes the tools from that agent only', async () => {
    const { ctx, pool, dir } = await harness()
    const agentA = await createAgent(ctx, 'pool-a')
    const agentB = await createAgent(ctx, 'pool-b')
    const lease = pool.acquire(dir, fixtureServer(dir))
    await lease.ready
    const detachA = lease.attach(agentA.ctx)
    lease.attach(agentB.ctx)
    detachA()
    detachA()
    expect(ctx.tools.get(ECHO, agentA)).toBeUndefined()
    expect(ctx.tools.get(ECHO, agentB)).toBeDefined()
  })

  it('releasing the last lease terminates the child', async () => {
    const { pool, dir } = await harness()
    const first = pool.acquire(dir, fixtureServer(dir))
    const second = pool.acquire(dir, fixtureServer(dir))
    await first.ready
    const [pid] = await pids(dir)
    await first.release()
    expect(isAlive(pid!)).toBe(true)
    await second.release()
    await until(() => !isAlive(pid!))
  }, 20_000)

  it('dispose waits for a connection whose last lease was released without awaiting', async () => {
    const { pool, dir } = await harness()
    const lease = pool.acquire(dir, fixtureServer(dir))
    await lease.ready
    const [pid] = await pids(dir)
    void lease.release()
    await pool.dispose()
    expect(isAlive(pid!)).toBe(false)
  }, 20_000)

  it('release is idempotent and returns the same settlement', async () => {
    const { pool, dir } = await harness()
    const lease = pool.acquire(dir, fixtureServer(dir))
    await lease.ready
    const release = lease.release()
    expect(lease.release()).toBe(release)
    await release
  })

  it('reports a missing credential through ready without starting a child', async () => {
    const { pool, dir } = await harness()
    const server = fixtureServer(dir, { env: { MCP_FIXTURE_TOKEN: '${TOK}' }, credentialRefs: ['TOK'] })
    const outcome = await pool.acquire(dir, server).ready
    expect(String(outcome.error)).toBe('Error: credential TOK is not set')
    expect(await pids(dir)).toEqual([])
  })

  it('passes a resolved credential to the child', async () => {
    const { ctx, pool, dir } = await harness({ TOK: 'secret-value' })
    const agentA = await createAgent(ctx, 'pool-a')
    const server = fixtureServer(dir, {
      env: { MCP_FIXTURE_EXPECT_TOKEN: '1', MCP_FIXTURE_TOKEN: '${TOK}' },
      credentialRefs: ['TOK'],
    })
    const lease = pool.acquire(dir, server)
    await expect(lease.ready).resolves.toEqual({})
    lease.attach(agentA.ctx)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'pool-token' as CallIdValue,
      name: 'mcp__fixture__token',
      arguments: {},
      agent: agentA,
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'secret-value' })
  })

  it('substitutes credentials into an HTTP server URL and headers', async () => {
    const { pool, dir } = await harness({ TOK: 'secret-value', PATH_PART: 'mcp' })
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = []
    const http = createServer((request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization })
      response.writeHead(500).end()
    })
    await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
    cleanups.push(() => new Promise<void>((resolve) => {
      http.closeAllConnections()
      http.close(() => { resolve() })
    }))
    const { port } = http.address() as AddressInfo
    const outcome = await pool.acquire(dir, {
      name: 'remote',
      fingerprint: 'sha256:http',
      credentialRefs: ['PATH_PART', 'TOK'],
      entry: {
        transport: 'streamable-http',
        url: `http://127.0.0.1:${port}/\${PATH_PART}`,
        headers: { Authorization: 'Bearer ${TOK}' },
      },
    }).ready
    expect(outcome.error).toBeDefined()
    expect(requests[0]).toEqual({ url: '/mcp', authorization: 'Bearer secret-value' })
  })

  it('starts a separate connection for a different fingerprint of the same name', async () => {
    const { pool, dir } = await harness()
    const first = pool.acquire(dir, fixtureServer(dir, { fingerprint: 'sha256:one' }))
    const second = pool.acquire(dir, fixtureServer(dir, { fingerprint: 'sha256:two' }))
    await Promise.all([first.ready, second.ready])
    expect(await pids(dir)).toHaveLength(2)
  })

  it('lists exactly the live attachments with their tool names', async () => {
    const { ctx, pool, dir } = await harness()
    const agentA = await createAgent(ctx, 'pool-a')
    const agentB = await createAgent(ctx, 'pool-b')
    const lease = pool.acquire(dir, fixtureServer(dir))
    await lease.ready
    const detachA = lease.attach(agentA.ctx)
    lease.attach(agentB.ctx)
    const label = (agentCtx: Context): string => agentCtx === agentA.ctx ? 'A' : agentCtx === agentB.ctx ? 'B' : 'other'
    const listed = () => pool.attachments().map(attachment => ({ ...attachment, agentCtx: label(attachment.agentCtx) }))
    expect(listed()).toEqual([
      { workspacePath: dir, serverName: 'fixture', agentCtx: 'A', toolNames: [ECHO] },
      { workspacePath: dir, serverName: 'fixture', agentCtx: 'B', toolNames: [ECHO] },
    ])
    detachA()
    expect(listed()).toEqual([
      { workspacePath: dir, serverName: 'fixture', agentCtx: 'B', toolNames: [ECHO] },
    ])
  })

  it('contains a registration failure on attach to that agent', async () => {
    const { ctx, pool, dir, errors } = await harness()
    const agentA = await createAgent(ctx, 'pool-a')
    const agentB = await createAgent(ctx, 'pool-b')
    const lease = pool.acquire(dir, fixtureServer(dir))
    await lease.ready
    agentA.ctx.tools.register(squat(ECHO))
    lease.attach(agentA.ctx)
    lease.attach(agentB.ctx)
    expect(ctx.tools.get(ECHO, agentA)?.description).toBe('Occupies the name.')
    expect(ctx.tools.get(ECHO, agentB)).toBeDefined()
    expect(errors.filter(line => line.startsWith(REGISTRATION_FAILED))).toHaveLength(1)
    expect(pool.attachments().map(attachment => attachment.toolNames)).toEqual([[], [ECHO]])
  })

  it('leaves an agent with no partial definition set when a later registration fails', async () => {
    const { ctx, pool, dir, errors } = await harness()
    const agentA = await createAgent(ctx, 'pool-a')
    const lease = pool.acquire(dir, fixtureServer(dir, { env: { MCP_FIXTURE_EXPECT_TOKEN: '1' } }))
    await lease.ready
    expect(lease.toolNames()).toEqual([ECHO, 'mcp__fixture__token'])
    agentA.ctx.tools.register(squat('mcp__fixture__token'))
    lease.attach(agentA.ctx)
    expect(ctx.tools.get(ECHO, agentA)).toBeUndefined()
    expect(ctx.tools.get('mcp__fixture__token', agentA)?.description).toBe('Occupies the name.')
    expect(errors.filter(line => line.startsWith(REGISTRATION_FAILED))).toHaveLength(1)
    expect(pool.attachments().map(attachment => attachment.toolNames)).toEqual([[]])
  })

  it('releasing a lease detaches only the agents attached through it', async () => {
    const { ctx, pool, dir } = await harness()
    const agentA = await createAgent(ctx, 'pool-a')
    const agentB = await createAgent(ctx, 'pool-b')
    const first = pool.acquire(dir, fixtureServer(dir))
    const second = pool.acquire(dir, fixtureServer(dir))
    await first.ready
    first.attach(agentA.ctx)
    second.attach(agentB.ctx)
    await first.release()
    expect(ctx.tools.get(ECHO, agentA)).toBeUndefined()
    expect(ctx.tools.get(ECHO, agentB)).toBeDefined()
    expect(() => first.attach(agentA.ctx)).toThrow('mcp-workspace(fixture): attach on a released lease')
  })

  it('replaces a stopped connection on the next acquire and keeps attachments', async () => {
    const { ctx, pool, dir, errors } = await harness()
    const agentA = await createAgent(ctx, 'pool-a')
    const agentB = await createAgent(ctx, 'pool-b')
    const first = pool.acquire(dir, fixtureServer(dir))
    await first.ready
    first.attach(agentA.ctx)
    first.attach(agentB.ctx)
    const [pid] = await pids(dir)
    process.kill(pid!, 'SIGKILL')
    await until(() => errors.some(line => line.includes('connection lost and reconnect is disabled')))

    const second = pool.acquire(dir, fixtureServer(dir))
    expect(ctx.tools.get(ECHO, agentA)).toBeUndefined()
    expect(second.toolNames()).toEqual([])
    agentB.ctx.tools.register(squat(ECHO))
    await expect(second.ready).resolves.toEqual({})

    expect(await pids(dir)).toHaveLength(2)
    expect(ctx.tools.get(ECHO, agentA)?.description).toBe('Returns the given text.')
    expect(ctx.tools.get(ECHO, agentB)?.description).toBe('Occupies the name.')
    expect(errors.filter(line => line.startsWith(REGISTRATION_FAILED))).toHaveLength(1)
    expect(pool.attachments().map(attachment => attachment.toolNames)).toEqual([[ECHO], []])
  }, 20_000)

  it('clears every attached agent when the reconnect budget is exhausted', async () => {
    const credentials: Record<string, string | undefined> = { TOK: 'secret-value' }
    const { ctx, pool, dir, errors } = await harness(credentials, { initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 })
    const agentA = await createAgent(ctx, 'pool-a')
    const lease = pool.acquire(dir, fixtureServer(dir, { env: { MCP_FIXTURE_TOKEN: '${TOK}' }, credentialRefs: ['TOK'] }))
    await lease.ready
    lease.attach(agentA.ctx)
    expect(ctx.tools.get(ECHO, agentA)).toBeDefined()
    delete credentials.TOK
    const [pid] = await pids(dir)
    process.kill(pid!, 'SIGKILL')
    await until(() => errors.some(line => line.includes('giving up')))
    await until(() => ctx.tools.get(ECHO, agentA) === undefined)
    expect(lease.toolNames()).toEqual([])
    expect(pool.attachments().map(attachment => attachment.toolNames)).toEqual([[]])
  }, 20_000)

  it('dispose closes every child and clears registrations', async () => {
    const { ctx, pool, dir } = await harness()
    const agentA = await createAgent(ctx, 'pool-a')
    const agentB = await createAgent(ctx, 'pool-b')
    const first = pool.acquire(dir, fixtureServer(dir, { fingerprint: 'sha256:one' }))
    const second = pool.acquire(dir, fixtureServer(dir, { fingerprint: 'sha256:two' }))
    await Promise.all([first.ready, second.ready])
    first.attach(agentA.ctx)
    second.attach(agentB.ctx)
    const children = await pids(dir)
    await pool.dispose()
    expect(ctx.tools.get(ECHO, agentA)).toBeUndefined()
    expect(ctx.tools.get(ECHO, agentB)).toBeUndefined()
    expect(pool.attachments()).toEqual([])
    await until(() => children.every(pid => !isAlive(pid)))
    expect(() => pool.acquire(dir, fixtureServer(dir))).toThrow('mcp-workspace: acquire on a disposed pool')
  }, 20_000)

  it('dispose settles during a connection first attempt', async () => {
    const { pool, dir } = await harness()
    const lease = pool.acquire(dir, fixtureServer(dir))
    const started = Date.now()
    await pool.dispose()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(await lease.ready).toHaveProperty('error')
    await until(async () => (await pids(dir)).every(pid => !isAlive(pid)))
  }, 15_000)

  it('dispose settles after the child started and before the first attempt settles', async () => {
    const { pool, dir } = await harness()
    const silent = fixtureServer(dir)
    const lease = pool.acquire(dir, { ...silent, entry: { ...silent.entry, args: [silentPath] } as DeclaredServer['entry'] })
    await until(async () => (await pids(dir)).length === 1)
    const [pid] = await pids(dir)
    void lease.release()
    const started = Date.now()
    await pool.dispose()
    expect(Date.now() - started).toBeLessThan(5_000)
    await until(() => !isAlive(pid!))
  }, 15_000)
})
