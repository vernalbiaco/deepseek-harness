import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveReconnectPolicy } from '@deepseek-ai/dsh-mcp-client'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import UserQuestionService, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { activePools } from '../src/active-pools.ts'
import { ALLOW_SESSION, ALLOW_WORKSPACE, DENY, QUESTION_ID, WorkspaceBinder } from '../src/binder.ts'
import { fingerprintEntry } from '../src/mcp-json.ts'
import { WorkspacePool } from '../src/pool.ts'
import { TrustStore } from '../src/trust-store.ts'
import type * as McpJson from '../src/mcp-json.ts'

const reads = vi.hoisted(() => ({ settled: 0, gate: Promise.resolve() as Promise<void> }))

vi.mock('../src/mcp-json.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof McpJson>()
  return {
    ...actual,
    readMcpJson: async (workspacePath: string) => {
      try {
        await reads.gate
        return await actual.readMcpJson(workspacePath)
      } finally {
        reads.settled += 1
      }
    },
  }
})

const fixturePath = fileURLToPath(new URL('./fixtures/echo-server.ts', import.meta.url))
const silentPath = fileURLToPath(new URL('./fixtures/silent-server.ts', import.meta.url))
const ECHO = 'mcp__fixture__echo'

class PersistenceProbe extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }
}

/** A trust store whose lookups can be held open and are counted. */
class GatedTrust extends TrustStore {
  started = 0
  completed = 0
  gate: Promise<void> = Promise.resolve()

  override async lookup(workspacePath: string, serverName: string, fingerprint: string): Promise<'allow' | 'deny' | undefined> {
    this.started += 1
    await this.gate
    const decision = await super.lookup(workspacePath, serverName, fingerprint)
    this.completed += 1
    return decision
  }
}

/** In-memory credentials whose resolution can be held open. */
class GatedCredentials extends MemoryCredentials {
  resolving = 0
  gate: Promise<void> = Promise.resolve()
  /** When set, every resolution rejects with it. */
  failure: Error | undefined

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    this.resolving += 1
    await this.gate
    if (this.failure !== undefined) throw this.failure
    return super.resolve(ref)
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

interface Questions {
  readonly requests: AskUserQuestionRequest[]
  /** Called synchronously inside each `ask`. */
  onAsk?: (request: AskUserQuestionRequest) => void
  /** Settle the oldest unsettled question with one selected label, or with no answer for `QUESTION_ID`. */
  answer(label?: string): void
  fail(error: Error): void
}

interface HarnessOptions {
  readonly credentials?: Record<string, string>
  /** `provider` mounts the service with a scripted provider; `service` mounts it without one; `none` omits it. */
  readonly questions?: 'provider' | 'service' | 'none'
}

interface Harness {
  readonly ctx: Context
  readonly pool: WorkspacePool
  readonly trust: GatedTrust
  readonly credentials: GatedCredentials
  readonly binder: WorkspaceBinder
  readonly questions: Questions
  /** Canonical workspace directory holding `.mcp.json`. */
  readonly workspace: string
  /** Canonical directory outside the workspace. */
  readonly root: string
  readonly trustFile: string
  /** Fixture pid files. */
  readonly pidDir: string
  readonly warns: string[]
  readonly errors: string[]
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mcp-binder-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const pidDir = join(root, 'pids')
  await mkdir(workspace)
  await mkdir(pidDir)
  cleanups.push(() => killLeftovers(pidDir))
  reads.settled = 0
  reads.gate = Promise.resolve()
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const warns: string[] = []
  const errors: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(PersistenceProbe)
  ctx.on('session/flush', () => {})
  await ctx.plugin(GatedCredentials, options.credentials ?? {})
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 8 }, () => textResponse('done'))))
  const questions = await mountQuestions(ctx, options.questions ?? 'provider')
  const pool = new WorkspacePool(ctx, {
    toolCallTimeoutMs: 15_000,
    reconnect: resolveReconnectPolicy({ enabled: false }, 'test.reconnect'),
    resolveCredential: async ref => (await ctx.credentials.resolve(ref as CredentialRef))?.value,
  })
  cleanups.push(() => pool.dispose())
  activePools().set(ctx.root, pool)
  cleanups.push(async () => { activePools().delete(ctx.root) })
  const trustFile = join(root, 'home', 'mcp-trust.yaml')
  const trust = new GatedTrust(trustFile)
  const binder = new WorkspaceBinder(ctx, { pool, trust })
  cleanups.push(async () => { binder.dispose() })
  ctx.on('agent/created', ({ agent }) => { binder.onAgentCreated(agent) })
  return {
    ctx,
    pool,
    trust,
    credentials: ctx.credentials as GatedCredentials,
    binder,
    questions,
    workspace,
    root,
    trustFile,
    pidDir,
    warns,
    errors,
  }
}

