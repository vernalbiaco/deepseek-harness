import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceServerEntry } from '../src/types.ts'
import { McpJsonError, fingerprintEntry, parseMcpJson, readMcpJson, substitutePlaceholders } from '../src/mcp-json.ts'

describe('parseMcpJson', () => {
  it('parses a valid stdio entry', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { command: 'node' } } }), 'source')
    expect(result.refused).toEqual([])
    expect(result.servers).toEqual([
      { name: 'fixture', entry: { transport: 'stdio', command: 'node', args: [], env: {} }, fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown as string, credentialRefs: [] },
    ])
  })

  it('parses a stdio entry with valid args and a non-sensitive literal env value', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { command: 'node', args: ['--flag'], env: { MODE: 'debug' } } } }), 'source')
    expect(result.refused).toEqual([])
    expect(result.servers).toEqual([
      { name: 'fixture', entry: { transport: 'stdio', command: 'node', args: ['--flag'], env: { MODE: 'debug' } }, fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown as string, credentialRefs: [] },
    ])
  })

  it('parses a valid streamable-http entry', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { type: 'http', url: 'https://example.com/mcp' } } }), 'source')
    expect(result.refused).toEqual([])
    expect(result.servers).toEqual([
      { name: 'fixture', entry: { transport: 'streamable-http', url: 'https://example.com/mcp', headers: {} }, fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown as string, credentialRefs: [] },
    ])
  })

  it('throws McpJsonError on invalid JSON, naming the source', () => {
    expect(() => parseMcpJson('not json', 'my-source')).toThrow(McpJsonError)
    try {
      parseMcpJson('not json', 'my-source')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(McpJsonError)
      expect((error as McpJsonError).source).toBe('my-source')
      expect((error as McpJsonError).message).toBe('my-source: invalid JSON')
    }
  })

  it('throws McpJsonError when the top level is not an object', () => {
    expect(() => parseMcpJson('[]', 'source')).toThrow(McpJsonError)
    expect(() => parseMcpJson('[]', 'source')).toThrow('source: top level is not an object')
  })

  it('throws McpJsonError when mcpServers is absent', () => {
    expect(() => parseMcpJson('{}', 'source')).toThrow('source: mcpServers is missing or not an object')
  })

  it('throws McpJsonError when mcpServers is not an object', () => {
    expect(() => parseMcpJson(JSON.stringify({ mcpServers: null }), 'source')).toThrow('source: mcpServers is missing or not an object')
    expect(() => parseMcpJson(JSON.stringify({ mcpServers: ['x'] }), 'source')).toThrow('source: mcpServers is missing or not an object')
  })

  it('refuses a server name that does not match the name pattern', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { 'bad name!': { command: 'node' } } }), 'source')
    expect(result.servers).toEqual([])
    expect(result.refused).toEqual([{ name: 'bad name!', reason: 'invalid server name' }])
  })

  it('refuses an entry that is not an object', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: 'node' } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'entry is not an object' }])
  })

  it('refuses an sse transport entry', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { type: 'sse', url: 'https://example.com' } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'sse transport is not supported' }])
  })

  it('refuses an entry with an unsupported shape', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { command: 123 } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'unsupported server entry' }])
  })

  it('refuses an http entry missing a string url', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { type: 'http' } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'unsupported server entry' }])
  })

  it('refuses stdio args that are not an array of strings', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { command: 'node', args: [1, 2] } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'args must be an array of strings' }])
  })

  it('refuses stdio env that does not map names to strings', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { command: 'node', env: { KEY: 1 } } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'env must map names to strings' }])
  })

  it('refuses http headers that do not map names to strings', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { type: 'http', url: 'https://example.com', headers: { 'X-Custom': 5 } } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'headers must map names to strings' }])
  })

  it('refuses unsupported placeholder syntax in command, naming the field', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { command: '${A:-b}' } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'unsupported placeholder syntax in command' }])
  })

  it('refuses unsupported placeholder syntax in an arg, naming the indexed field', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { command: 'node', args: ['${A:-b}'] } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'unsupported placeholder syntax in args[0]' }])
  })

  it('refuses unsupported placeholder syntax in an env value, naming the field', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { command: 'node', env: { MODE: '${A:-b}' } } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'unsupported placeholder syntax in env.MODE' }])
  })

  it('refuses unsupported placeholder syntax in url, naming the field', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { type: 'http', url: '${A:-b}' } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'unsupported placeholder syntax in url' }])
  })

  it('refuses unsupported placeholder syntax in a header value, naming the field', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { type: 'http', url: 'https://example.com', headers: { 'X-Custom': '${A:-b}' } } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'unsupported placeholder syntax in headers.X-Custom' }])
  })

  it('refuses a literal secret-shaped header name outside the fixed authorization/cookie set', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { type: 'http', url: 'https://example.com', headers: { 'X-Api-Key': 'literal-value' } } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'literal secret in headers.X-Api-Key' }])
    expect(result.refused[0]?.reason).not.toContain('literal-value')
  })

  it('refuses a literal Authorization header without leaking its value', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { type: 'http', url: 'https://example.com', headers: { Authorization: 'Bearer abc' } } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'literal secret in headers.Authorization' }])
    expect(result.refused[0]?.reason).not.toContain('abc')
  })

  it('refuses a literal secret-shaped env value', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { command: 'node', env: { GITHUB_TOKEN: 'ghp_abc123' } } } }), 'source')
    expect(result.refused).toEqual([{ name: 'fixture', reason: 'literal secret in env.GITHUB_TOKEN' }])
    expect(result.refused[0]?.reason).not.toContain('ghp_abc123')
  })

  it('accepts a placeholder-carrying Authorization header and collects its credential reference', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { fixture: { type: 'http', url: 'https://example.com', headers: { Authorization: 'Bearer ${TOK}' } } } }), 'source')
    expect(result.refused).toEqual([])
    expect(result.servers[0]?.credentialRefs).toEqual(['TOK'])
  })
})

