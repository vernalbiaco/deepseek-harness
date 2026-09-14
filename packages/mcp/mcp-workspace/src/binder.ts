/**
 * `agent/created` binder for workspace-declared MCP servers. An eligible agent
 * receives, synchronously, the tools of every server the binder already holds
 * a saved `allow` connection for in its canonical cwd that the cwd's
 * `.mcp.json` still declares; admission of the declared servers, trust
 * lookups, credential checks, and user questions run afterwards and attach
 * their results on a later step. Every attachment rechecks `.mcp.json` and the
 * stored decision: a server the file no longer declares or the decision no
 * longer admits is withdrawn from the agent and its plugin-held preconnect
 * reference released. Every lease an agent holds is released by that agent's
 * own effect cleanup.
 * @module @deepseek-ai/dsh-mcp-workspace/binder
 */

import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { readMcpJson, readMcpJsonSync } from './mcp-json.ts'
import type { ServerLease, WorkspacePool } from './pool.ts'
import { TrustStoreError } from './trust-store.ts'
import type { TrustDecision, TrustStore } from './trust-store.ts'
import type { DeclaredServer, McpJsonReadResult } from './types.ts'

/** Question id of the per-workspace server decision. */
export const QUESTION_ID = 'mcp-workspace-servers'
/** Option label that records `allow` for every listed server. */
export const ALLOW_WORKSPACE = 'Allow for this workspace'
/** Option label that admits the listed servers for the asking agent only, recording nothing. */
export const ALLOW_SESSION = 'Allow this session'
/** Option label that records `deny` for every listed server. */
export const DENY = 'Deny'

/** Collaborators a {@link WorkspaceBinder} admits servers through. */
export interface WorkspaceBinderDeps {
  /** Shared connection pool; the binder acquires every lease it attaches from it. */
  readonly pool: WorkspacePool
  /** Stored per-workspace decisions. */
  readonly trust: TrustStore
}

/**
 * Settlement of one shared question: `workspace` after `allow` was recorded,
 * `session` for the asking agent only, `aborted` when the asking agent was
 * disposed, `closed` when nothing is admitted and waiters must not ask again.
 */
type QuestionOutcome = 'workspace' | 'session' | 'aborted' | 'closed'

/** One pending question, shared by every agent waiting on the same workspace path and fingerprint set. */
interface PendingQuestion {
  readonly asker: Binding
  readonly outcome: Promise<QuestionOutcome>
}

/** A lease one agent owns. */
interface OwnedLease {
  readonly lease: ServerLease
  /** Present once the lease is attached to the agent. */
  detach?: () => void
}

/** One eligible agent's admission state; its effect cleanup releases every owned lease. */
interface Binding {
  readonly agent: Agent
  /** Canonical workspace path. */
  readonly path: string
  /** Aborted when the agent's effect is disposed. */
  readonly controller: AbortController
  /** Owned leases keyed by {@link leaseKey}; an agent holds at most one lease per key. */
  readonly leases: Map<string, OwnedLease>
  /** {@link leaseKey}s admitted by Allow this session; they stay admitted without a stored `allow`. */
  readonly sessionAllowed: Set<string>
}

/**
 * Identity of one pooled connection.
 * @param path - canonical workspace path.
 * @param server - the declared server.
 * @returns the pool key for `(path, server.name, server.fingerprint)`.
 */
