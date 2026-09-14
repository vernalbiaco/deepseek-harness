/**
 * Workspace-declared MCP servers from `.mcp.json` behind a stored user
 * decision. Temporary scaffold: exports the `.mcp.json` parser only. The
 * trust store, connection pool, and `agent/created` binder replace this
 * module's plugin wiring.
 * @module @deepseek-ai/dsh-mcp-workspace
 */

import z from '@deepseek-ai/schemastery'

export type * from './types.ts'
export { MCP_JSON_FILE, McpJsonError, fingerprintEntry, parseMcpJson, readMcpJson, substitutePlaceholders } from './mcp-json.ts'

/** Cordis function-plugin name. */
export const name = 'mcp-workspace'

/** Services required before this plugin can mount. */
export const inject: string[] = []

/** Plugin configuration. Empty until the trust store, pool, and binder land. */
export const Config = z.object({})

/**
 * Mounts the plugin. Currently performs no work.
 */
export function apply(): void {}
