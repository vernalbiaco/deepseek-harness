/**
 * Workspace-declared MCP servers from `.mcp.json` behind a stored user
 * decision. Each eligible agent receives the tools of its canonical cwd's
 * admitted servers on its own tool layer; one supervised connection per
 * workspace server is shared by every agent using it.
 * @module @deepseek-ai/dsh-mcp-workspace
 */

import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveReconnectPolicy } from '@deepseek-ai/dsh-mcp-client'
import type { ReconnectConfig } from '@deepseek-ai/dsh-mcp-client'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-workspace'
import { activePools } from './active-pools.ts'
import { WorkspaceBinder } from './binder.ts'
import { WorkspacePool } from './pool.ts'
import { TrustStore } from './trust-store.ts'

export type * from './types.ts'
export { MCP_JSON_FILE, McpJsonError, fingerprintEntry, parseMcpJson, readMcpJson, substitutePlaceholders } from './mcp-json.ts'
export { ALLOW_SESSION, ALLOW_WORKSPACE, DENY, QUESTION_ID } from './binder.ts'

/** Cordis function-plugin name. */
export const name = 'mcp-workspace'

/** Services required before this plugin can mount. */
export const inject = ['agents', 'tools', 'credentials']

/** Plugin configuration. */
export interface Config {
  /** Absolute path of the trust document holding per-workspace server decisions; never inside a workspace. */
  trustFile: string
  /** Connect servers with a saved `allow` for the process cwd and every registered workspace at activation. */
  preconnect: boolean
  /** Longest activation waits for preconnected servers' first connection attempts, in milliseconds. */
  preconnectTimeoutMs: number
  /** Per-tool-call timeout in milliseconds for every workspace server. */
  toolCallTimeoutMs: number
  /** Reconnect policy for every workspace server; omitted fields use the `mcp-client` defaults. */
  reconnect?: ReconnectConfig
}

export const Config: z<Config> = z.object({
  trustFile: z.string().required(),
  preconnect: z.boolean().default(true),
  preconnectTimeoutMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(10_000),
  toolCallTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
  // Defaults and bounds are applied by resolveReconnectPolicy, which rejects an invalid policy at load.
  reconnect: z.object({
    enabled: z.boolean(),
    initialDelayMs: z.number(),
    maxDelayMs: z.number(),
    maxAttempts: z.number(),
  }),
})

/**
 * Wire the binder to `agent/created` and preconnect saved `allow` servers.
 * This entry remains explicitly `async`: Cordis treats a prototype-bearing
 * ordinary function as a constructor, whose returned Promise is not startup work.
 * @param ctx - plugin context carrying `agents`, `tools`, and `credentials`.
 * @param config - resolved plugin configuration.
 * @returns after the process cwd's preconnected servers settled their first attempt or
 *   `preconnectTimeoutMs` elapsed; preconnect failures are logged and never reject.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const reconnect = resolveReconnectPolicy(config.reconnect, 'mcp-workspace: reconnect')
  const trust = new TrustStore(config.trustFile)
  const pool = new WorkspacePool(ctx, {
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    reconnect,
    resolveCredential: async ref => (await ctx.credentials.resolve(credentialRef(ref)))?.value,
  })
  const binder = new WorkspaceBinder(ctx, { pool, trust })
  ctx.effect(() => {
    activePools().set(ctx.root, pool)
    return async () => {
      activePools().delete(ctx.root)
      binder.dispose()
      await pool.dispose()
    }
  }, 'mcp-workspace.pool()')
  ctx.on('agent/created', ({ agent }) => { binder.onAgentCreated(agent) })
  if (!config.preconnect) return
  ctx.inject(['workspaceRegistry'], (registryCtx) => {
    for (const workspace of registryCtx.workspaceRegistry.list()) void binder.preconnect(workspace.path)
  })
  const leases = await binder.preconnect(process.cwd())
  const timeout = new AbortController()
  try {
    await Promise.race([
      Promise.allSettled(leases.map(lease => lease.ready)),
      delay(config.preconnectTimeoutMs, undefined, { ref: false, signal: timeout.signal }),
    ])
  } finally {
    timeout.abort()
  }
}