describe('readMcpJson', () => {
  let dir: string

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('returns undefined when .mcp.json does not exist', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-workspace-'))
    await expect(readMcpJson(dir)).resolves.toBeUndefined()
  })

  it('reads and parses an existing .mcp.json', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-workspace-'))
    await writeFile(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: 'node' } } }))
    const result = await readMcpJson(dir)
    expect(result?.servers).toEqual([
      { name: 'fixture', entry: { transport: 'stdio', command: 'node', args: [], env: {} }, fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown as string, credentialRefs: [] },
    ])
  })

  it('rethrows a file-system error other than ENOENT', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-workspace-'))
    // A regular file used as the "workspace directory" makes the join()ed
    // .mcp.json read fail with ENOTDIR, not ENOENT — a real, unmocked
    // non-ENOENT failure.
    const notADirectory = join(dir, 'not-a-directory')
    await writeFile(notADirectory, 'x')
    await expect(readMcpJson(notADirectory)).rejects.toThrow(/ENOTDIR/)
  })
})

describe('fingerprintEntry', () => {
  it('changes when an unknown key is added', () => {
    const a = fingerprintEntry({ command: 'node' })
    const b = fingerprintEntry({ command: 'node', extra: 'value' })
    expect(a).not.toBe(b)
  })

  it('is unaffected by object key order', () => {
    const a = fingerprintEntry({ command: 'node', args: ['x'] })
    const b = fingerprintEntry({ args: ['x'], command: 'node' })
    expect(a).toBe(b)
  })

  it('changes when a placeholder-free, non-sensitive field value changes, independent of substitution', () => {
    const before = fingerprintEntry({ type: 'http', url: 'https://example.com', headers: { 'X-Custom': 'v1' } })
    const after = fingerprintEntry({ type: 'http', url: 'https://example.com', headers: { 'X-Custom': 'v2' } })
    expect(before).not.toBe(after)

    // substitutePlaceholders operates on the already-parsed entry, not on the
    // raw JSON fingerprintEntry hashes, and leaves a placeholder-free value
    // unchanged.
    const entry: WorkspaceServerEntry = { transport: 'streamable-http', url: 'https://example.com', headers: { 'X-Custom': 'v1' } }
    expect(substitutePlaceholders(entry, new Map())).toEqual(entry)
  })
})

describe('substitutePlaceholders', () => {
  it('replaces placeholders in every stdio field', () => {
    const entry: WorkspaceServerEntry = {
      transport: 'stdio',
      command: '${CMD}',
      args: ['${ARG}', 'literal'],
      env: { VALUE: '${ENV_VAL}' },
    }
    const values = new Map([['CMD', 'node'], ['ARG', '--flag'], ['ENV_VAL', 'resolved']])
    expect(substitutePlaceholders(entry, values)).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['--flag', 'literal'],
      env: { VALUE: 'resolved' },
    })
  })

  it('replaces placeholders in every streamable-http field', () => {
    const entry: WorkspaceServerEntry = {
      transport: 'streamable-http',
      url: '${BASE_URL}/mcp',
      headers: { Authorization: 'Bearer ${TOK}' },
    }
    const values = new Map([['BASE_URL', 'https://example.com'], ['TOK', 'resolved-token']])
    expect(substitutePlaceholders(entry, values)).toEqual({
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer resolved-token' },
    })
  })

  it('throws when a placeholder has no matching value', () => {
    const entry: WorkspaceServerEntry = { transport: 'stdio', command: '${MISSING}', args: [], env: {} }
    expect(() => substitutePlaceholders(entry, new Map())).toThrow('credential MISSING is not set')
  })
})