function leaseKey(path: string, server: DeclaredServer): string {
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

/** Admits workspace servers to eligible agents behind stored or asked user decisions. */
export class WorkspaceBinder {
  private readonly ctx: Context
  private readonly pool: WorkspacePool
  private readonly trust: TrustStore
  /** Live bindings and the disposer of each binding's agent effect. */
  private readonly bindings = new Map<Binding, () => Promise<void>>()
  /** Per canonical path: connections admitted by a saved `allow`, keyed by {@link leaseKey}, with the leases holding them. */
  private readonly shared = new Map<string, Map<string, { server: DeclaredServer; holders: Set<ServerLease> }>>()
  /** Plugin-owned preconnect leases. */
  private readonly held = new Set<ServerLease>()
  private readonly questions = new Map<string, PendingQuestion>()
  /** `(path, server)` pairs already warned about a global tool of the same name. */
  private readonly shadowWarnings = new Set<string>()
  private disposed = false

  /**
   * @param ctx - plugin context carrying `agents`, `tools`, and `credentials`; `userQuestions` is read optionally.
   * @param deps - the pool and trust store the binder admits servers through.
   */
  constructor(ctx: Context, deps: WorkspaceBinderDeps) {
    this.ctx = ctx
    this.pool = deps.pool
    this.trust = deps.trust
  }

  /**
   * Synchronous `agent/created` handler; never throws, because a throwing
   * listener vetoes the agent's publication. A top-level agent with a cwd
   * receives the published tools of every shared connection held for its
   * canonical cwd that the cwd's `.mcp.json` still declares and whose stored
   * decision is still `allow`, both read synchronously, before this returns;
   * the asynchronous admission and recheck of the declared servers starts
   * afterwards.
   * @param agent - the newly published agent.
   */
  onAgentCreated(agent: Agent): void {
    if (this.disposed || !this.ctx.agents.roots().includes(agent)) return
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    let path: string
    try {
      path = realpathSync.native(cwd)
    } catch {
      // Any realpath failure leaves the session without a canonical workspace; nothing is admitted.
      this.ctx.logger.warn(`mcp-workspace: session cwd ${cwd} is not a directory`)
      return
    }
    const binding: Binding = { agent, path, controller: new AbortController(), leases: new Map(), sessionAllowed: new Set() }
    this.bindings.set(binding, agent.ctx.effect(() => () => { this.unbind(binding) }, 'mcp-workspace.binding()'))
    this.attachShared(binding)
    void this.bind(binding).catch((error: unknown) => { this.ctx.logger.error(failureMessage(error)) })
  }

  /**
   * Read `.mcp.json` for a path and acquire plugin-owned leases for servers
   * with a saved `allow` whose credentials are set. Failures are logged; the
   * returned promise never rejects.
   * @param workspacePath - workspace directory in any path spelling; canonicalized before use.
   * @returns the leases acquired, held until {@link dispose}.
   */
  async preconnect(workspacePath: string): Promise<readonly ServerLease[]> {
    const leases: ServerLease[] = []
    try {
      const path = await realpath(workspacePath)
      const result = await readMcpJson(path)
      if (result === undefined) return leases
      this.logRefused(result.refused)
      const decisions = await this.lookupAll(path, result.servers)
      for (const [index, server] of result.servers.entries()) {
        if (decisions[index] !== 'allow' || !await this.credentialsSet(server) || this.disposed) continue
        const lease = this.pool.acquire(path, server)
        this.held.add(lease)
        this.share(path, lease)
        leases.push(lease)
      }
    } catch (error) {
      this.ctx.logger.error(failureMessage(error))
    }
    return leases
  }

  /**
   * Release every agent's leases and the preconnect leases, and abort pending
   * admissions and questions. Later `agent/created` calls do nothing.
   */
  dispose(): void {
    this.disposed = true
    for (const disposeEffect of [...this.bindings.values()]) void disposeEffect()
    for (const lease of this.held) void lease.release()
    this.held.clear()
    this.shared.clear()
  }

  /**
   * Synchronously attach every published shared connection for the binding's
   * path that the current `.mcp.json` declares and whose stored decision
   * admits it. Only a path with shared connections reads `.mcp.json`, and the
   * trust document is read once for every published connection. A connection
   * the file no longer declares, including every connection when the file is
   * missing or cannot be read or parsed, or one the decision no longer admits
   * is revoked; every connection is revoked when the trust document cannot be read.
   * @param binding - the new agent's binding.
   */
  private attachShared(binding: Binding): void {
    const { path } = binding
    const offers = this.sharedAt(path)
    if (offers.size === 0) return
    const declared = this.declaredSync(path)
    for (const key of [...offers.keys()]) {
      if (!declared.has(key)) this.revoke(path, key)
    }
    const published = [...offers].filter(([, { holders }]) => [...holders].some(holder => holder.toolNames().length > 0))
    if (published.length === 0) return
    let decisions: Array<TrustDecision | undefined>
    try {
      decisions = this.trust.lookupAllSync(path, published.map(([, { server }]) => server))
    } catch (error) {
      this.ctx.logger.error(failureMessage(error))
      for (const key of [...offers.keys()]) this.revoke(path, key)
      return
    }
    for (const [index, [key, { server }]] of published.entries()) {
      if (!this.admits(binding, key, decisions[index])) {
        this.revoke(path, key)
        continue
      }
      this.attach(binding, this.own(binding, this.pool.acquire(path, server), true))
    }
  }

  /**
   * @param path - canonical workspace path.
   * @returns the {@link leaseKey}s the path's `.mcp.json` currently declares; empty when the file is missing or cannot be read or parsed.
   */
  private declaredSync(path: string): Set<string> {
    let result: McpJsonReadResult | undefined
    try {
      result = readMcpJsonSync(path)
    } catch {
      // A read or parse failure declares nothing; the agent's asynchronous pass reads the file again and logs the failure.
      return new Set()
    }
    return new Set((result?.servers ?? []).map(server => leaseKey(path, server)))
  }

  /**
   * Admission after `agent/created` returns: withdraw attachments `.mcp.json`
   * no longer declares and revoke those shared connections, recheck the
   * stored decision of attached servers, admit saved `allow` decisions, and
   * ask about undecided servers. A `.mcp.json` that cannot be read or parsed
   * is logged and declares nothing. When the trust document cannot be read,
   * every attachment is withdrawn and every shared connection for the path revoked.
   * @param binding - the agent binding to admit servers for.
   */
  private async bind(binding: Binding): Promise<void> {
    const { path } = binding
    let result: McpJsonReadResult | undefined
    try {
      result = await readMcpJson(path)
    } catch (error) {
      this.ctx.logger.error(failureMessage(error))
    }
    if (this.closed(binding)) return
    const servers = result?.servers ?? []
    this.logRefused(result?.refused ?? [])
    this.withdrawUndeclared(binding, servers)
    let decisions: Array<TrustDecision | undefined>
    try {
      decisions = await this.lookupAll(path, servers)
    } catch (error) {
      this.ctx.logger.error(failureMessage(error))
      for (const [key, owned] of [...binding.leases]) this.withdraw(binding, key, owned)
      for (const key of [...this.sharedAt(path).keys()]) this.revoke(path, key)
      return
    }
    if (this.closed(binding)) return
    const admissions: Promise<void>[] = []
    const undecided: DeclaredServer[] = []
    for (const [index, server] of servers.entries()) {
      const key = leaseKey(path, server)
      const owned = binding.leases.get(key)
      if (owned !== undefined) {
        if (!this.admits(binding, key, decisions[index])) {
          this.withdraw(binding, key, owned)
          this.revoke(path, key)
        }
      } else if (decisions[index] === 'allow') {
        admissions.push(this.admit(binding, server, true))
      } else if (decisions[index] === undefined) {
        undecided.push(server)
      }
    }
    if (undecided.length > 0) admissions.push(this.decide(binding, undecided))
    await Promise.all(admissions)
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

  /**
   * Resolve a decision for undecided servers through one shared question per
   * path and fingerprint set, then admit according to the outcome.
   * @param binding - the waiting agent's binding.
   * @param servers - the undecided servers, all declared in `binding.path`.
   */
  private async decide(binding: Binding, servers: readonly DeclaredServer[]): Promise<void> {
    if (binding.agent.session.header.origin === 'subagent') {
      for (const server of servers) this.ctx.logger.warn(`mcp-workspace(${server.name}): not approved`)
      return
    }
    const key = JSON.stringify([binding.path, servers.map(server => server.fingerprint).sort()])
    for (;;) {
      let question = this.questions.get(key)
      if (question === undefined) {
        // The entry is removed before any waiter observes the outcome, so a waiter that asks again starts a new question.
        const outcome = this.ask(binding, servers).then((settled) => {
          this.questions.delete(key)
          return settled
        })
        question = { asker: binding, outcome }
        this.questions.set(key, question)
      }
      const outcome = await question.outcome
      if (this.closed(binding)) return
      const asker = question.asker === binding
      if (outcome === 'workspace' || (outcome === 'session' && asker)) {
        if (outcome === 'session') {
          for (const server of servers) binding.sessionAllowed.add(leaseKey(binding.path, server))
        }
        await Promise.all(servers.map(server => this.admit(binding, server, outcome === 'workspace')))
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
      if (signal.aborted) return 'aborted'
      if ((error as { code?: unknown }).code === 'NO_PROVIDER') return this.noQuestionUi(servers)
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
   * @returns `- <name> (<stdio|http>): <command and args | url>`, followed by
   *   `; credentials: <REF> set|missing, …` when the entry references credentials.
   */
  private async describeServer(server: DeclaredServer): Promise<string> {
    const { entry } = server
    const target = entry.transport === 'stdio' ? `stdio): ${[entry.command, ...entry.args].join(' ')}` : `http): ${entry.url}`
    const credentials = await Promise.all(server.credentialRefs.map(async (ref) => {
      const { configured } = await this.ctx.credentials.describe(credentialRef(ref))
      return `${ref} ${configured ? 'set' : 'missing'}`
    }))
    const suffix = credentials.length === 0 ? '' : `; credentials: ${credentials.join(', ')}`
    return `- ${server.name} (${target}${suffix}`
  }

  /**
   * Acquire and attach one admitted server for an agent once its credentials
   * are set and its first connection attempt settled, rechecking the stored
   * decision immediately before attaching. Callers pass only servers the agent
   * holds no lease for: {@link bind} skips attached keys, and its allowed and
   * undecided sets are disjoint.
   * @param binding - the agent binding.
   * @param server - the admitted server.
   * @param shared - whether the admission is a saved `allow` that later agents in the path may attach synchronously.
   */
  private async admit(binding: Binding, server: DeclaredServer, shared: boolean): Promise<void> {
    if (!await this.credentialsSet(server) || this.closed(binding)) return
    const key = leaseKey(binding.path, server)
    const owned = this.own(binding, this.pool.acquire(binding.path, server), shared)
    await owned.lease.ready
    const admitted = await this.recheck(binding, server)
    if (this.closed(binding)) return
    if (!admitted) {
      this.withdraw(binding, key, owned)
      this.revoke(binding.path, key)
      return
    }
    this.attach(binding, owned)
  }

  /**
   * Read the stored decision for a server the agent is about to attach; a trust store failure is logged.
   * @param binding - the agent binding.
   * @param server - the server to recheck.
   * @returns whether the decision, or the agent's Allow this session, still admits the server.
   */
  private async recheck(binding: Binding, server: DeclaredServer): Promise<boolean> {
    try {
      const decision = await this.trust.lookup(binding.path, server.name, server.fingerprint)
      return this.admits(binding, leaseKey(binding.path, server), decision)
    } catch (error) {
      this.ctx.logger.error(failureMessage(error))
      return false
    }
  }

  /**
   * @param binding - the agent binding.
   * @param key - the connection's {@link leaseKey}.
   * @param decision - the stored decision for the connection's server and fingerprint.
   * @returns whether the stored `allow` or the agent's Allow this session admits the connection.
   */
  private admits(binding: Binding, key: string, decision: TrustDecision | undefined): boolean {
    return decision === 'allow' || binding.sessionAllowed.has(key)
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
   * Check every credential reference of a server.
   * @param server - the server whose references to resolve.
   * @returns whether every reference currently resolves; the first missing one is logged.
   */
  private async credentialsSet(server: DeclaredServer): Promise<boolean> {
    for (const ref of server.credentialRefs) {
      if (await this.ctx.credentials.resolve(credentialRef(ref)) === undefined) {
        this.ctx.logger.warn(`mcp-workspace(${server.name}): credential ${ref} is not set`)
        return false
      }
    }
    return true
  }

  /**
   * Record a lease as owned by an agent; the agent's effect cleanup releases it.
   * @param binding - the owning agent binding.
   * @param lease - a lease acquired for `binding.path`.
   * @param shared - whether to offer the connection to later agents' synchronous attach.
   * @returns the owned-lease record.
   */
  private own(binding: Binding, lease: ServerLease, shared: boolean): OwnedLease {
    const owned: OwnedLease = { lease }
    binding.leases.set(leaseKey(binding.path, lease.server), owned)
    if (shared) this.share(binding.path, lease)
    return owned
  }

  /**
   * Attach an owned lease to its agent, warning once per path and server when a global tool has the same name.
   * @param binding - the owning agent binding.
   * @param owned - an owned lease not yet attached.
   */
  private attach(binding: Binding, owned: OwnedLease): void {
    const { lease } = owned
    const warning = JSON.stringify([binding.path, lease.server.name])
    if (!this.shadowWarnings.has(warning) && lease.toolNames().some(name => this.ctx.tools.get(name) !== undefined)) {
      this.shadowWarnings.add(warning)
      this.ctx.logger.warn(`mcp-workspace(${lease.server.name}): agent-scoped tools shadow a global tool of the same name`)
    }
    owned.detach = lease.attach(binding.agent.ctx)
  }

  /**
   * Withdraw attachments for connections `.mcp.json` no longer declares, and
   * revoke those connections' shared offers and plugin-held preconnect leases.
   * @param binding - the agent binding whose attachments to reconcile.
   * @param servers - the servers `.mcp.json` currently declares.
   */
  private withdrawUndeclared(binding: Binding, servers: readonly DeclaredServer[]): void {
    const declared = new Set(servers.map(server => leaseKey(binding.path, server)))
    for (const key of [...this.sharedAt(binding.path).keys()]) {
      if (!declared.has(key)) this.revoke(binding.path, key)
    }
    for (const [key, owned] of [...binding.leases]) {
      if (!declared.has(key)) this.withdraw(binding, key, owned)
    }
  }

  /**
   * Remove one attachment from an agent and release its lease.
   * @param binding - the owning agent binding.
   * @param key - the lease's {@link leaseKey}.
   * @param owned - the owned lease.
   */
  private withdraw(binding: Binding, key: string, owned: OwnedLease): void {
    binding.leases.delete(key)
    this.drop(binding.path, owned)
  }

  /**
   * Stop offering a connection to later agents' synchronous attach and release the plugin-held preconnect leases on it.
   * @param path - canonical workspace path.
   * @param key - the connection's {@link leaseKey}.
   */
  private revoke(path: string, key: string): void {
    this.sharedAt(path).delete(key)
    for (const lease of [...this.held].filter(held => leaseKey(held.workspacePath, held.server) === key)) {
      this.held.delete(lease)
      void lease.release()
    }
  }

  /**
   * Agent effect cleanup: abort pending work and release every owned lease.
   * @param binding - the binding to close.
   */
  private unbind(binding: Binding): void {
    this.bindings.delete(binding)
    binding.controller.abort()
    for (const owned of binding.leases.values()) this.drop(binding.path, owned)
    binding.leases.clear()
  }

  /**
   * Detach and release one owned lease.
   * @param path - canonical workspace path of the lease.
   * @param owned - the owned lease.
   */
  private drop(path: string, owned: OwnedLease): void {
    owned.detach?.()
    const offer = this.sharedAt(path).get(leaseKey(path, owned.lease.server))
    if (offer !== undefined) {
      offer.holders.delete(owned.lease)
      if (offer.holders.size === 0) this.sharedAt(path).delete(leaseKey(path, owned.lease.server))
    }
    void owned.lease.release()
  }

  /**
   * Offer a saved-`allow` connection to later agents' synchronous attach while `lease` is held.
   * @param path - canonical workspace path.
   * @param lease - a lease holding the connection.
   */
  private share(path: string, lease: ServerLease): void {
    const offers = this.sharedAt(path)
    const key = leaseKey(path, lease.server)
    const offer = offers.get(key) ?? { server: lease.server, holders: new Set<ServerLease>() }
    offer.holders.add(lease)
    offers.set(key, offer)
  }

  /**
   * @param path - canonical workspace path.
   * @returns the path's shared connection offers, created empty on first use.
   */
  private sharedAt(path: string): Map<string, { server: DeclaredServer; holders: Set<ServerLease> }> {
    let offers = this.shared.get(path)
    if (offers === undefined) {
      offers = new Map()
      this.shared.set(path, offers)
    }
    return offers
  }

  /**
   * Log every server `.mcp.json` refused.
   * @param refused - the refused servers with their reasons, which never contain a field value.
   */
  private logRefused(refused: ReadonlyArray<{ name: string; reason: string }>): void {
    for (const server of refused) this.ctx.logger.warn(`mcp-workspace(${server.name}): ${server.reason}`)
  }
}
