/**
 * `agent/created` binder for workspace-declared MCP servers. For each eligible
 * agent it reads the canonical cwd's `.mcp.json`, looks up every declared
 * server's stored decision, and mounts one `@deepseek-ai/dsh-mcp-client`
 * instance per admitted server on that agent's own context, so the server's
 * tools, resources, and instructions belong to that agent and are disposed
 * with it. Saved `allow` servers are mounted while the serial `agent/created`
 * listener is awaited, up to `admissionTimeoutMs`; undecided servers are asked
 * about after the listener returns and mounted on a later step.
 * @module @deepseek-ai/dsh-mcp-workspace/binder
 */

import { realpath } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { readMcpJson, substitutePlaceholders } from './mcp-json.ts'
import { TrustStoreError } from './trust-store.ts'
import type { TrustDecision, TrustStore } from './trust-store.ts'
import type { DeclaredServer, McpJsonReadResult, WorkspaceServerEntry } from './types.ts'

/** Question id of the per-workspace server decision. */
export const QUESTION_ID = 'mcp-workspace-servers'
/** Option label that records `allow` for every listed server. */
export const ALLOW_WORKSPACE = 'Allow for this workspace'
/** Option label that admits the listed servers for the asking agent only, recording nothing. */
export const ALLOW_SESSION = 'Allow this session'
/** Option label that records `deny` for every listed server. */
export const DENY = 'Deny'

/** Collaborators and settings a {@link WorkspaceBinder} admits servers through. */
export interface WorkspaceBinderOptions {
  /** Stored per-workspace decisions. */
  readonly trust: TrustStore
  /** Longest `agent/created` waits for saved `allow` servers' first connection attempts, in milliseconds. */
  readonly admissionTimeoutMs: number
  /** Per-tool-call timeout passed to every mounted server. */
  readonly toolCallTimeoutMs: number
  /** Reconnect policy passed to every mounted server; omission uses the `mcp-client` defaults. */
  readonly reconnect?: McpClient.ReconnectConfig
}

/**
 * Settlement of one shared question: `workspace` after `allow` was recorded,
 * `session` for the asking agent only, `aborted` when the asking agent was
 * disposed or the question provider aborted the question, `closed` when
 * nothing is admitted and waiters must not ask again.
 */
type QuestionOutcome = 'workspace' | 'session' | 'aborted' | 'closed'

/** One pending question, shared by every agent waiting on the same workspace path and set of undecided server names and fingerprints. */
interface PendingQuestion {
  readonly asker: Binding
  readonly outcome: Promise<QuestionOutcome>
}

/** One eligible agent's admission state; aborted by the agent's effect cleanup. */
interface Binding {
  readonly agent: Agent
  /** Canonical workspace path. */
  readonly path: string
  /** Aborted when the agent's effect is disposed. */
  readonly controller: AbortController
  /** The `mcp-client` fiber of every server mounted on the agent, by server name. */
  readonly mounted: Map<string, Fiber>
  /** {@link decisionKey}s admitted by Allow this session; they stay admitted while no decision is stored for their fingerprint. */
  readonly sessionAllowed: Set<string>
}

/**
 * Identity of one server decision.
 * @param path - canonical workspace path.
 * @param server - the declared server.
 * @returns the key for `(path, server.name, server.fingerprint)`.
 */
function decisionKey(path: string, server: DeclaredServer): string {
  return JSON.stringify([path, server.name, server.fingerprint])
}

/**
 * Host log text for a failed read, lookup, or record.
 * @param error - the thrown value.
 * @returns the trust store's own message, or the error prefixed with the plugin name.
 */
function failureMessage(error: unknown): string {
  return error instanceof TrustStoreError ? error.message : `mcp-workspace: ${String(error)}`
}

/**
 * Render one untrusted `.mcp.json` string for the question detail.
 * @param value - a command, argument, or URL.
 * @returns `value`, JSON-quoted when it is empty or contains whitespace, a double quote,
 *   or a control character, so it cannot fake or hide detail lines.
 */
