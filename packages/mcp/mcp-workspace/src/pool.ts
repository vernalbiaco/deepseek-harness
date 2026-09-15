/**
 * Connection pool for workspace-declared MCP servers. One supervised
 * connection exists per `(workspacePath, server.name, server.fingerprint)`
 * key and is shared by every lease on that key; its tool definitions are
 * registered on the tool layer of each agent context attached through a lease.
 * @module @deepseek-ai/dsh-mcp-workspace/pool
 */

import type { Context } from '@deepseek-ai/cordis'
import { startConnection } from '@deepseek-ai/dsh-mcp-client'
import type { Config, ConnectionHandle, ResolvedReconnectPolicy, ToolDefinitions, ToolSink } from '@deepseek-ai/dsh-mcp-client'
import { substitutePlaceholders } from './mcp-json.ts'
import type { DeclaredServer, WorkspaceServerEntry } from './types.ts'

/** Settings shared by every connection the pool starts. */
export interface WorkspacePoolOptions {
  /** Per-tool-call timeout in milliseconds for every pooled server. */
  readonly toolCallTimeoutMs: number
  /** Reconnect policy for every pooled connection. */
  readonly reconnect: ResolvedReconnectPolicy
  /** Resolve one credential reference; undefined when not set. */
  readonly resolveCredential: (ref: string) => Promise<string | undefined>
}

/** One holder's reference to a pooled connection. */
export interface ServerLease {
  /** Canonical workspace path of the pooled connection. */
  readonly workspacePath: string
  /** The declared server the pooled connection runs. */
  readonly server: DeclaredServer
  /** Settles after the connection's first attempt. */
  readonly ready: Promise<{ error?: unknown }>
  /**
   * Synchronously register the current definition set on `agentCtx`'s tool
   * layer and every later set. A registration failure leaves that agent
   * without tools from this server and is logged, never thrown.
   * @param agentCtx - the agent-scoped context whose tool layer receives the definitions.
   * @returns an idempotent detach that disposes this agent's registrations and stops later replacements.
   * @throws when the lease is already released.
   */
  attach(agentCtx: Context): () => void
  /**
   * Names of the definitions currently published, for collision checks and invariants.
   * @returns the public tool names of the connection's current definition set.
   */
  toolNames(): readonly string[]
  /**
   * Detach every agent attached through this lease and drop its reference;
   * idempotent. The last release for a key closes the connection.
   * @returns the settlement of the connection's disposal, or an immediately
   *   resolved promise while other leases hold the key; repeat calls return the same promise.
   */
  release(): Promise<void>
}

/** One live attachment as reported by {@link WorkspacePool.attachments}. */
export interface PoolAttachment {
  /** Canonical workspace path of the pooled connection. */
  readonly workspacePath: string
  /** The declared server name. */
  readonly serverName: string
  /** The attached agent-scoped context. */
  readonly agentCtx: Context
  /** Tool names currently registered on that agent from this connection. */
  readonly toolNames: readonly string[]
}

/** One agent context attached to a pooled connection. */
interface Attachment {
  readonly agentCtx: Context
  /** Registration disposers for the definitions registered on this agent, keyed by public tool name. */
  disposers: Map<string, () => void>
}

/** The published definition set before a generation's first sync and after a clear. */
const NO_DEFINITIONS: ToolDefinitions = new Map()

/** One `startConnection` run and the sink that only it may publish through. */
interface Generation {
  readonly handle: ConnectionHandle
  readonly sink: ToolSink
}

/**
 * Build the connection config for one server entry. `startConnection` reads
 * only `serverName`, `toolCallTimeoutMs`, and `failOnStartupError` from the
 * static config when `resolveConfig` is supplied, so the unsubstituted entry
 * serves as the static config.
 * @param workspacePath - canonical workspace path; the stdio child's working directory.
 * @param serverName - the declared server name; the tool namespace.
 * @param entry - the transport entry, with or without placeholders substituted.
 * @param options - pool-wide timeout and reconnect settings.
 * @returns the mcp-client connection config.
 */
function connectionConfig(
  workspacePath: string,
  serverName: string,
  entry: WorkspaceServerEntry,
  options: WorkspacePoolOptions,
): Config {
  const { toolCallTimeoutMs, reconnect } = options
  if (entry.transport === 'stdio') {
    return {
      transport: 'stdio',
      serverName,
      command: entry.command,
      args: [...entry.args],
      env: { ...entry.env },
      cwd: workspacePath,
      toolCallTimeoutMs,
      failOnStartupError: false,
      reconnect,
    }
  }
  return {
    transport: 'streamable-http',
    serverName,
    url: entry.url,
    headers: { ...entry.headers },
    toolCallTimeoutMs,
    failOnStartupError: false,
    reconnect,
  }
}

