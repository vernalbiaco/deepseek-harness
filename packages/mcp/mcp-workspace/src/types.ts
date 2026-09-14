/**
 * Types for workspace `.mcp.json` server declarations.
 * @module @deepseek-ai/dsh-mcp-workspace/types
 */

/** One workspace-declared MCP server, transport-normalized after parsing. */
export type WorkspaceServerEntry =
  | {
    readonly transport: 'stdio'
    readonly command: string
    readonly args: readonly string[]
    readonly env: Readonly<Record<string, string>>
  }
  | {
    readonly transport: 'streamable-http'
    readonly url: string
    readonly headers: Readonly<Record<string, string>>
  }

/** A `.mcp.json` server entry that parsed successfully. */
export interface DeclaredServer {
  readonly name: string
  readonly entry: WorkspaceServerEntry
  /** `sha256:<hex>` over the canonical JSON of the raw `.mcp.json` entry, before placeholder substitution. */
  readonly fingerprint: string
  /** Sorted, de-duplicated credential reference names used by the entry's placeholders. */
  readonly credentialRefs: readonly string[]
}

/** A `.mcp.json` server entry that failed a parsing rule and was skipped. */
export interface RefusedServer {
  readonly name: string
  readonly reason: string
}

/** Outcome of parsing a workspace `.mcp.json` file's `mcpServers` map. */
export interface McpJsonReadResult {
  readonly servers: readonly DeclaredServer[]
  readonly refused: readonly RefusedServer[]
}