async function mountQuestions(ctx: Context, mode: 'provider' | 'service' | 'none'): Promise<Questions> {
  const pending: Array<PromiseWithResolvers<AskUserQuestionAnswer>> = []
  const questions: Questions = {
    requests: [],
    answer(label) {
      pending.shift()!.resolve({ answers: label === undefined ? [] : [{ id: QUESTION_ID, selected: [label] }] })
    },
    fail(error) {
      pending.shift()!.reject(error)
    },
  }
  if (mode === 'none') return questions
  await ctx.plugin(UserQuestionService)
  if (mode === 'service') return questions
  ctx.userQuestions.registerProvider({
    ask(request) {
      questions.requests.push(request)
      const settle = Promise.withResolvers<AskUserQuestionAnswer>()
      pending.push(settle)
      request.signal?.addEventListener('abort', () => {
        pending.splice(pending.indexOf(settle), 1)
        settle.reject(new UserQuestionError('aborted', 'ASK_ABORTED'))
      }, { once: true })
      questions.onAsk?.(request)
      return settle.promise
    },
  })
  return questions
}

function fixtureEntry(pidDir: string, env: Record<string, string> = {}): Record<string, unknown> {
  return { command: process.execPath, args: [fixturePath], env: { MCP_FIXTURE_PID_DIR: pidDir, ...env } }
}