/**
 * Dispose every registration on one attached agent.
 * @param attachment - the agent attachment to clear.
 */
function unpublish(attachment: Attachment): void {
  for (const dispose of attachment.disposers.values()) dispose()
  attachment.disposers = new Map()
}

/** The pooled connection for one key, its published definitions, and its attached agents. */
class PoolEntry {
  readonly workspacePath: string
  readonly server: DeclaredServer
  /** Live leases on this key. */
  refs = 0
  /** The current generation's published definitions. */
  definitions: ToolDefinitions = NO_DEFINITIONS
  readonly attachments = new Set<Attachment>()
  private readonly ctx: Context
  private readonly options: WorkspacePoolOptions
  /** Every credential value this entry has resolved, mapped to its reference name; kept across rotations for {@link describeError}. */
  private readonly resolvedValues = new Map<string, string>()
  private generation: Generation

  constructor(ctx: Context, options: WorkspacePoolOptions, workspacePath: string, server: DeclaredServer) {
    this.ctx = ctx
    this.options = options
    this.workspacePath = workspacePath
    this.server = server
    this.generation = this.start()
  }

  /** The current generation's connection handle. */
  get handle(): ConnectionHandle {
    return this.generation.handle
  }

  /**
   * Withdraw the current generation's registrations from every attached agent,
   * start a new generation, and dispose the previous handle. The previous
   * generation's sink becomes inert, so its late `clear()` cannot withdraw
   * the new generation's registrations.
   * @returns the previous handle's disposal.
   */
  restart(): Promise<void> {
    const previous = this.generation
    previous.sink.clear()
    this.generation = this.start()
    return previous.handle.dispose()
  }

  /**
   * Replace one agent's registrations with the current definition set. On a
   * registration failure the partial set is disposed and the failure logged.
   * @param attachment - the agent attachment to publish to.
   */
  publish(attachment: Attachment): void {
    unpublish(attachment)
    const next = new Map<string, () => void>()
    try {
      for (const [name, definition] of this.definitions) {
        next.set(name, attachment.agentCtx.tools.register(definition))
      }
    } catch (error) {
      for (const dispose of next.values()) dispose()
      this.ctx.logger.error(`mcp-workspace(${this.server.name}): tool registration failed for one agent: ${String(error)}`)
      return
    }
    attachment.disposers = next
  }

  /**
   * Start one supervised connection. Its sink's `clear` acts only while it is
   * the current generation; `replace` needs no such check because the pool
   * restarts only a `stopped()` handle, which never syncs again.
   * @returns the new generation.
   */
  private start(): Generation {
    const sink: ToolSink = {
      replace: (definitions) => {
        this.definitions = definitions
        for (const attachment of this.attachments) this.publish(attachment)
      },
      clear: () => {
        if (this.generation.sink !== sink) return
        this.definitions = NO_DEFINITIONS
        for (const attachment of this.attachments) unpublish(attachment)
      },
    }
    const config = connectionConfig(this.workspacePath, this.server.name, this.server.entry, this.options)
    const handle = startConnection(this.ctx, config, this.options.reconnect, {
      sink,
      resolveConfig: () => this.resolveConfig(),
      describeError: error => this.describeError(error),
    })
    return { handle, sink }
  }

  /**
   * Resolve every credential reference and substitute it into the entry; runs
   * before every connection attempt. Each resolved value is remembered for
   * {@link describeError}.
   * @returns the substituted connection config.
   * @throws `Error('credential <NAME> is not set')` for the first unset reference.
   */
  private async resolveConfig(): Promise<Config> {
    const values = new Map<string, string>()
    for (const ref of this.server.credentialRefs) {
      const value = await this.options.resolveCredential(ref)
      if (value === undefined) throw new Error(`credential ${ref} is not set`)
      values.set(ref, value)
      this.resolvedValues.set(value, ref)
    }
    return connectionConfig(this.workspacePath, this.server.name, substitutePlaceholders(this.server.entry, values), this.options)
  }

  /**
   * Render a connection failure for mcp-client's log lines with every
   * credential value this entry has resolved replaced by its `${NAME}`
   * placeholder, longest value first so a value containing another is replaced whole.
   * @param error - the caught failure.
   * @returns the failure text without any resolved credential value.
   */
  private describeError(error: unknown): string {
    let text = String(error)
    const values = [...this.resolvedValues].filter(([value]) => value.length > 0).sort(([a], [b]) => b.length - a.length)
    for (const [value, ref] of values) text = text.replaceAll(value, `\${${ref}}`)
    return text
  }
}

