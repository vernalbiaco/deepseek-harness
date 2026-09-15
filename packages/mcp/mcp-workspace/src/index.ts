/**
 * Workspace-declared MCP servers from `.mcp.json` behind a stored user
 * decision. Each eligible agent mounts one `@deepseek-ai/dsh-mcp-client`
 * instance per admitted server of its canonical cwd on its own context.
 * @module @deepseek-ai/dsh-mcp-workspace
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { WorkspaceBinder } from './binder.ts'
import { TrustStore } from './trust-store.ts'

export type * from './types.ts'
export { MCP_JSON_FILE, McpJsonError, fingerprintEntry, parseMcpJson, readMcpJson, substitutePlaceholders } from './mcp-json.ts'
export { ALLOW_SESSION, ALLOW_WORKSPACE, DENY, QUESTION_ID } from './binder.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An eligible agent's admission pass settled: its `.mcp.json` read,
     * stored-decision lookups, credential checks, questions, and mounts all
     * finished, including when nothing was admitted, a step failed, or the
     * agent was disposed first. Emitted in memory only; it carries no
     * model-visible state and is not persisted. Not emitted after the plugin is
     * disposed.
     * @param payload.agent - the agent whose admission pass settled.
     * @mode emit
     */
    'mcp-workspace/binding-settled'(payload: { agent: Agent }): void
  }
}

/** Cordis function-plugin name. */
export const name = 'mcp-workspace'

/** Services required before this plugin can mount. */
export const inject = ['agents', 'credentials']

/** Plugin configuration. */
export interface Config {
  /** Absolute path of the trust document holding per-workspace server decisions; never inside a workspace. */
  trustFile: string
  /** Longest agent creation waits for saved `allow` servers' first connection attempts, in milliseconds. */
  admissionTimeoutMs: number
  /** Per-tool-call timeout in milliseconds for every workspace server. */
  toolCallTimeoutMs: number
  /** Reconnect policy for every workspace server; omitted fields use the `mcp-client` defaults. */
  reconnect?: McpClient.ReconnectConfig
}

export const Config: z<Config> = z.object({
  trustFile: z.string().required(),
  admissionTimeoutMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(10_000),
  toolCallTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
  // Defaults and bounds are applied by the mcp-client schema, which apply() runs at load.
  reconnect: z.object({
    enabled: z.boolean(),
    initialDelayMs: z.number(),
    maxDelayMs: z.number(),
    maxAttempts: z.number(),
  }),
})

/**
 * Validate the reconnect policy and wire the binder to the serial `agent/created` event.
 * @param ctx - plugin context carrying `agents` and `credentials`.
 * @param config - resolved plugin configuration.
 * @throws when `reconnect` is outside the `mcp-client` bounds.
 */
export function apply(ctx: Context, config: Config): void {
  // A probe entry runs the mcp-client reconnect bounds at load instead of at the first mount.
  const probe = McpClient.Config({
    transport: 'stdio',
    serverName: 'reconnect-check',
    command: 'unused',
    ...config.reconnect === undefined ? {} : { reconnect: config.reconnect },
  })
  const binder = new WorkspaceBinder(ctx, {
    trust: new TrustStore(config.trustFile),
    admissionTimeoutMs: config.admissionTimeoutMs,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    ...config.reconnect === undefined ? {} : { reconnect: probe.reconnect },
  })
  ctx.effect(() => () => { binder.dispose() }, 'mcp-workspace.binder()')
  ctx.on('agent/created', ({ agent }) => binder.onAgentCreated(agent).then(() => undefined))
}
