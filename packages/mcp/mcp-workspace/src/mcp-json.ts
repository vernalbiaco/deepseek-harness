/**
 * Parses a workspace `.mcp.json` file's `mcpServers` map into
 * {@link WorkspaceServerEntry} declarations, refusing entries that fail a
 * parsing rule, and computes the fingerprint and placeholder substitution
 * used by the trust store and connection pool.
 * @module @deepseek-ai/dsh-mcp-workspace/mcp-json
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SERVER_NAME_PATTERN } from '@deepseek-ai/dsh-mcp-client'
import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import type { DeclaredServer, McpJsonReadResult, RefusedServer, WorkspaceServerEntry } from './types.ts'

/** Workspace `.mcp.json` file name, relative to the canonical workspace cwd. External format; stays fixed. */
export const MCP_JSON_FILE = '.mcp.json'

const SENSITIVE_HEADER_NAMES = new Set(['authorization', 'proxy-authorization', 'cookie'])

/** Raised when a whole `.mcp.json` file is unusable: invalid JSON or a malformed top-level shape. */
export class McpJsonError extends Error {
  /** The file path or other source label the unusable content was read from. */
  readonly source: string

  /**
   * @param source - file path or other source label, echoed at the start of {@link Error.message}.
   * @param problem - what is wrong with the content, never a field value.
   */
  constructor(source: string, problem: string) {
    super(`${source}: ${problem}`)
    this.name = 'McpJsonError'
    this.source = source
  }
}

/**
 * Parses `.mcp.json` text into declared and refused servers.
 * @param text - the file's raw text.
 * @param source - file path or other source label used in a thrown {@link McpJsonError}'s message.
 * @returns declared servers that parsed successfully and refused servers with their reason.
 * @throws {McpJsonError} when `text` is not valid JSON, its top level is not an object, or `mcpServers` is absent or not an object.
 */
export function parseMcpJson(text: string, source: string): McpJsonReadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new McpJsonError(source, 'invalid JSON')
  }
  if (!isPlainObject(parsed)) {
    throw new McpJsonError(source, 'top level is not an object')
  }
  const mcpServers = parsed.mcpServers
  if (!isPlainObject(mcpServers)) {
    throw new McpJsonError(source, 'mcpServers is missing or not an object')
  }

  const servers: DeclaredServer[] = []
  const refused: RefusedServer[] = []
  for (const [serverName, rawEntry] of Object.entries(mcpServers)) {
    if (!SERVER_NAME_PATTERN.test(serverName)) {
      refused.push({ name: serverName, reason: 'invalid server name' })
      continue
    }
    if (!isPlainObject(rawEntry)) {
      refused.push({ name: serverName, reason: 'entry is not an object' })
      continue
    }
    const outcome = parseEntry(rawEntry)
    if ('reason' in outcome) {
      refused.push({ name: serverName, reason: outcome.reason })
      continue
    }
    servers.push({
      name: serverName,
      entry: outcome.entry,
      fingerprint: fingerprintEntry(rawEntry),
      credentialRefs: outcome.credentialRefs,
    })
  }
  return { servers, refused }
}

/**
 * Reads and parses `<workspacePath>/.mcp.json`.
 * @param workspacePath - canonical workspace directory to read `.mcp.json` from.
 * @returns the parse result, or `undefined` when the file does not exist.
 * @throws {McpJsonError} per {@link parseMcpJson}.
 * @throws the underlying error for any file-system failure other than the file not existing.
 */
export async function readMcpJson(workspacePath: string): Promise<McpJsonReadResult | undefined> {
  const filePath = join(workspacePath, MCP_JSON_FILE)
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch (error) {
    return missingFile(error)
  }
  return parseMcpJson(text, filePath)
}

/**
 * Synchronous {@link readMcpJson}, for callers that must decide before returning, such as an `agent/created` listener.
 * @param workspacePath - canonical workspace directory to read `.mcp.json` from.
 * @returns the parse result, or `undefined` when the file does not exist.
 * @throws {McpJsonError} per {@link parseMcpJson}.
 * @throws the underlying error for any file-system failure other than the file not existing.
 */
export function readMcpJsonSync(workspacePath: string): McpJsonReadResult | undefined {
  const filePath = join(workspacePath, MCP_JSON_FILE)
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    return missingFile(error)
  }
  return parseMcpJson(text, filePath)
}