async function writeMcpJson(workspace: string, servers: Record<string, unknown>): Promise<void> {
  await writeFile(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
}

async function allow(trust: TrustStore, workspace: string, servers: Record<string, Record<string, unknown>>): Promise<void> {
  await trust.record(
    workspace,
    Object.entries(servers).map(([serverName, entry]) => ({ serverName, decision: 'allow' as const, fingerprint: fingerprintEntry(entry) })),
    new Date(),
  )
}

async function create(ctx: Context, id: string, meta: { cwd?: string; origin?: 'subagent' } = {}): Promise<AgentHandle> {
  return await ctx.agents.create({
    sessionId: SessionId(id),
    meta,
    agentOptions: { provider: 'mock', model: 'mock' },
  })
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function runTurn(ctx: Context, agent: Agent): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await idle
}

function headerTools(agent: Agent): Array<{ reason: string; tools: string[] }> {
  return agent.session.events.flatMap(event => event.type === 'request/header'
    ? [{ reason: event.data.reason, tools: (event.data.header.tools ?? []).map(tool => tool.name) }]
    : [])
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

function squat(name: string): ToolDefinition {
  return {
    name,
    description: 'Occupies the name.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'null' }, render: () => [] },
    async execute() { return null },
  }
}

/** Resolve after `count` `.mcp.json` reads and every started lookup have settled and the admission continuations have run. */
async function settled(trust: GatedTrust, count: number): Promise<void> {
  await until(() => reads.settled >= count && trust.completed === trust.started)
  await sleep(50)
}

describe('WorkspaceBinder first-step visibility', () => {
  it('lists a preconnected server tool in the initial request header of an agent created afterwards', async () => {
    const { ctx, trust, binder, workspace, pidDir } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    const leases = await binder.preconnect(workspace)
    await Promise.all(leases.map(lease => lease.ready))
    expect(leases.map(lease => lease.toolNames())).toEqual([[ECHO]])

    const { agent } = await create(ctx, 'binder-first-step', { cwd: workspace })
    expect(ctx.tools.get(ECHO, agent)).toBeDefined()
    await runTurn(ctx, agent)

    expect(headerTools(agent)[0]).toEqual({ reason: 'initial', tools: [ECHO] })
    await until(async () => (await pids(pidDir)).length === 1)
  })

  it('keeps the preconnect reference when an earlier agent is disposed', async () => {
    const { ctx, trust, binder, workspace, pidDir } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    await Promise.all((await binder.preconnect(workspace)).map(lease => lease.ready))

    const first = await create(ctx, 'binder-keep-first', { cwd: workspace })
    const second = await create(ctx, 'binder-keep-second', { cwd: workspace })
    await settled(trust, 3)
    await first.dispose()
    const third = await create(ctx, 'binder-keep-third', { cwd: workspace })
    await runTurn(ctx, third.agent)

    expect(headerTools(third.agent)[0]).toEqual({ reason: 'initial', tools: [ECHO] })
    expect(ctx.tools.get(ECHO, second.agent)).toBeDefined()
    expect(await pids(pidDir)).toHaveLength(1)
  })

  it('does not attach synchronously while the held connection has published no tools', async () => {
    const { ctx, trust, binder, workspace, pidDir } = await harness()
    const entry = { command: process.execPath, args: [silentPath], env: { MCP_FIXTURE_PID_DIR: pidDir } }
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    expect(await binder.preconnect(workspace)).toHaveLength(1)

    const silent = await create(ctx, 'binder-silent', { cwd: workspace })
    expect(ctx.tools.get(ECHO, silent.agent)).toBeUndefined()
    await settled(trust, 2)
    await silent.dispose()
    expect(ctx.tools.get(ECHO, silent.agent)).toBeUndefined()
  })
})

describe('WorkspaceBinder eligibility', () => {
  it('gives a one-shot child of a root agent no workspace tools', async () => {
    const { ctx, trust, binder, workspace, pidDir } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    await Promise.all((await binder.preconnect(workspace)).map(lease => lease.ready))

    const parent = await create(ctx, 'binder-parent', { cwd: workspace })
    const child = await parent.agent.ctx.agents.create({
      sessionId: SessionId('binder-one-shot'),
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await settled(trust, 2)

    expect(ctx.tools.get(ECHO, parent.agent)).toBeDefined()
    expect(ctx.tools.get(ECHO, child.agent)).toBeUndefined()
    // The preconnect lookup and the parent's recheck; the child is not eligible.
    expect(trust.started).toBe(2)
    await child.dispose()
  })

  it('attaches allowed servers to a subagent-origin root without asking about undecided ones', async () => {
    const { ctx, trust, workspace, pidDir, questions, warns } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry, second: fixtureEntry(pidDir, { SECOND: '1' }) })
    await allow(trust, workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-continuable', { cwd: workspace, origin: 'subagent' })
    await until(() => ctx.tools.get(ECHO, agent) !== undefined)

    expect(questions.requests).toEqual([])
    expect(warns).toContain('mcp-workspace(second): not approved')
    expect(ctx.tools.get('mcp__second__echo', agent)).toBeUndefined()
  })

  it('ignores an agent without a cwd and warns for a cwd that is not a directory', async () => {
    const { ctx, trust, root, warns } = await harness()
    await create(ctx, 'binder-no-cwd')
    const missing = join(root, 'missing')
    await create(ctx, 'binder-missing-cwd', { cwd: missing })
    await sleep(50)

    expect(trust.started).toBe(0)
    expect(warns).toEqual([`mcp-workspace: session cwd ${missing} is not a directory`])
  })

  it('admits nothing for a workspace without .mcp.json', async () => {
    const { ctx, trust, workspace, questions, warns, errors } = await harness()
    const { agent } = await create(ctx, 'binder-no-file', { cwd: workspace })
    await sleep(50)

    expect(trust.started).toBe(0)
    expect(questions.requests).toEqual([])
    expect([...warns, ...errors]).toEqual([])
    expect(headerTools(agent)).toEqual([])
  })
})

describe('WorkspaceBinder decisions', () => {
  it('records Allow for this workspace and attaches the tools for the next step', async () => {
    const { ctx, trustFile, workspace, pidDir, questions } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-allow-workspace', { cwd: workspace })
    await runTurn(ctx, agent)
    await until(() => questions.requests.length === 1)
    expect(questions.requests[0]?.agent).toBe(agent)
    expect(questions.requests[0]?.questions).toEqual([{
      id: QUESTION_ID,
      header: 'MCP servers',
      question: `Allow MCP servers declared in ${workspace}/.mcp.json?`,
      detail: `- fixture (stdio): ${process.execPath} ${fixturePath}`,
      options: [{ label: ALLOW_WORKSPACE }, { label: ALLOW_SESSION }, { label: DENY }],
    }])
    questions.answer(ALLOW_WORKSPACE)
    await until(() => ctx.tools.get(ECHO, agent) !== undefined)
    await runTurn(ctx, agent)

    expect(headerTools(agent)).toEqual([{ reason: 'initial', tools: [] }, { reason: 'change', tools: [ECHO] }])
    expect(await new TrustStore(trustFile).lookup(workspace, 'fixture', fingerprintEntry(entry))).toBe('allow')
  })

  it('attaches Allow this session to the asking agent only and records nothing', async () => {
    const { ctx, trust, workspace, pidDir, questions } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })

    const first = await create(ctx, 'binder-session-first', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    questions.answer(ALLOW_SESSION)
    await until(() => ctx.tools.get(ECHO, first.agent) !== undefined)
    expect(await trust.lookup(workspace, 'fixture', fingerprintEntry(entry))).toBeUndefined()

    const second = await create(ctx, 'binder-session-second', { cwd: workspace })
    expect(ctx.tools.get(ECHO, second.agent)).toBeUndefined()
    await until(() => questions.requests.length === 2)
    expect(questions.requests[1]?.agent).toBe(second.agent)
    await first.dispose()
    await until(async () => (await pids(pidDir)).every(pid => !isAlive(pid)))
  })

  it('records Deny and does not ask a later session', async () => {
    const { ctx, trust, trustFile, workspace, pidDir, questions } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })

    await create(ctx, 'binder-deny-first', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    questions.answer(DENY)
    await until(async () => await new TrustStore(trustFile).lookup(workspace, 'fixture', fingerprintEntry(entry)) === 'deny')

    const { agent } = await create(ctx, 'binder-deny-second', { cwd: workspace })
    await settled(trust, 2)
    expect(questions.requests).toHaveLength(1)
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    expect(await pids(pidDir)).toEqual([])
  })

  it('asks once for concurrent sessions in one workspace and attaches both on Allow for this workspace', async () => {
    const { ctx, trust, workspace, pidDir, questions } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })

    const [first, second] = await Promise.all([
      create(ctx, 'binder-concurrent-first', { cwd: workspace }),
      create(ctx, 'binder-concurrent-second', { cwd: workspace }),
    ])
    await until(() => questions.requests.length === 1)
    await settled(trust, 2)
    questions.answer(ALLOW_WORKSPACE)
    await until(() => ctx.tools.get(ECHO, first.agent) !== undefined && ctx.tools.get(ECHO, second.agent) !== undefined)

    expect(questions.requests).toHaveLength(1)
    expect(await pids(pidDir)).toHaveLength(1)
  })

  it('lets a waiting session ask again after the asker chose Allow this session', async () => {
    const { ctx, trust, trustFile, workspace, pidDir, questions } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })

    const [first, second] = await Promise.all([
      create(ctx, 'binder-retry-first', { cwd: workspace }),
      create(ctx, 'binder-retry-second', { cwd: workspace }),
    ])
    await until(() => questions.requests.length === 1)
    await settled(trust, 2)
    const asker = questions.requests[0]!.agent === first.agent ? first : second
    const waiter = asker === first ? second : first
    questions.answer(ALLOW_SESSION)
    await until(() => ctx.tools.get(ECHO, asker.agent) !== undefined)
    await until(() => questions.requests.length === 2)
    expect(questions.requests[1]?.agent).toBe(waiter.agent)
    questions.answer(DENY)
    await until(async () => await new TrustStore(trustFile).lookup(workspace, 'fixture', fingerprintEntry(entry)) === 'deny')

    expect(ctx.tools.get(ECHO, waiter.agent)).toBeUndefined()
  })

  it('aborts the question when the asking agent is disposed and lets the waiter ask again', async () => {
    const { ctx, trust, workspace, pidDir, questions } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })

    const handles = await Promise.all([
      create(ctx, 'binder-abort-first', { cwd: workspace }),
      create(ctx, 'binder-abort-second', { cwd: workspace }),
    ])
    await until(() => questions.requests.length === 1)
    await settled(trust, 2)
    const request = questions.requests[0]!
    const asker = handles.find(handle => handle.agent === request.agent)!
    const waiter = handles.find(handle => handle !== asker)!
    await asker.dispose()

    expect(request.signal?.aborted).toBe(true)
    await until(() => questions.requests.length === 2)
    expect(questions.requests[1]?.agent).toBe(waiter.agent)
    questions.answer(ALLOW_WORKSPACE)
    await until(() => ctx.tools.get(ECHO, waiter.agent) !== undefined)
  })

  it('attaches nothing to a waiting session disposed before the answer', async () => {
    const { ctx, trust, workspace, pidDir, questions } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })

    const handles = await Promise.all([
      create(ctx, 'binder-waiter-first', { cwd: workspace }),
      create(ctx, 'binder-waiter-second', { cwd: workspace }),
    ])
    await until(() => questions.requests.length === 1)
    await settled(trust, 2)
    const asker = handles.find(handle => handle.agent === questions.requests[0]!.agent)!
    const waiter = handles.find(handle => handle !== asker)!
    await waiter.dispose()
    questions.answer(ALLOW_WORKSPACE)
    await until(() => ctx.tools.get(ECHO, asker.agent) !== undefined)

    expect(ctx.tools.get(ECHO, waiter.agent)).toBeUndefined()
    expect(questions.requests).toHaveLength(1)
  })

  it('lists each server with its transport, target, and credential status without values', async () => {
    const { ctx, workspace, pidDir, questions, trustFile } = await harness({ credentials: { API_KEY: 'secret-key-value' } })
    const api = { type: 'http', url: 'https://mcp.example.invalid/${TENANT}', headers: { Authorization: 'Bearer ${API_KEY}' } }
    await writeMcpJson(workspace, { api, fixture: fixtureEntry(pidDir) })

    await create(ctx, 'binder-detail', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    const detail = questions.requests[0]?.questions[0]?.detail
    questions.answer(DENY)
    await until(async () => await new TrustStore(trustFile).lookup(workspace, 'api', fingerprintEntry(api)) === 'deny')

    expect(detail).toBe([
      '- api (http): https://mcp.example.invalid/${TENANT}; credentials: API_KEY set, TENANT missing',
      `- fixture (stdio): ${process.execPath} ${fixturePath}`,
    ].join('\n'))
    expect(detail).not.toContain('secret-key-value')
  })

  it('logs an answer without a listed option as not approved', async () => {
    const { ctx, trust, workspace, pidDir, questions, warns } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-unanswered', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    questions.answer()
    await until(() => warns.includes('mcp-workspace(fixture): not approved'))

    expect(await trust.lookup(workspace, 'fixture', fingerprintEntry(entry))).toBeUndefined()
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
  })

  it('logs a failed question and admits nothing', async () => {
    const { ctx, workspace, pidDir, questions, errors } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })

    const { agent } = await create(ctx, 'binder-question-failed', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    questions.fail(new Error('provider broke'))
    await until(() => errors.length === 1)

    expect(errors).toEqual(['mcp-workspace: question failed: Error: provider broke'])
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
  })

  it('admits nothing when Allow for this workspace cannot be recorded', async () => {
    const { ctx, workspace, pidDir, questions, errors, trustFile } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })
    await mkdir(join(trustFile, '..'), { recursive: true })
    questions.onAsk = () => { void writeFile(trustFile, 'version: 2\nworkspaces: {}\n') }

    const { agent } = await create(ctx, 'binder-record-failed', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    await sleep(50)
    questions.answer(ALLOW_WORKSPACE)
    await until(() => errors.length === 1)

    expect(errors[0]).toContain(`mcp-workspace: trust file ${trustFile} does not match the expected format`)
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    expect(await pids(pidDir)).toEqual([])
  })

  it.each([
    ['without a provider', 'service'],
    ['without the question service', 'none'],
  ] as const)('logs undecided servers as not approved %s', async (_label, mode) => {
    const { ctx, trust, workspace, pidDir, warns } = await harness({ questions: mode })
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })

    await create(ctx, `binder-no-ui-${mode}`, { cwd: workspace })
    await until(() => warns.length === 1)

    expect(warns).toEqual(['mcp-workspace(fixture): not approved; no question UI is available'])
    expect(await trust.lookup(workspace, 'fixture', fingerprintEntry(entry))).toBeUndefined()
  })
})

