/**
 * Tests for the reusable connection supervisor surface: `fetchToolDefinitions`
 * (fetch phase without registry side effects), `createRegistrySink` (the
 * default registry-publishing sink), and `startConnection`'s `sink` /
 * `resolveConfig` options plus `stopped()`. Isolated file so vi.mock of the
 * MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type JsonValue } from '@deepseek-ai/dsh-tools'
import { createRegistrySink, fetchToolDefinitions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import type { ToolBridgeOptions, ToolDefinitions, ToolSink } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

// ---- Mock MCP SDK (startConnection tests only; construct via `new Client()`) ----

// vi.mock factories are hoisted above every import/const, so the mock fns and
// class must be created inside vi.hoisted to exist when the factories run.
const { mockConnect, mockClose, mockListTools, mockCallTool, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockCallTool = vi.fn<(
    _params?: Record<string, unknown>, _compatibilitySchema?: unknown, _options?: unknown,
  ) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    if (request.method === 'tools/call') return await mockCallTool(request.params, undefined, options)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = mockSetNotificationHandler
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, mockCallTool, MockClient, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

// vi.mock is hoisted above static imports, so the modules under test see the
// mocked SDK even through a static import.
import { resolveReconnectPolicy, startConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'

// ---- Helpers ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  execution?: { taskSupport?: 'optional' | 'required' | 'forbidden' }
}

interface MockCallResult {
  content: JsonValue[]
  structuredContent?: JsonValue
  isError?: boolean
}

/** Plain object satisfying the fetchToolDefinitions Client surface, not the mocked SDK class. */
function createMockClient(tools: MockTool[], callResult: MockCallResult = { content: [{ type: 'text', text: 'ok' }] }) {
  const listTools = vi.fn(async (
    _params?: Record<string, unknown>,
  ): Promise<{ tools: MockTool[]; nextCursor: string | undefined }> => ({ tools, nextCursor: undefined }))
  const callTool = vi.fn(async (
    _params?: Record<string, unknown>,
    _compatibilitySchema?: unknown,
    _options?: unknown,
  ): Promise<Record<string, unknown>> => ({ ...callResult }))
  return {
    listTools,
    callTool,
    request: vi.fn(async (
      request: { method: string; params?: Record<string, unknown> },
      _schema: unknown,
      options?: unknown,
    ): Promise<unknown> => {
      if (request.method === 'tools/list') return listTools(request.params)
      if (request.method === 'tools/call') return callTool(request.params, undefined, options)
      throw new Error(`unexpected MCP request: ${request.method}`)
    }),
    setNotificationHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

const defaultOpts: ToolBridgeOptions = {
  serverName: 'srv',
  toolCallTimeoutMs: 60_000,
}

function stdioConfig(reconnect?: Config['reconnect']): Config {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    ...reconnect === undefined ? {} : { reconnect },
  }
}

/** The tool list the mock server advertises after a successful (re)connect. */
function listing(...names: string[]): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return {
    tools: names.map(name => ({ name, inputSchema: { type: 'object' } })),
    nextCursor: undefined,
  }
}

// ---- Tests ----

describe('fetchToolDefinitions', () => {
  it('returns definitions keyed by publicToolName and registers nothing', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([
      { name: 'greet', inputSchema: { type: 'object' } },
      { name: 'add', inputSchema: { type: 'object' } },
    ])

    const definitions = await fetchToolDefinitions(client as never, ctx, defaultOpts)

    expect([...definitions.keys()]).toEqual(['mcp__srv__greet', 'mcp__srv__add'])
    expect(ctx.tools.get('mcp__srv__greet')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__add')).toBeUndefined()
  })

  it('rejects a tool list where one raw name appears twice', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient([
      { name: 'dup', inputSchema: { type: 'object' } },
      { name: 'dup', inputSchema: { type: 'object' } },
    ])

    await expect(fetchToolDefinitions(client as never, ctx, defaultOpts))
      .rejects.toThrow(/listed tool "dup" more than once/)
  })
})

