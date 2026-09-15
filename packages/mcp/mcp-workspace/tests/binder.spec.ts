import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { ALLOW_SESSION, ALLOW_WORKSPACE, DENY, QUESTION_ID, WorkspaceBinder } from '../src/binder.ts'
import { fingerprintEntry } from '../src/mcp-json.ts'
import { TrustStore } from '../src/trust-store.ts'
import type * as McpJson from '../src/mcp-json.ts'

const reads = vi.hoisted(() => ({ settled: 0, gate: Promise.resolve() }))

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

/** A trust store whose lookups are counted. */
class CountingTrust extends TrustStore {
  started = 0
  completed = 0

  override async lookup(workspacePath: string, serverName: string, fingerprint: string): Promise<'allow' | 'deny' | undefined> {
    this.started += 1
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
  /** Called synchronously inside each request. */
  onAsk?: (request: AskUserQuestionRequest) => void
  /** Settle the oldest unsettled question with one selected label, or with no answer for `QUESTION_ID`. */
  answer(label?: string): void
  /** Reject the oldest unsettled question with `error`, which may be any value. */
  fail(error: unknown): void
}

interface HarnessOptions {
  readonly credentials?: Record<string, string>
  /** `provider` mounts the service with a scripted answerer; `service` mounts it without one; `none` omits it. */
  readonly questions?: 'provider' | 'service' | 'none'
  readonly admissionTimeoutMs?: number
  readonly reconnect?: McpClient.ReconnectConfig
  /** A serial `agent/created` listener registered before the binder's. */
  readonly beforeBinder?: (agent: Agent) => Promise<void>
}

interface Harness {
  readonly ctx: Context
  readonly trust: CountingTrust
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
  /** Agents whose admission pass settled, in order. */
  readonly settled: Agent[]
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
  await ctx.plugin(GatedCredentials, options.credentials ?? {})
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 8 }, () => textResponse('done'))))
  const questions = await mountQuestions(ctx, options.questions ?? 'provider')
  const trustFile = join(root, 'home', 'mcp-trust.yaml')
  const trust = new CountingTrust(trustFile)
  const binder = new WorkspaceBinder(ctx, {
    trust,
    admissionTimeoutMs: options.admissionTimeoutMs ?? 10_000,
    toolCallTimeoutMs: 15_000,
    reconnect: options.reconnect ?? { enabled: false },
  })
  cleanups.push(async () => { binder.dispose() })
  const { beforeBinder } = options
  if (beforeBinder !== undefined) ctx.on('agent/created', ({ agent }) => beforeBinder(agent).then(() => undefined))
  ctx.on('agent/created', ({ agent }) => binder.onAgentCreated(agent).then(() => undefined))
  const settled: Agent[] = []
  ctx.on('mcp-workspace/binding-settled', ({ agent }) => { settled.push(agent) })
  return {
    ctx,
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
    settled,
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
  ctx.on('user-questions/request', (request) => {
    questions.requests.push(request)
    const settle = Promise.withResolvers<AskUserQuestionAnswer>()
    pending.push(settle)
    request.signal?.addEventListener('abort', () => {
      const index = pending.indexOf(settle)
      if (index >= 0) pending.splice(index, 1)
      settle.reject(new UserQuestionError('aborted', 'ASK_ABORTED'))
    }, { once: true })
    questions.onAsk?.(request)
    return settle.promise
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

function headerTools(agent: Agent): Array<{ reason: string; tools: string[] }> {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'request/header'
    ? [{ reason: event.data.reason, tools: (event.data.header.tools ?? []).map(tool => tool.name) }]
    : [])
}

async function pids(dir: string): Promise<number[]> {
  return (await readdir(dir)).map(Number)
}

async function livePids(dir: string): Promise<number[]> {
  return (await pids(dir)).filter(isAlive)
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

/** A command, argument, or URL as the question detail shows it; host install paths can contain spaces. */
function shown(value: string): string {
  return value === '' || /[\s"\p{Cc}]/u.test(value) ? JSON.stringify(value) : value
}

describe('WorkspaceBinder first-step visibility', () => {
  it('lists a saved-allow server tool in the initial request header', async () => {
    const { ctx, trust, workspace, pidDir } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-first-step', { cwd: workspace })
    expect(ctx.tools.get(ECHO, agent)).toBeDefined()
    await runTurn(ctx, agent)

    expect(headerTools(agent)[0]).toEqual({ reason: 'initial', tools: [ECHO] })
    expect(await livePids(pidDir)).toHaveLength(1)
  })

  it('stops waiting for a saved-allow server after admissionTimeoutMs', async () => {
    const { ctx, trust, workspace, pidDir } = await harness({ admissionTimeoutMs: 300 })
    const entry = { command: process.execPath, args: [silentPath], env: { MCP_FIXTURE_PID_DIR: pidDir } }
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    const started = performance.now()
    const { agent } = await create(ctx, 'binder-admission-timeout', { cwd: workspace })
    const elapsed = performance.now() - started
    await runTurn(ctx, agent)

    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(5_000)
    expect(headerTools(agent)[0]).toEqual({ reason: 'initial', tools: [] })
  })
})

describe('WorkspaceBinder per-agent servers', () => {
  it('starts one child per agent and stops only the disposed agent\'s child', async () => {
    const { ctx, trust, workspace, pidDir } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    const first = await create(ctx, 'binder-per-agent-first', { cwd: workspace })
    const second = await create(ctx, 'binder-per-agent-second', { cwd: workspace })
    await until(async () => (await livePids(pidDir)).length === 2)
    await first.dispose()

    await until(async () => (await livePids(pidDir)).length === 1)
    expect(ctx.tools.get(ECHO, second.agent)).toBeDefined()
  })

  it('unmounts every server on dispose and ignores later agents', async () => {
    const { ctx, trust, binder, workspace, pidDir } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    const { agent } = await create(ctx, 'binder-dispose', { cwd: workspace })
    expect(ctx.tools.get(ECHO, agent)).toBeDefined()
    const lookups = trust.started

    binder.dispose()
    await until(() => ctx.tools.get(ECHO, agent) === undefined)
    await until(async () => (await livePids(pidDir)).length === 0)
    const later = await create(ctx, 'binder-dispose-later', { cwd: workspace })

    expect(ctx.tools.get(ECHO, later.agent)).toBeUndefined()
    expect(trust.started).toBe(lookups)
  })

  it('logs a server whose mount fails without failing agent creation', async () => {
    const { ctx, trust, workspace, pidDir, errors } = await harness({
      credentials: { TOKEN: 'token-value' },
      // An ACP-style mount of the same server name on the agent reserves the namespace first.
      beforeBinder: async (agent) => {
        await agent.ctx.plugin(McpClient, McpClient.Config({ transport: 'stdio', serverName: 'fixture', command: process.execPath, args: [fixturePath] }))
      },
    })
    const entry = fixtureEntry(pidDir, { MCP_FIXTURE_TOKEN: '${TOKEN}' })
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-mount-failed', { cwd: workspace })

    // Cordis also logs the rejected mcp-client activation itself.
    const logged = errors.filter(message => message.startsWith('mcp-workspace'))
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/^mcp-workspace\(fixture\): failed to mount: .*"fixture" is already in use/)
    expect(errors.join('\n')).not.toContain('token-value')
    expect(ctx.tools.get(ECHO, agent)).toBeDefined()
  })

  it('warns about a server config the mcp-client schema rejects', async () => {
    const { ctx, trust, workspace, pidDir, warns } = await harness({ reconnect: { enabled: true, initialDelayMs: 0 } })
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-invalid-config', { cwd: workspace })

    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/^mcp-workspace\(fixture\): invalid server config: /)
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    expect(await pids(pidDir)).toEqual([])
  })
})

describe('WorkspaceBinder eligibility', () => {
  it('gives a one-shot child of a root agent no workspace tools', async () => {
    const { ctx, trust, workspace, pidDir } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    const parent = await create(ctx, 'binder-parent', { cwd: workspace })
    const child = await ctx.agents.create({
      sessionId: SessionId('binder-one-shot'),
      parentAgent: parent.agent,
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    expect(ctx.tools.get(ECHO, parent.agent)).toBeDefined()
    // The parent's lookup and recheck; the child is not eligible and starts no server of its own.
    expect(trust.started).toBe(2)
    expect(await livePids(pidDir)).toHaveLength(1)
    await child.dispose()
  })

  it('mounts allowed servers on a subagent-origin root without asking about undecided ones', async () => {
    const { ctx, trust, workspace, pidDir, questions, warns, settled } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry, second: fixtureEntry(pidDir, { SECOND: '1' }) })
    await allow(trust, workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-continuable', { cwd: workspace, origin: 'subagent' })
    await until(() => settled.includes(agent))

    expect(ctx.tools.get(ECHO, agent)).toBeDefined()
    expect(questions.requests).toEqual([])
    expect(warns).toEqual(['mcp-workspace(second): not approved'])
    expect(ctx.tools.get('mcp__second__echo', agent)).toBeUndefined()
  })

  it('ignores an agent without a cwd and warns for a cwd that is not a directory', async () => {
    const { ctx, trust, root, warns } = await harness()
    await create(ctx, 'binder-no-cwd')
    const missing = join(root, 'missing')
    await create(ctx, 'binder-missing-cwd', { cwd: missing })

    expect(trust.started).toBe(0)
    expect(warns).toEqual([`mcp-workspace: session cwd ${missing} is not a directory`])
  })

  it('admits nothing for a workspace without .mcp.json', async () => {
    const { ctx, trust, workspace, questions, warns, errors, settled } = await harness()
    const { agent } = await create(ctx, 'binder-no-file', { cwd: workspace })
    await until(() => settled.includes(agent))

    expect(trust.started).toBe(0)
    expect(questions.requests).toEqual([])
    expect([...warns, ...errors]).toEqual([])
  })
})

describe('WorkspaceBinder decisions', () => {
  it('records Allow for this workspace, mounts for the next step, and mounts a later session from its first step', async () => {
    const { ctx, trustFile, workspace, pidDir, questions } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-allow-workspace', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    expect(questions.requests[0]?.agent).toBe(agent)
    expect(questions.requests[0]?.questions[0]).toMatchObject({
      id: QUESTION_ID,
      header: 'MCP servers',
      question: `Allow MCP servers declared in ${workspace}/.mcp.json?`,
      options: [{ label: ALLOW_WORKSPACE }, { label: ALLOW_SESSION }, { label: DENY }],
    })
    questions.answer(ALLOW_WORKSPACE)
    await until(() => ctx.tools.get(ECHO, agent) !== undefined)

    expect(await new TrustStore(trustFile).lookup(workspace, 'fixture', fingerprintEntry(entry))).toBe('allow')
    const later = await create(ctx, 'binder-allow-workspace-later', { cwd: workspace })
    expect(ctx.tools.get(ECHO, later.agent)).toBeDefined()
    expect(questions.requests).toHaveLength(1)
  })

  it('mounts Allow this session on the asking agent only and records nothing', async () => {
    const { ctx, trust, workspace, pidDir, questions } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-allow-session', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    questions.answer(ALLOW_SESSION)
    await until(() => ctx.tools.get(ECHO, agent) !== undefined)
    expect(await trust.lookup(workspace, 'fixture', fingerprintEntry(entry))).toBeUndefined()

    const later = await create(ctx, 'binder-allow-session-later', { cwd: workspace })
    await until(() => questions.requests.length === 2)
    expect(questions.requests[1]?.agent).toBe(later.agent)
    expect(ctx.tools.get(ECHO, later.agent)).toBeUndefined()
  })

  it('records Deny and does not ask a later session', async () => {
    const { ctx, trust, workspace, pidDir, questions, settled } = await harness()
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-deny', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    questions.answer(DENY)
    await until(() => settled.includes(agent))
    expect(await trust.lookup(workspace, 'fixture', fingerprintEntry(entry))).toBe('deny')

    const later = await create(ctx, 'binder-deny-later', { cwd: workspace })
    await until(() => settled.includes(later.agent))
    expect(questions.requests).toHaveLength(1)
    expect(await pids(pidDir)).toEqual([])
  })

  it('asks once for concurrent sessions in one workspace and mounts on both after Allow for this workspace', async () => {
    const { ctx, trust, workspace, pidDir, questions } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })

    const handles = await Promise.all([
      create(ctx, 'binder-concurrent-first', { cwd: workspace }),
      create(ctx, 'binder-concurrent-second', { cwd: workspace }),
    ])
    await until(() => questions.requests.length === 1 && trust.completed === 2)
    await sleep(50)
    questions.answer(ALLOW_WORKSPACE)

    await until(() => handles.every(handle => ctx.tools.get(ECHO, handle.agent) !== undefined))
    expect(questions.requests).toHaveLength(1)
    await until(async () => (await livePids(pidDir)).length === 2)
  })

  it('aborts the question when the asking agent is disposed and lets the waiter ask again', async () => {
    const { ctx, trust, workspace, pidDir, questions, errors } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })

    const handles = await Promise.all([
      create(ctx, 'binder-abort-first', { cwd: workspace }),
      create(ctx, 'binder-abort-second', { cwd: workspace }),
    ])
    await until(() => questions.requests.length === 1 && trust.completed === 2)
    await sleep(50)
    const asker = handles.find(handle => handle.agent === questions.requests[0]!.agent)!
    const waiter = handles.find(handle => handle !== asker)!
    await asker.dispose()
    await until(() => questions.requests.length === 2)

    expect(questions.requests[1]?.agent).toBe(waiter.agent)
    expect(errors).toEqual([])
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
      `- fixture (stdio): ${shown(process.execPath)} ${shown(fixturePath)}`,
    ].join('\n'))
    expect(detail).not.toContain('secret-key-value')
  })

  it('quotes a command, argument, or URL that is empty or contains whitespace, a double quote, or a control character', async () => {
    const { ctx, workspace, questions, trustFile } = await harness()
    const spoof = { command: 'node', args: ['server.js', 'two words', 'x\n- fake (stdio): trusted', '', 'say "hi"'] }
    const api = { type: 'http', url: 'https://mcp.example.invalid/a\tb' }
    await writeMcpJson(workspace, { api, spoof })

    await create(ctx, 'binder-detail-quoted', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    const detail = questions.requests[0]?.questions[0]?.detail
    questions.answer(DENY)
    await until(async () => await new TrustStore(trustFile).lookup(workspace, 'spoof', fingerprintEntry(spoof)) === 'deny')

    expect(detail).toBe([
      '- api (http): "https://mcp.example.invalid/a\\tb"',
      '- spoof (stdio): node server.js "two words" "x\\n- fake (stdio): trusted" "" "say \\"hi\\""',
    ].join('\n'))
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

  it('lets the next session ask after the question provider rejects without a reason', async () => {
    const { ctx, workspace, pidDir, questions, errors } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })

    await create(ctx, 'binder-reject-first', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    questions.fail(undefined)
    await until(() => errors.length === 1)
    const second = await create(ctx, 'binder-reject-second', { cwd: workspace })
    await until(() => questions.requests.length === 2)

    expect(questions.requests[1]?.agent).toBe(second.agent)
    expect(errors).toEqual(['mcp-workspace: question failed: undefined'])
  })

  it('lets the waiter ask again without logging when the provider aborts a question the asker did not abort', async () => {
    const { ctx, trust, workspace, pidDir, questions, errors } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })

    const handles = await Promise.all([
      create(ctx, 'binder-provider-abort-first', { cwd: workspace }),
      create(ctx, 'binder-provider-abort-second', { cwd: workspace }),
    ])
    await until(() => questions.requests.length === 1 && trust.completed === 2)
    await sleep(50)
    const waiter = handles.find(handle => handle.agent !== questions.requests[0]!.agent)!
    questions.fail(new UserQuestionError('provider disposed', 'ASK_ABORTED'))
    await until(() => questions.requests.length === 2)

    expect(questions.requests[1]?.agent).toBe(waiter.agent)
    expect(errors).toEqual([])
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

  it('does not mount an Allow this session server when deny is written before its recheck', async () => {
    const { ctx, workspace, pidDir, questions, credentials, trustFile, settled } = await harness({ credentials: { TOKEN: 'token-value' } })
    const entry = fixtureEntry(pidDir, { MCP_FIXTURE_TOKEN: '${TOKEN}' })
    await writeMcpJson(workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-session-then-deny', { cwd: workspace })
    await until(() => questions.requests.length === 1)
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    credentials.gate = gate.promise
    questions.answer(ALLOW_SESSION)
    await until(() => credentials.resolving === 1)
    await new TrustStore(trustFile).record(workspace, [{ serverName: 'fixture', decision: 'deny', fingerprint: fingerprintEntry(entry) }], new Date())
    gate.resolve()
    await until(() => settled.includes(agent))

    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    expect(await pids(pidDir)).toEqual([])
  })

  it.each([
    ['without a provider', 'service'],
    ['without the question service', 'none'],
  ] as const)('logs undecided servers as not approved %s', async (_label, mode) => {
    const { ctx, trust, workspace, pidDir, warns, settled } = await harness({ questions: mode })
    const entry = fixtureEntry(pidDir)
    await writeMcpJson(workspace, { fixture: entry })

    const { agent } = await create(ctx, `binder-no-ui-${mode}`, { cwd: workspace })
    await until(() => settled.includes(agent))

    expect(warns).toEqual(['mcp-workspace(fixture): not approved; no question UI is available'])
    expect(await trust.lookup(workspace, 'fixture', fingerprintEntry(entry))).toBeUndefined()
  })
})

describe('WorkspaceBinder failures', () => {
  it('logs a refused literal secret by field without its value', async () => {
    const { ctx, workspace, pidDir, questions, warns, settled } = await harness()
    await writeMcpJson(workspace, { leaky: fixtureEntry(pidDir, { API_TOKEN: 'literal-token-value' }) })

    const { agent } = await create(ctx, 'binder-refused', { cwd: workspace })
    await until(() => settled.includes(agent))

    expect(warns).toEqual(['mcp-workspace(leaky): literal secret in env.API_TOKEN'])
    expect(warns.join('\n')).not.toContain('literal-token-value')
    expect(questions.requests).toEqual([])
  })

  it('admits nothing when the trust file cannot be read', async () => {
    const { ctx, workspace, pidDir, questions, errors, trustFile } = await harness()
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })
    await mkdir(join(trustFile, '..'), { recursive: true })
    await writeFile(trustFile, 'version: 2\nworkspaces: {}\n')

    const { agent } = await create(ctx, 'binder-trust-error', { cwd: workspace })

    expect(errors).toEqual([`mcp-workspace: trust file ${trustFile} does not match the expected format at version`])
    expect(questions.requests).toEqual([])
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
  })

  it('logs an unreadable .mcp.json', async () => {
    const { ctx, workspace, errors } = await harness()
    await writeFile(join(workspace, '.mcp.json'), '{')

    await create(ctx, 'binder-bad-json', { cwd: workspace })

    expect(errors).toEqual([`mcp-workspace: McpJsonError: ${join(workspace, '.mcp.json')}: invalid JSON`])
  })

  it('skips an allowed server whose credential is not set', async () => {
    const { ctx, trust, workspace, pidDir, warns } = await harness()
    const entry = fixtureEntry(pidDir, { MCP_FIXTURE_TOKEN: '${TOKEN}' })
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-missing-credential', { cwd: workspace })

    expect(warns).toEqual(['mcp-workspace(fixture): credential TOKEN is not set'])
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

    expect(errors).toEqual(['mcp-workspace: Error: credential store unavailable'])
    expect(ctx.tools.get(ECHO, agent)).toBeUndefined()
    expect(await pids(pidDir)).toEqual([])
  })

  it('passes a resolved credential into the server environment', async () => {
    const { ctx, trust, workspace, pidDir } = await harness({ credentials: { TOKEN: 'token-value' } })
    const entry = fixtureEntry(pidDir, { MCP_FIXTURE_EXPECT_TOKEN: '${TOKEN}', MCP_FIXTURE_TOKEN: '${TOKEN}' })
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })

    const { agent } = await create(ctx, 'binder-credential', { cwd: workspace })

    expect(ctx.tools.get('mcp__fixture__token', agent)).toBeDefined()
  })
})