describe('WorkspaceBinder failures', () => {
  it('logs a refused literal secret by field without its value', async () => {
    const { ctx, workspace, pidDir, questions, warns } = await harness()
    await writeMcpJson(workspace, { leaky: fixtureEntry(pidDir, { API_TOKEN: 'literal-token-value' }) })

    await create(ctx, 'binder-refused', { cwd: workspace })
    await until(() => warns.length === 1)

    expect(warns).toEqual(['mcp-workspace(leaky): literal secret in env.API_TOKEN'])
    expect(warns.join('\n')).not.toContain('literal-token-value')
    expect(questions.requests).toEqual([])
  })

  it('warns once per workspace server when agent-scoped tools shadow a global tool', async () => {
    const { ctx, trust, binder, workspace, pidDir, warns } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    ctx.tools.register(squat(ECHO))
    await Promise.all((await binder.preconnect(workspace)).map(lease => lease.ready))

    const first = await create(ctx, 'binder-shadow-first', { cwd: workspace })
    const second = await create(ctx, 'binder-shadow-second', { cwd: workspace })
    await settled(trust, 3)

    expect(warns).toEqual(['mcp-workspace(fixture): agent-scoped tools shadow a global tool of the same name'])
    expect(ctx.tools.get(ECHO, first.agent)).not.toBe(ctx.tools.get(ECHO))
    expect(ctx.tools.get(ECHO, second.agent)).not.toBe(ctx.tools.get(ECHO))
  })

  it('admits nothing when the trust file cannot be read', async () => {
    const { ctx, binder, workspace, pidDir, questions, errors, trustFile } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })
    await mkdir(join(trustFile, '..'), { recursive: true })
    await writeFile(trustFile, 'version: 2\nworkspaces: {}\n')

    expect(await binder.preconnect(workspace)).toEqual([])
    const { agent } = await create(ctx, 'binder-trust-error', { cwd: workspace })
    await until(() => errors.length === 2)

    const message = `mcp-workspace: trust file ${trustFile} does not match the expected format at version`
    expect(errors).toEqual([message, message])
    expect(questions.requests).toEqual([])
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
  })

  it('logs an unreadable .mcp.json', async () => {
    const { ctx, binder, workspace, errors } = await harness()
    await writeFile(join(workspace, '.mcp.json'), '{')

    expect(await binder.preconnect(workspace)).toEqual([])
    await create(ctx, 'binder-bad-json', { cwd: workspace })
    await until(() => errors.length === 2)

    const message = `mcp-workspace: McpJsonError: ${join(workspace, '.mcp.json')}: invalid JSON`
    expect(errors).toEqual([message, message])
  })

  it('skips an allowed server whose credential is not set', async () => {
    const { ctx, trust, binder, workspace, pidDir, warns } = await harness()
    const entry = fixtureEntry(pidDir, { MCP_FIXTURE_TOKEN: '${TOKEN}' })
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    expect(await binder.preconnect(workspace)).toEqual([])
    const { agent } = await create(ctx, 'binder-missing-credential', { cwd: workspace })
    await until(() => warns.length === 2)

    expect(warns).toEqual(['mcp-workspace(fixture): credential TOKEN is not set', 'mcp-workspace(fixture): credential TOKEN is not set'])
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    expect(await pids(pidDir)).toEqual([])
  })

  it('logs a credential resolution failure and admits nothing', async () => {
    const { ctx, trust, credentials, workspace, pidDir, errors } = await harness()
    const entry = fixtureEntry(pidDir, { MCP_FIXTURE_TOKEN: '${TOKEN}' })
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    credentials.failure = new Error('credential store unavailable')

    const { agent } = await create(ctx, 'binder-credential-failure', { cwd: workspace })
    await until(() => errors.length === 1)

    expect(errors).toEqual(['mcp-workspace: Error: credential store unavailable'])
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    expect(await pids(pidDir)).toEqual([])
  })

  it('attaches an allowed server whose credential is set', async () => {
    const { ctx, trust, workspace, pidDir } = await harness({ credentials: { TOKEN: 'token-value' } })
    const entry = fixtureEntry(pidDir, { MCP_FIXTURE_TOKEN: '${TOKEN}' })
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-credential', { cwd: workspace })
    await until(() => ctx.tools.get(ECHO, agent) !== undefined)
  })

  it('withdraws a synchronous attachment that .mcp.json no longer declares and releases the preconnect reference', async () => {
    const { ctx, trust, binder, workspace, pidDir } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    await Promise.all((await binder.preconnect(workspace)).map(lease => lease.ready))
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    reads.gate = gate.promise

    const { agent } = await create(ctx, 'binder-withdraw-attached', { cwd: workspace })
    expect(ctx.tools.get(ECHO, agent)).toBeDefined()
    await rm(join(workspace, '.mcp.json'))
    gate.resolve()

    await until(() => ctx.tools.get(ECHO, agent) === undefined)
    await until(async () => (await pids(pidDir)).every(pid => !isAlive(pid)))
  })

  it('attaches no preconnected server that .mcp.json no longer declares and releases the preconnect reference', async () => {
    const { ctx, trust, binder, workspace, pidDir } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    await Promise.all((await binder.preconnect(workspace)).map(lease => lease.ready))
    await rm(join(workspace, '.mcp.json'))

    const first = await create(ctx, 'binder-undeclared-first', { cwd: workspace })
    expect(ctx.tools.get(ECHO, first.agent)).toBeUndefined()
    await until(async () => (await pids(pidDir)).every(pid => !isAlive(pid)))
    const second = await create(ctx, 'binder-undeclared-second', { cwd: workspace })

    expect(ctx.tools.get(ECHO, second.agent)).toBeUndefined()
  })

  it('attaches no preconnected server whose .mcp.json entry changed', async () => {
    const { ctx, trust, binder, workspace, pidDir, questions } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    await Promise.all((await binder.preconnect(workspace)).map(lease => lease.ready))
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir, { CHANGED: '1' }) })

    const { agent } = await create(ctx, 'binder-changed', { cwd: workspace })
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    await until(() => questions.requests.length === 1)
    await until(async () => (await pids(pidDir)).every(pid => !isAlive(pid)))
  })

  it('attaches nothing from an unparseable .mcp.json and releases the preconnect reference', async () => {
    const { ctx, trust, binder, workspace, pidDir, errors } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    await Promise.all((await binder.preconnect(workspace)).map(lease => lease.ready))
    await writeFile(join(workspace, '.mcp.json'), '{')

    const { agent } = await create(ctx, 'binder-unparseable', { cwd: workspace })
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    await until(async () => (await pids(pidDir)).every(pid => !isAlive(pid)))
    await until(() => errors.length === 1)

    expect(errors).toEqual([`mcp-workspace: McpJsonError: ${join(workspace, '.mcp.json')}: invalid JSON`])
  })
})