/** A lease on one pool entry; owns the attachments made through it. */
class Lease implements ServerLease {
  readonly workspacePath: string
  readonly server: DeclaredServer
  readonly ready: Promise<{ error?: unknown }>
  private readonly entry: PoolEntry
  private readonly drop: (lease: Lease) => Promise<void>
  private readonly own = new Set<Attachment>()
  private released: Promise<void> | undefined

  constructor(entry: PoolEntry, drop: (lease: Lease) => Promise<void>) {
    this.entry = entry
    this.drop = drop
    this.workspacePath = entry.workspacePath
    this.server = entry.server
    this.ready = entry.handle.ready
  }

  attach(agentCtx: Context): () => void {
    if (this.released !== undefined) throw new Error(`mcp-workspace(${this.server.name}): attach on a released lease`)
    const attachment: Attachment = { agentCtx, disposers: new Map() }
    this.own.add(attachment)
    this.entry.attachments.add(attachment)
    this.entry.publish(attachment)
    return () => { this.detach(attachment) }
  }

  toolNames(): readonly string[] {
    return [...this.entry.definitions.keys()]
  }

  release(): Promise<void> {
    if (this.released === undefined) {
      for (const attachment of this.own) this.detach(attachment)
      this.released = this.drop(this)
    }
    return this.released
  }

  private detach(attachment: Attachment): void {
    if (!this.own.delete(attachment)) return
    this.entry.attachments.delete(attachment)
    unpublish(attachment)
  }
}

/** Shares one supervised MCP connection per workspace server key across leases. */
export class WorkspacePool {
  private readonly ctx: Context
  private readonly options: WorkspacePoolOptions
  private readonly entries = new Map<string, PoolEntry>()
  private readonly leases = new Set<Lease>()
  /** Handle disposals (replaced stopped handles and released keys) that have not settled yet. */
  private readonly closing = new Set<Promise<void>>()
  private disposed = false

  /**
   * @param ctx - context providing the logger and the definitions' execution services.
   * @param options - settings shared by every pooled connection.
   */
  constructor(ctx: Context, options: WorkspacePoolOptions) {
    this.ctx = ctx
    this.options = options
  }

  /**
   * Take a reference to the connection for `(workspacePath, server.name,
   * server.fingerprint)`, starting it on first use. A stopped connection is
   * replaced by a new one; its attachments stay and receive the new
   * connection's definitions.
   * @param workspacePath - canonical workspace path.
   * @param server - the admitted declared server.
   * @returns a lease holding one reference to the key's connection.
   * @throws when the pool is disposed.
   */
  acquire(workspacePath: string, server: DeclaredServer): ServerLease {
    if (this.disposed) throw new Error('mcp-workspace: acquire on a disposed pool')
    const key = JSON.stringify([workspacePath, server.name, server.fingerprint])
    let entry = this.entries.get(key)
    if (entry === undefined) {
      entry = new PoolEntry(this.ctx, this.options, workspacePath, server)
      this.entries.set(key, entry)
    } else if (entry.handle.stopped()) {
      void this.track(entry.restart())
    }
    entry.refs += 1
    const owner = entry
    const lease = new Lease(owner, (released) => {
      this.leases.delete(released)
      owner.refs -= 1
      if (owner.refs > 0) return Promise.resolve()
      this.entries.delete(key)
      return this.track(owner.handle.dispose())
    })
    this.leases.add(lease)
    return lease
  }

  /**
   * Live attachments for the invariant companion.
   * @returns one row per attached agent with the tool names currently registered on it.
   */
  attachments(): readonly PoolAttachment[] {
    const rows: PoolAttachment[] = []
    for (const entry of this.entries.values()) {
      for (const attachment of entry.attachments) {
        rows.push({
          workspacePath: entry.workspacePath,
          serverName: entry.server.name,
          agentCtx: attachment.agentCtx,
          toolNames: [...attachment.disposers.keys()],
        })
      }
    }
    return rows
  }

  /**
   * Release every lease and close every connection in parallel; later `acquire` calls throw.
   * @returns after every connection has been disposed, including replaced stopped
   *   ones and keys whose last lease was released earlier.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const lease of [...this.leases]) void lease.release()
    await Promise.all(this.closing)
  }

  /**
   * Keep a handle disposal in {@link closing} until it settles, so {@link dispose} awaits it.
   * @param disposal - the handle disposal to track.
   * @returns the tracked disposal.
   */
  private track(disposal: Promise<void>): Promise<void> {
    const closed: Promise<void> = disposal.finally(() => { this.closing.delete(closed) })
    this.closing.add(closed)
    return closed
  }
}