describe('WorkspaceBinder settlement event', () => {
  it('emits binding-settled with the agent once its admission pass settles', async () => {
    const { ctx, workspace, pidDir, warns, settled } = await harness({ questions: 'none' })
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })

    const { agent } = await create(ctx, 'binder-settled', { cwd: workspace })
    await until(() => settled.length === 1)

    expect(settled).toEqual([agent])
    expect(warns).toEqual(['mcp-workspace(fixture): not approved; no question UI is available'])
  })

  it('logs a binding-settled listener that throws', async () => {
    const { ctx, workspace, errors } = await harness()
    ctx.on('mcp-workspace/binding-settled', () => { throw new Error('listener broke') })

    await create(ctx, 'binder-settled-throws', { cwd: workspace })
    await until(() => errors.length === 1)

    expect(errors).toEqual(['mcp-workspace: binding-settled listener failed: Error: listener broke'])
  })

  it('does not emit binding-settled for a pass that settles after the binder is disposed', async () => {
    const { ctx, binder, workspace, pidDir, settled } = await harness({ admissionTimeoutMs: 50 })
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    reads.gate = gate.promise

    await create(ctx, 'binder-settled-disposed', { cwd: workspace })
    binder.dispose()
    gate.resolve()
    await until(() => reads.settled === 1)
    await sleep(50)

    expect(settled).toEqual([])
  })
})