describe('WorkspaceBinder stored-decision recheck', () => {
  async function preconnected(options: HarnessOptions = {}) {
    const h = await harness(options)
    const entry = fixtureEntry(h.pidDir)
    await writeMcpJson(h.workspace, { fixture: entry })
    await allow(h.trust, h.workspace, { fixture: entry })
    await Promise.all((await h.binder.preconnect(h.workspace)).map(lease => lease.ready))
    const [pid] = await pids(h.pidDir)
    return { ...h, entry, pid: pid! }
  }

  async function deny(trustFile: string, workspace: string, entry: Record<string, unknown>): Promise<void> {
    await new TrustStore(trustFile).record(workspace, [{ serverName: 'fixture', decision: 'deny', fingerprint: fingerprintEntry(entry) }], new Date())
  }

  it('gives a new agent no tools from a preconnected server after deny is written, and releases the preconnect reference', async () => {
    const { ctx, trustFile, workspace, entry, pid } = await preconnected()
    await deny(trustFile, workspace, entry)

    const { agent } = await create(ctx, 'recheck-deny-new', { cwd: workspace })
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    await runTurn(ctx, agent)

    expect(headerTools(agent)[0]).toEqual({ reason: 'initial', tools: [] })
    await until(() => !isAlive(pid))
  })

  it('withdraws a synchronously attached server when the agent\'s own asynchronous recheck reads deny', async () => {
    const { ctx, trust, trustFile, workspace, entry, pid, questions } = await preconnected()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    trust.gate = gate.promise

    const { agent } = await create(ctx, 'recheck-deny-attached', { cwd: workspace })
    expect(ctx.tools.get(ECHO, agent)).toBeDefined()
    await deny(trustFile, workspace, entry)
    gate.resolve()

    await until(() => ctx.tools.get(ECHO, agent) === undefined)
    await until(() => !isAlive(pid))
    expect(questions.requests).toEqual([])
  })

  it('withdraws a synchronously attached server when the agent\'s own asynchronous recheck cannot read the trust file', async () => {
    const { ctx, trust, trustFile, workspace, pid, errors } = await preconnected()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    trust.gate = gate.promise

    const { agent } = await create(ctx, 'recheck-invalid-attached', { cwd: workspace })
    expect(ctx.tools.get(ECHO, agent)).toBeDefined()
    await writeFile(trustFile, 'version: 2\nworkspaces: {}\n')
    gate.resolve()

    await until(() => ctx.tools.get(ECHO, agent) === undefined)
    await until(() => !isAlive(pid))
    expect(errors).toEqual([`mcp-workspace: trust file ${trustFile} does not match the expected format at version`])
  })

  it('attaches nothing synchronously when the trust file is invalid', async () => {
    const { ctx, trustFile, workspace, pid, errors } = await preconnected()
    await writeFile(trustFile, 'version: 2\nworkspaces: {}\n')

    const { agent } = await create(ctx, 'recheck-invalid', { cwd: workspace })
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    await until(() => !isAlive(pid))
    await until(() => errors.length === 2)

    // One error from the synchronous attach, one from the asynchronous recheck.
    const message = `mcp-workspace: trust file ${trustFile} does not match the expected format at version`
    expect(errors).toEqual([message, message])
  })

  it('keeps Allow this session tools although the trust file has no entry for the server', async () => {
    const { ctx, trustFile, workspace, pidDir, questions } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })

    const { agent } = await create(ctx, 'recheck-session', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    questions.answer(ALLOW_SESSION)
    await until(() => ctx.tools.get(ECHO, agent) !== undefined)
    await sleep(100)

    expect(ctx.tools.get(ECHO, agent)).toBeDefined()
    expect(await new TrustStore(trustFile).lookup(workspace, 'fixture', fingerprintEntry(entry))).toBeUndefined()
  })

  it('does not attach an Allow this session server when deny is written before its recheck', async () => {
    const { ctx, trust, trustFile, workspace, pidDir, questions } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })

    const { agent } = await create(ctx, 'recheck-session-deny', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    trust.gate = gate.promise
    const started = trust.started
    questions.answer(ALLOW_SESSION)
    await until(() => trust.started === started + 1)
    await deny(trustFile, workspace, entry)
    gate.resolve()
    await until(async () => {
      const running = await pids(pidDir)
      return running.length === 1 && running.every(pid => !isAlive(pid))
    })

    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
  })

  it.each([
    ['deny is written', 'deny'],
    ['the trust file becomes invalid', 'invalid'],
  ] as const)('does not attach a connecting server after %s', async (_label, change) => {
    const { ctx, trust, trustFile, workspace, pidDir, errors } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()

    const { agent } = await create(ctx, `recheck-connecting-${change}`, { cwd: workspace })
    await until(() => trust.completed === 1)
    trust.gate = gate.promise
    await until(() => trust.started === 2)
    if (change === 'deny') await deny(trustFile, workspace, entry)
    else await writeFile(trustFile, 'version: 2\nworkspaces: {}\n')
    gate.resolve()
    await until(async () => (await pids(pidDir)).every(pid => !isAlive(pid)))

    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    expect(errors).toEqual(change === 'deny' ? [] : [`mcp-workspace: trust file ${trustFile} does not match the expected format at version`])
  })
})