function quoteForDetail(value: string): string {
  return value === '' || /[\s"\p{Cc}]/u.test(value) ? JSON.stringify(value) : value
}

/**
 * Render a failure with every resolved credential value replaced by its `${NAME}` placeholder,
 * longest value first so a value containing another is replaced whole.
 * @param error - the caught failure.
 * @param values - resolved credential values by reference name.
 * @returns the failure text without any resolved credential value.
 */
function redact(error: unknown, values: ReadonlyMap<string, string>): string {
  let text = String(error)
  const entries = [...values].filter(([, value]) => value.length > 0).sort(([, a], [, b]) => b.length - a.length)
  for (const [ref, value] of entries) text = text.replaceAll(value, `\${${ref}}`)
  return text
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts.
 * @param promise - the operation to wait for.
 * @param signal - a signal that is not yet aborted.
 * @returns the operation's value.
 */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([promise, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Build the unvalidated `mcp-client` config for one substituted entry.
 * @param path - canonical workspace path; the stdio child's cwd.
 * @param serverName - the `.mcp.json` server name, used as the tool namespace.
 * @param entry - the entry after placeholder substitution.
 * @param options - binder options carrying the timeout and reconnect policy.
 * @returns the `mcp-client` config input.
 */
function clientConfig(path: string, serverName: string, entry: WorkspaceServerEntry, options: WorkspaceBinderOptions): McpClient.Config {
  const { toolCallTimeoutMs, reconnect } = options
  const common = { serverName, toolCallTimeoutMs, failOnStartupError: false, ...reconnect === undefined ? {} : { reconnect } }
  return entry.transport === 'stdio'
    ? { transport: 'stdio', command: entry.command, args: [...entry.args], env: { ...entry.env }, cwd: path, ...common }
    : { transport: 'streamable-http', url: entry.url, headers: { ...entry.headers }, ...common }
}

/** Admits workspace servers to eligible agents behind stored or asked user decisions. */
export class WorkspaceBinder {
  private readonly ctx: Context
  private readonly options: WorkspaceBinderOptions
  private readonly bindings = new Set<Binding>()
  private readonly questions = new Map<string, PendingQuestion>()
  private disposed = false

  /**
   * @param ctx - plugin context carrying `agents` and `credentials`; `userQuestions` is read optionally.
   * @param options - the trust store, admission timeout, and per-server connection settings.
   */
  constructor(ctx: Context, options: WorkspaceBinderOptions) {
    this.ctx = ctx
    this.options = options
  }

  /**
   * Serial `agent/created` handler; never rejects, because a rejecting
   * listener vetoes the agent's publication. A root agent with a cwd starts its
   * admission pass; the returned promise settles once every saved `allow`
   * server's first connection attempt settled, `admissionTimeoutMs` elapsed,
   * or the agent was disposed, whichever is first. Questions about undecided
   * servers continue after it settles.
   * @param agent - the newly published agent.
   */
  async onAgentCreated(agent: Agent): Promise<void> {
    if (this.disposed || !this.ctx.agents.roots().includes(agent)) return
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    let path: string
    try {
      path = await realpath(cwd)
    } catch {
      // Any realpath failure leaves the session without a canonical workspace; nothing is admitted.
      this.ctx.logger.warn(`mcp-workspace: session cwd ${cwd} is not a directory`)
      return
    }
    const binding: Binding = { agent, path, controller: new AbortController(), mounted: new Map(), sessionAllowed: new Set() }
    this.bindings.add(binding)
    agent.ctx.effect(() => () => { this.unbind(binding) }, 'mcp-workspace.binding()')
    const saved = Promise.withResolvers<void>()
    void this.admit(binding, saved.resolve)
      .catch((error: unknown) => { this.ctx.logger.error(failureMessage(error)) })
      .finally(() => {
        saved.resolve()
        this.announceSettled(binding)
      })
    const timeout = new AbortController()
    const stop = AbortSignal.any([timeout.signal, binding.controller.signal])
    try {
      await Promise.race([
        saved.promise,
        delay(this.options.admissionTimeoutMs, undefined, { ref: false, signal: stop }),
      ])
    } catch {
      // AbortError: the agent was disposed while its saved servers were connecting, so creation stops waiting.
    } finally {
      timeout.abort()
    }
  }

  /** Abort every pending admission and question and unmount every server this binder mounted. Later `agent/created` calls do nothing. */
  dispose(): void {
    this.disposed = true
    for (const binding of [...this.bindings]) {
      this.unbind(binding)
      for (const fiber of binding.mounted.values()) void fiber.dispose()
    }
  }

  /**
   * The agent's admission pass: read `.mcp.json`, look up every stored
   * decision, mount saved `allow` servers, report them mounted, then ask about
   * undecided servers. A `.mcp.json` that cannot be read or parsed is logged and
   * declares nothing; a trust document that cannot be read admits nothing.
   * @param binding - the agent binding to admit servers for.
   * @param savedMounted - called once every saved `allow` server's mount settled.
   */
  private async admit(binding: Binding, savedMounted: () => void): Promise<void> {
    const { path } = binding
    let result: McpJsonReadResult | undefined
    try {
      result = await readMcpJson(path)
    } catch (error) {
      this.ctx.logger.error(failureMessage(error))
    }
    if (this.closed(binding) || result === undefined) return
    this.logRefused(result.refused)
    const decisions = await this.lookupAll(path, result.servers)
    if (this.closed(binding)) return
    const allowed = result.servers.filter((_server, index) => decisions[index] === 'allow')
    const undecided = result.servers.filter((_server, index) => decisions[index] === undefined)
    await Promise.all(allowed.map(server => this.mount(binding, server)))
    savedMounted()
    if (undecided.length > 0) await this.decide(binding, undecided)
  }

  /**
   * Look up every server's stored decision before any is acted on, so a trust
   * store failure admits nothing.
   * @param path - canonical workspace path.
   * @param servers - the servers to look up.
   * @returns the decisions in `servers` order.
   * @throws {TrustStoreError} when the trust document cannot be read.
   */
  private async lookupAll(path: string, servers: readonly DeclaredServer[]): Promise<Array<TrustDecision | undefined>> {
    const decisions: Array<TrustDecision | undefined> = []
    for (const server of servers) decisions.push(await this.trust.lookup(path, server.name, server.fingerprint))
    return decisions
  }

  private get trust(): TrustStore {
    return this.options.trust
  }

  /**
   * Resolve a decision for undecided servers through one shared question per
   * path and set of server names and fingerprints, then mount according to the outcome.
   * @param binding - the waiting agent's binding.
   * @param servers - the undecided servers, all declared in `binding.path`.
   */
  private async decide(binding: Binding, servers: readonly DeclaredServer[]): Promise<void> {
    if (binding.agent.session.header.origin === 'subagent') {
      for (const server of servers) this.ctx.logger.warn(`mcp-workspace(${server.name}): not approved`)
      return
    }
    const key = JSON.stringify([binding.path, servers.map(server => JSON.stringify([server.name, server.fingerprint])).sort()])
    for (;;) {
      let question = this.questions.get(key)
      if (question === undefined) {
        // The entry is removed before any waiter observes the outcome, so a waiter that asks again starts a new question.
        const outcome = this.ask(binding, servers).finally(() => { this.questions.delete(key) })
        question = { asker: binding, outcome }
        this.questions.set(key, question)
      }
      const outcome = await question.outcome
      if (this.closed(binding)) return
      const asker = question.asker === binding
      if (outcome === 'workspace' || (outcome === 'session' && asker)) {
        if (outcome === 'session') {
          for (const server of servers) binding.sessionAllowed.add(decisionKey(binding.path, server))
        }
        await Promise.all(servers.map(server => this.mount(binding, server)))
        return
      }
      if (asker || outcome === 'closed') return
    }
  }

  /**
   * Ask the user about undecided servers and record a workspace decision.
   * @param binding - the asking agent's binding; its disposal aborts the question.
   * @param servers - the undecided servers.
   * @returns the question outcome; never rejects.
   */
  private async ask(binding: Binding, servers: readonly DeclaredServer[]): Promise<QuestionOutcome> {
    const questions = this.ctx.get('userQuestions')
    if (questions === undefined) return this.noQuestionUi(servers)
    const { path, agent, controller: { signal } } = binding
    let answer: AskUserQuestionAnswer
    try {
      const detail = (await Promise.all(servers.map(server => this.describeServer(server)))).join('\n')
      answer = await abortable(questions.ask({
        questions: [{
          id: QUESTION_ID,
          header: 'MCP servers',
          question: `Allow MCP servers declared in ${path}/.mcp.json?`,
          detail,
          options: [{ label: ALLOW_WORKSPACE }, { label: ALLOW_SESSION }, { label: DENY }],
        }],
        agent,
        signal,
      }), signal)
    } catch (error) {
      // A provider may reject with any value, including a nullish one.
      const code = (error as { code?: unknown } | null | undefined)?.code
      if (signal.aborted || code === 'ASK_ABORTED') return 'aborted'
      if (code === 'NO_PROVIDER') return this.noQuestionUi(servers)
      this.ctx.logger.error(`mcp-workspace: question failed: ${String(error)}`)
      return 'closed'
    }
    switch (answer.answers.find(item => item.id === QUESTION_ID)?.selected[0]) {
      case ALLOW_WORKSPACE:
        return await this.recordAll(path, servers, 'allow') ? 'workspace' : 'closed'
      case ALLOW_SESSION:
        return 'session'
      case DENY:
        await this.recordAll(path, servers, 'deny')
        return 'closed'
      default:
        for (const server of servers) this.ctx.logger.warn(`mcp-workspace(${server.name}): not approved`)
        return 'closed'
    }
  }

  /**
   * Log that undecided servers are skipped because the surface has no question UI.
   * @param servers - the undecided servers.
   * @returns `closed`.
   */
  private noQuestionUi(servers: readonly DeclaredServer[]): QuestionOutcome {
    for (const server of servers) {
      this.ctx.logger.warn(`mcp-workspace(${server.name}): not approved; no question UI is available`)
    }
    return 'closed'
  }

  /**
   * Record one decision for every server; a failure is logged.
   * @param path - canonical workspace path.
   * @param servers - the servers the decision covers.
   * @param decision - the decision to record.
   * @returns whether the record committed.
   */
  private async recordAll(path: string, servers: readonly DeclaredServer[], decision: TrustDecision): Promise<boolean> {
    try {
      const decisions = servers.map(server => ({ serverName: server.name, decision, fingerprint: server.fingerprint }))
      await this.trust.record(path, decisions, new Date())
    } catch (error) {
      this.ctx.logger.error(failureMessage(error))
      return false
    }
    return true
  }

  /**
   * One `detail` line of the decision question; credential status never includes a value.
   * @param server - the server to describe.
   * @returns `- <name> (<stdio|http>): <command and args | url>`, each value
   *   rendered by {@link quoteForDetail}, followed by
   *   `; credentials: <REF> set|missing, …` when the entry references credentials.
   */
  private async describeServer(server: DeclaredServer): Promise<string> {
    const { entry } = server
    const target = entry.transport === 'stdio'
      ? `stdio): ${[entry.command, ...entry.args].map(quoteForDetail).join(' ')}`
      : `http): ${quoteForDetail(entry.url)}`
    const credentials = await Promise.all(server.credentialRefs.map(async (ref) => {
      const { configured } = await this.ctx.credentials.describe(credentialRef(ref))
      return `${ref} ${configured ? 'set' : 'missing'}`
    }))
    const suffix = credentials.length === 0 ? '' : `; credentials: ${credentials.join(', ')}`
    return `- ${server.name} (${target}${suffix}`
  }

  /**
   * Resolve one admitted server's credentials, recheck its stored decision, and
   * mount an `mcp-client` instance for it on the agent's context. The mount
   * settles after the server's first connection attempt; a failed attempt
   * leaves the instance reconnecting. Every failure is logged with resolved
   * credential values redacted.
   * @param binding - the agent binding.
   * @param server - the admitted server.
   */
  private async mount(binding: Binding, server: DeclaredServer): Promise<void> {
    const values = await this.resolveCredentials(server)
    if (values === undefined || this.closed(binding)) return
    if (!await this.recheck(binding, server) || this.closed(binding)) return
    const label = `mcp-workspace(${server.name})`
    let config: McpClient.Config
    try {
      config = McpClient.Config(clientConfig(binding.path, server.name, substitutePlaceholders(server.entry, values), this.options))
    } catch (error) {
      this.ctx.logger.warn(`${label}: invalid server config: ${redact(error, values)}`)
      return
    }
    // The saved-allow and undecided sets are disjoint, so a second mount of one name comes only from a repeated admission.
    if (binding.mounted.has(server.name)) return
    const fiber = binding.agent.ctx.plugin(McpClient, config)
    binding.mounted.set(server.name, fiber)
    try {
      await fiber
    } catch (error) {
      this.ctx.logger.error(`${label}: failed to mount: ${redact(error, values)}`)
    }
  }

  /**
   * Read the stored decision for a server the agent is about to mount; a trust store failure is logged.
   * @param binding - the agent binding.
   * @param server - the server to recheck.
   * @returns whether a stored `allow`, or with no stored decision the agent's Allow this session, admits the server.
   */
  private async recheck(binding: Binding, server: DeclaredServer): Promise<boolean> {
    let decision: TrustDecision | undefined
    try {
      decision = await this.trust.lookup(binding.path, server.name, server.fingerprint)
    } catch (error) {
      this.ctx.logger.error(failureMessage(error))
      return false
    }
    // A stored decision wins over Allow this session, because it is the user's newest decision.
    return decision === 'allow' || (decision === undefined && binding.sessionAllowed.has(decisionKey(binding.path, server)))
  }

  /**
   * Read at each resumption point: the agent's effect cleanup may have run during the preceding await.
   * @param binding - the agent binding.
   * @returns whether the agent's effect was disposed.
   */
  private closed(binding: Binding): boolean {
    return binding.controller.signal.aborted
  }

  /**
   * Emit `mcp-workspace/binding-settled` for a binding whose admission pass
   * settled, unless the binder is disposed. Cordis `emit` does not contain
   * listener exceptions and nothing awaits the pass, so a throwing listener is
   * logged here.
   * @param binding - the settled binding.
   */
  private announceSettled(binding: Binding): void {
    if (this.disposed) return
    try {
      this.ctx.emit('mcp-workspace/binding-settled', { agent: binding.agent })
    } catch (error) {
      this.ctx.logger.error(`mcp-workspace: binding-settled listener failed: ${String(error)}`)
    }
  }

  /**
   * Resolve every credential reference of a server.
   * @param server - the server whose references to resolve.
   * @returns the resolved values by reference name, or `undefined` after logging the first unset reference.
   */
  private async resolveCredentials(server: DeclaredServer): Promise<Map<string, string> | undefined> {
    const values = new Map<string, string>()
    for (const ref of server.credentialRefs) {
      const resolved = await this.ctx.credentials.resolve(credentialRef(ref))
      if (resolved === undefined) {
        this.ctx.logger.warn(`mcp-workspace(${server.name}): credential ${ref} is not set`)
        return undefined
      }
      values.set(ref, resolved.value)
    }
    return values
  }

  /**
   * Agent effect cleanup: abort pending work. The agent's context disposes its mounted servers.
   * @param binding - the binding to close.
   */
  private unbind(binding: Binding): void {
    this.bindings.delete(binding)
    binding.controller.abort()
  }

  /**
   * Log every server `.mcp.json` refused.
   * @param refused - the refused servers with their reasons, which never contain a field value.
   */
  private logRefused(refused: ReadonlyArray<{ name: string; reason: string }>): void {
    for (const server of refused) this.ctx.logger.warn(`mcp-workspace(${server.name}): ${server.reason}`)
  }
}