describe('WorkspaceBinder agent disposal', () => {
  it('stops admission when the agent is disposed while .mcp.json is read', async () => {
    const { ctx, trust, workspace, pidDir, questions } = await harness({ admissionTimeoutMs: 50 })
    await writeMcpJson(workspace, { fixture: fixtureEntry(pidDir) })
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    reads.gate = gate.promise

    const handle = await create(ctx, 'binder-disposed-reading', { cwd: workspace })
    await handle.dispose()
    gate.resolve()
    await until(() => reads.settled === 1)
    await sleep(50)

    expect(trust.started).toBe(0)
    expect(questions.requests).toEqual([])
  })

  it('mounts nothing when the agent is disposed during credential resolution', async () => {
    const { ctx, trust, credentials, workspace, pidDir, settled } = await harness({ admissionTimeoutMs: 50, credentials: { TOKEN: 'token-value' } })
    const entry = fixtureEntry(pidDir, { MCP_FIXTURE_TOKEN: '${TOKEN}' })
    await writeMcpJson(workspace, { fixture: entry })
    await allow(trust, workspace, { fixture: entry })
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    credentials.gate = gate.promise

    const handle = await create(ctx, 'binder-disposed-resolving', { cwd: workspace })
    await until(() => credentials.resolving === 1)
    await handle.dispose()
    gate.resolve()
    await until(() => settled.includes(handle.agent))

    expect(await pids(pidDir)).toEqual([])
  })
})