describe('WorkspaceBinder disposal', () => {
  it('stops admission when the agent is disposed while .mcp.json is read', async () => {
    const { ctx, trust, workspace, pidDir } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })

    const handle = await create(ctx, 'binder-dispose-read', { cwd: workspace })
    await handle.dispose()
    await sleep(50)

    expect(trust.started).toBe(0)
  })

  it('stops admission when the agent is disposed during trust lookups', async () => {
    const { ctx, trust, workspace, pidDir, questions } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    trust.gate = gate.promise

    const handle = await create(ctx, 'binder-dispose-lookup', { cwd: workspace })
    await until(() => trust.started === 1)
    await handle.dispose()
    gate.resolve()
    await settled(trust, 1)

    expect(questions.requests).toEqual([])
    expect(await pids(pidDir)).toEqual([])
  })

  it('stops admission when the agent is disposed during credential resolution', async () => {
    const { ctx, trust, credentials, workspace, pidDir } = await harness({ credentials: { TOKEN: 'token-value' } })
    const entry = fixtureEntry(pidDir, { MCP_FIXTURE_TOKEN: '${TOKEN}' })
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    credentials.gate = gate.promise

    const handle = await create(ctx, 'binder-dispose-credential', { cwd: workspace })
    await until(() => credentials.resolving === 1)
    await handle.dispose()
    gate.resolve()
    await sleep(50)

    expect(await pids(pidDir)).toEqual([])
  })

  it('does not attach after the agent is disposed while connecting', async () => {
    const { ctx, trust, workspace, pidDir, errors } = await harness()
    const entry = { command: process.execPath, args: [silentPath], env: { MCP_FIXTURE_PID_DIR: pidDir } }
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    const handle = await create(ctx, 'binder-dispose-connect', { cwd: workspace })
    await until(async () => (await pids(pidDir)).length === 1)
    await handle.dispose()
    await until(async () => (await pids(pidDir)).every(pid => !isAlive(pid)))

    expect(errors).toEqual([])
  })

  it('releases every lease on dispose and ignores later agents', async () => {
    const { ctx, trust, binder, workspace, pidDir } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    await Promise.all((await binder.preconnect(workspace)).map(lease => lease.ready))
    const { agent } = await create(ctx, 'binder-dispose-live', { cwd: workspace })
    await settled(trust, 2)

    binder.dispose()
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    await until(async () => (await pids(pidDir)).every(pid => !isAlive(pid)))
    const later = await create(ctx, 'binder-dispose-later', { cwd: workspace })
    await sleep(50)

    expect(ctx.tools.get(ECHO, later.agent)).toBeUndefined()
    // The preconnect lookup and the first agent's recheck.
    expect(trust.started).toBe(2)
    expect(reads.settled).toBe(2)
  })

  it('acquires nothing for a preconnect that completes after dispose', async () => {
    const { trust, binder, workspace, pidDir } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    const preconnect = binder.preconnect(workspace)
    binder.dispose()

    expect(await preconnect).toEqual([])
    expect(await pids(pidDir)).toEqual([])
  })

  it('acquires nothing at preconnect for an undecided server', async () => {
    const { binder, workspace, pidDir } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })

    expect(await binder.preconnect(workspace)).toEqual([])
  })
})