/**
 * Resolves a failed `.mcp.json` read; only a missing file is a defined outcome.
 * @param error - the read failure.
 * @returns `undefined` when the file does not exist.
 * @throws `error` for any other file-system failure.
 */
function missingFile(error: unknown): undefined {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
  throw error
}

/**
 * Computes a workspace server's fingerprint.
 * @param raw - the raw, unnormalized `.mcp.json` entry, including keys unknown to parsing.
 * @returns `sha256:<hex>` over the entry's canonical JSON: object keys sorted recursively, arrays kept in order.
 */
export function fingerprintEntry(raw: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(raw)).digest('hex')}`
}

/**
 * Substitutes every `${NAME}` placeholder in an entry's command, args, env values, url, and header values.
 * @param entry - the entry to substitute into; not mutated.
 * @param values - resolved credential values keyed by placeholder name.
 * @returns a new entry with every placeholder replaced.
 * @throws when a placeholder name has no entry in `values`, as `Error('credential <NAME> is not set')`.
 */
export function substitutePlaceholders(entry: WorkspaceServerEntry, values: ReadonlyMap<string, string>): WorkspaceServerEntry {
  const substitute = (value: string): string =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = values.get(name)
      if (resolved === undefined) throw new Error(`credential ${name} is not set`)
      return resolved
    })

  if (entry.transport === 'stdio') {
    return {
      transport: 'stdio',
      command: substitute(entry.command),
      args: entry.args.map(substitute),
      env: mapValues(entry.env, substitute),
    }
  }
  return {
    transport: 'streamable-http',
    url: substitute(entry.url),
    headers: mapValues(entry.headers, substitute),
  }
}

// ---- entry parsing ----

type EntryOutcome = { entry: WorkspaceServerEntry; credentialRefs: readonly string[] } | { reason: string }

/**
 * Dispatches a raw entry to the stdio or streamable-http parser by transport, or refuses it.
 * @param raw - the entry's fields, already known to be a plain object.
 * @returns the parsed entry and its credential references, or a refusal reason.
 */
function parseEntry(raw: Record<string, unknown>): EntryOutcome {
  const type = raw.type
  if ((type === undefined || type === 'stdio') && typeof raw.command === 'string') {
    return parseStdioEntry(raw.command, raw)
  }
  if (type === 'http' && typeof raw.url === 'string') {
    return parseHttpEntry(raw.url, raw)
  }
  if (type === 'sse') {
    return { reason: 'sse transport is not supported' }
  }
  return { reason: 'unsupported server entry' }
}

/**
 * Parses a stdio entry's `args`/`env` fields and validates placeholder syntax and literal secrets, in
 * `command`, `args[0..]`, `env.<key>` field order.
 * @param command - the entry's already-confirmed string `command`.
 * @param raw - the entry's fields.
 * @returns the parsed stdio entry and its credential references, or the first refusal reason found.
 */
function parseStdioEntry(command: string, raw: Record<string, unknown>): EntryOutcome {
  const args = parseStringArray(raw.args, 'args')
  if ('reason' in args) return args
  const env = parseStringRecord(raw.env, 'env')
  if ('reason' in env) return env

  const allNames: string[] = []

  const commandNames = scanPlaceholders(command, 'command')
  if ('reason' in commandNames) return commandNames
  allNames.push(...commandNames.value)

  for (const [index, value] of args.value.entries()) {
    const names = scanPlaceholders(value, `args[${index}]`)
    if ('reason' in names) return names
    allNames.push(...names.value)
  }

  for (const [key, value] of Object.entries(env.value)) {
    const names = scanPlaceholders(value, `env.${key}`)
    if ('reason' in names) return names
    if (SENSITIVE_ENV_PATTERN.test(key) && names.value.length === 0) {
      return { reason: `literal secret in env.${key}` }
    }
    allNames.push(...names.value)
  }

  return {
    entry: { transport: 'stdio', command, args: args.value, env: env.value },
    credentialRefs: sortedUnique(allNames),
  }
}

/**
 * Parses a streamable-http entry's `headers` field and validates placeholder syntax and literal secrets,
 * in `url`, `headers.<name>` field order.
 * @param url - the entry's already-confirmed string `url`.
 * @param raw - the entry's fields.
 * @returns the parsed streamable-http entry and its credential references, or the first refusal reason found.
 */
function parseHttpEntry(url: string, raw: Record<string, unknown>): EntryOutcome {
  const headers = parseStringRecord(raw.headers, 'headers')
  if ('reason' in headers) return headers

  const allNames: string[] = []

  const urlNames = scanPlaceholders(url, 'url')
  if ('reason' in urlNames) return urlNames
  allNames.push(...urlNames.value)

  for (const [name, value] of Object.entries(headers.value)) {
    const names = scanPlaceholders(value, `headers.${name}`)
    if ('reason' in names) return names
    if (isSensitiveHeaderName(name) && names.value.length === 0) {
      return { reason: `literal secret in headers.${name}` }
    }
    allNames.push(...names.value)
  }

  return {
    entry: { transport: 'streamable-http', url, headers: headers.value },
    credentialRefs: sortedUnique(allNames),
  }
}

/** `true` for a header name this parser treats as carrying a credential. */
function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) || SENSITIVE_ENV_PATTERN.test(name)
}

// ---- field-shape validation ----

type FieldArray = { value: readonly string[] } | { reason: string }
type FieldRecord = { value: Readonly<Record<string, string>> } | { reason: string }

/**
 * Validates an optional field as an array of strings.
 * @param raw - the field's raw value, or `undefined` when absent.
 * @param field - the field name, used to word the refusal reason.
 * @returns the array (empty when `raw` is `undefined`), or a refusal reason.
 */
function parseStringArray(raw: unknown, field: string): FieldArray {
  if (raw === undefined) return { value: [] }
  if (!Array.isArray(raw) || !raw.every((item): item is string => typeof item === 'string')) {
    return { reason: `${field} must be an array of strings` }
  }
  return { value: raw }
}

/**
 * Validates an optional field as an object mapping names to strings.
 * @param raw - the field's raw value, or `undefined` when absent.
 * @param field - `env` or `headers`, used to word the refusal reason.
 * @returns the record (empty when `raw` is `undefined`), or a refusal reason.
 */
function parseStringRecord(raw: unknown, field: 'env' | 'headers'): FieldRecord {
  if (raw === undefined) return { value: {} }
  if (!isPlainObject(raw) || !Object.values(raw).every((item): item is string => typeof item === 'string')) {
    return { reason: `${field} must map names to strings` }
  }
  return { value: raw as Record<string, string> }
}

// ---- placeholder scanning ----

/**
 * Scans one field's value for `${NAME}` placeholders, requiring every `${` occurrence to start a valid placeholder.
 * @param value - the field's string value.
 * @param field - the field label used in the refusal reason (`command`, `args[<i>]`, `env.<KEY>`, `url`, or `headers.<Name>`).
 * @returns the placeholder names found in order, or a refusal reason.
 */
function scanPlaceholders(value: string, field: string): { value: readonly string[] } | { reason: string } {
  const names: string[] = []
  let index = 0
  while (index < value.length) {
    const at = value.indexOf('${', index)
    if (at === -1) break
    // Sticky: a match must start exactly at `at`, so a `${` with no valid name is caught here rather
    // than matched later in the string by the next scan.
    const anchored = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/y
    anchored.lastIndex = at
    const match = anchored.exec(value)
    const full = match?.[0]
    const name = match?.[1]
    if (full === undefined || name === undefined) {
      return { reason: `unsupported placeholder syntax in ${field}` }
    }
    names.push(name)
    index = at + full.length
  }
  return { value: names }
}

// ---- generic helpers ----

/** `true` for a non-null, non-array object — the shape `.mcp.json` uses for every structured field. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Sorted, de-duplicated copy of `names`. */
function sortedUnique(names: readonly string[]): readonly string[] {
  return [...new Set(names)].sort()
}

/** A new record with `fn` applied to every value, preserving keys and their order. */
function mapValues(record: Readonly<Record<string, string>>, fn: (value: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]))
}

/**
 * Canonical JSON serialization for fingerprinting: object keys sorted recursively, arrays kept in order.
 * @param value - a JSON-parsed value (object, array, or JSON primitive); never receives `undefined`.
 * @returns the canonical JSON text.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