describe('createRegistrySink', () => {
  it('registers all, swaps a smaller set, and clears idempotently', async () => {
    const ctx = await mountRegistry()
    const sink = createRegistrySink(ctx, 'srv')

    const first = await fetchToolDefinitions(
      createMockClient([
        { name: 'a', inputSchema: { type: 'object' } },
        { name: 'b', inputSchema: { type: 'object' } },
      ]) as never,
      ctx,
      defaultOpts,
    )
    sink.replace(first, 'contain')
    expect(ctx.tools.get('mcp__srv__a')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__b')).toBeDefined()

    const second = await fetchToolDefinitions(
      createMockClient([{ name: 'a', inputSchema: { type: 'object' } }]) as never,
      ctx,
      defaultOpts,
    )
    sink.replace(second, 'contain')
    expect(ctx.tools.get('mcp__srv__a')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__b')).toBeUndefined()

    sink.clear()
    expect(ctx.tools.get('mcp__srv__a')).toBeUndefined()
    sink.clear()
    expect(ctx.tools.get('mcp__srv__a')).toBeUndefined()
  })

  it('rolls back and logs on a foreign registration; throw rethrows after rollback', async () => {
    const ctx = await mountRegistry()
    ctx.tools.register({
      name: 'mcp__srv__taken',
      description: 'Squatter',
      parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'squatter',
    })
    const errors: string[] = []
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
    const definitions = await fetchToolDefinitions(
      createMockClient([
        { name: 'free', inputSchema: { type: 'object' } },
        { name: 'taken', inputSchema: { type: 'object' } },
      ]) as never,
      ctx,
      defaultOpts,
    )

    const containSink = createRegistrySink(ctx, 'srv')
    containSink.replace(definitions, 'contain')
    expect(ctx.tools.get('mcp__srv__free')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__taken')).toBeDefined() // the squatter, untouched
    expect(errors.some(line => line.includes('tool registration failed, no tools registered'))).toBe(true)

    const throwSink = createRegistrySink(ctx, 'srv')
    expect(() => { throwSink.replace(definitions, 'throw') }).toThrow()
    expect(ctx.tools.get('mcp__srv__free')).toBeUndefined()
  })
})

describe('startConnection options', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue(listing('remote'))
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('delivers each generation to a custom sink and never touches the registry', async () => {
    const ctx = await mountRegistry()
    const registerSpy = vi.spyOn(ctx.tools, 'register')
    const replaceCalls: ToolDefinitions[] = []
    const clearMock = vi.fn()
    const sink: ToolSink = {
      replace: (definitions) => { replaceCalls.push(definitions) },
      clear: clearMock,
    }

    const handle = startConnection(ctx, stdioConfig(), resolveReconnectPolicy(undefined, 'reconnect'), { sink })
    await handle.ready

    expect(replaceCalls).toHaveLength(1)
    expect([...replaceCalls[0]!.keys()]).toEqual(['mcp__srv__remote'])
    expect(registerSpy).not.toHaveBeenCalled()

    await handle.dispose()
    expect(clearMock).toHaveBeenCalled()
  })

  it('calls resolveConfig once per attempt and retries after a rejection', async () => {
    const ctx = await mountRegistry()
    let calls = 0
    const resolveConfig = vi.fn(async (): Promise<Config> => {
      calls += 1
      if (calls === 1) throw new Error('credential missing')
      return stdioConfig()
    })
    const replaceCalls: ToolDefinitions[] = []
    const sink: ToolSink = { replace: (definitions) => { replaceCalls.push(definitions) }, clear: vi.fn() }

    const handle = startConnection(
      ctx,
      stdioConfig(),
      resolveReconnectPolicy({ initialDelayMs: 1, maxDelayMs: 8, maxAttempts: 3 }, 'reconnect'),
      { sink, resolveConfig },
    )
    const outcome = await handle.ready

    expect(outcome.error).toBeInstanceOf(Error)
    expect((outcome.error as Error).message).toBe('credential missing')

    await vi.waitFor(() => { expect(replaceCalls).toHaveLength(1) })
    expect(resolveConfig).toHaveBeenCalledTimes(2)

    await handle.dispose()
  })

  it('suppresses retry reporting when disposal owns a pending resolveConfig rejection', async () => {
    const ctx = await mountRegistry()
    const gate: PromiseWithResolvers<Config> = Promise.withResolvers()
    const warns: string[] = []
    ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn

    const handle = startConnection(
      ctx,
      stdioConfig(),
      resolveReconnectPolicy(undefined, 'reconnect'),
      { resolveConfig: () => gate.promise },
    )
    const disposing = handle.dispose()
    gate.reject(new Error('disposed before resolve'))
    await disposing
    await handle.ready

    expect(warns.some(line => line.includes('connection attempt failed'))).toBe(false)
    expect(instances).toHaveLength(0)
  })

  it('does not resume a connection attempt whose resolveConfig resolves after dispose()', async () => {
    const ctx = await mountRegistry()
    const gate: PromiseWithResolvers<Config> = Promise.withResolvers()

    const handle = startConnection(
      ctx,
      stdioConfig(),
      resolveReconnectPolicy(undefined, 'reconnect'),
      { resolveConfig: () => gate.promise },
    )
    const disposing = handle.dispose()
    gate.resolve(stdioConfig())
    await disposing

    // No generation was ever created for the disposed attempt: no stray
    // transport/server process to leak or close.
    expect(instances).toHaveLength(0)
    expect(mockConnect).not.toHaveBeenCalled()
    // A disposed supervisor must never report a successful startup.
    const outcome = await handle.ready
    expect(outcome.error).toBeDefined()
  })

  it('writes connection attempt failures through describeError', async () => {
    const ctx = await mountRegistry()
    const warns: string[] = []
    ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
    ctx.logger.error = (() => {}) as typeof ctx.logger.error
    mockConnect.mockRejectedValue(new Error('spawn /opt/tok-secret-value/bin ENOENT'))
    let calls = 0

    const handle = startConnection(
      ctx,
      stdioConfig(),
      resolveReconnectPolicy({ initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 }, 'reconnect'),
      {
        resolveConfig: async () => {
          calls += 1
          if (calls === 1) throw new Error('config for tok-secret-value rejected')
          return stdioConfig()
        },
        describeError: error => String(error).replaceAll('tok-secret-value', '${TOKEN}'),
      },
    )
    await handle.ready
    await vi.waitFor(() => { expect(handle.stopped()).toBe(true) })
    await handle.dispose()

    expect(warns.filter(line => line.includes('connection attempt failed'))).toEqual([
      'mcp-client(srv): connection attempt failed: Error: config for ${TOKEN} rejected',
      'mcp-client(srv): connection attempt failed: Error: spawn /opt/${TOKEN}/bin ENOENT',
    ])
  })

  it('stopped() is false while connected, true after budget exhaustion, and true after dispose()', async () => {
    const ctx = await mountRegistry()

    const connected = startConnection(ctx, stdioConfig(), resolveReconnectPolicy(undefined, 'reconnect'))
    await connected.ready
    expect(connected.stopped()).toBe(false)
    await connected.dispose()
    expect(connected.stopped()).toBe(true)

    const alwaysFails = startConnection(
      ctx,
      stdioConfig(),
      resolveReconnectPolicy({ initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 1 }, 'reconnect'),
      { resolveConfig: async () => { throw new Error('never available') } },
    )
    expect(alwaysFails.stopped()).toBe(false)
    await alwaysFails.ready
    await vi.waitFor(() => { expect(alwaysFails.stopped()).toBe(true) })
    await alwaysFails.dispose()
  })
})
