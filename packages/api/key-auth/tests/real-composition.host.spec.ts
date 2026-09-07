/**
 * REAL-composition coverage for the key gate: a test-only cordis.yml booted
 * through the vendored Loader binds a real HTTP server on loopback and mounts
 * the webserver, the local credential provider, an ApiProxy stand-in, the
 * connection transport, the Typert registry and Gateway over a Remote fixture,
 * and this package's gate. Every assertion crosses that listening socket with a
 * real HTTP client and the real `ws` client — the global `WebSocket` cannot set
 * `Authorization`, so it admits no keyed arm and cannot tell a rejected upgrade
 * from a server that never listened.
 *
 * Each case runs against two compositions that differ in one row. The gated
 * one carries `dsh-api-key-auth`; the ungated one is otherwise identical and
 * registers no gate at all, which is the loopback profile shipped today. The
 * ungated composition is what makes the privileged-method `403` a real
 * result: `credentials.describe` would answer `403` just as readily if the
 * bind failed connection's loopback trust fence, and only the same call
 * succeeding on the ungated profile separates "the gate withheld privilege"
 * from "the fence refused the request".
 *
 * The ApiProxy is the one stand-in. The shipped `ApiProxyService` injects
 * eleven product services (agents, sessions, tools, llm, …) — the whole
 * application — while the code under test here is connection's `/api` route,
 * its privileged-method decision, both upgrade routes, and this package's
 * gate, all of them the real shipped implementations either way. The stand-in
 * serves the two methods these arms call and the two idle event streams the
 * downlinks pump, and its `credentials.describe` reads the real
 * `ctx.credentials` seam, so the ungated control arm observes the request
 * reaching the credential plane rather than a canned constant.
 *
 * The Gateway is the real shipped one, and it holds the single interceptor seat
 * on the `/api` channel in every default profile. It is mounted here because an
 * interceptor claims its endpoints ahead of that fallback: without a claimed
 * endpoint in the composition, no arm crosses the socket into the path where an
 * ungated interceptor would answer an anonymous caller.
 */

import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '@deepseek-ai/dsh-client-connection'
import type {
  CredentialView, HostFrame, MuxFrame, RpcRequest, RpcResponse, ServerResponse,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import * as ApiKeyAuth from '../src/index.ts'

const WEBSERVER = '@deepseek-ai/dsh-host-webserver'
const CREDENTIALS_LOCAL = '@deepseek-ai/dsh-credentials-local'
const CONNECTION = '@deepseek-ai/dsh-client-connection'
const KEY_AUTH = '@deepseek-ai/dsh-api-key-auth'
const TYPERT_REGISTRY = '@deepseek-ai/dsh-typert-registry'
const GATEWAY = '@deepseek-ai/dsh-api-gateway'
/** Loader specifier of the in-file ApiProxy stand-in; never a published package. */
const API_PROXY = '@deepseek-ai/dsh-api-key-auth-test-api-proxy'
/** Loader specifier of the in-file Remote fixture; never a published package. */
const REMOTE_FIXTURE = '@deepseek-ai/dsh-api-key-auth-test-remote'

/** The Gateway-claimed endpoint: two segments, so the `/api` fallback never sees it. */
const CLAIMED_ENDPOINT = 'demo/echo'

/** Audit label of the single configured key. */
const KEY_NAME = 'laptop'
/** Credential reference holding the key; a bare POSIX identifier, as `credentialRef` requires. */
const SECRET_REF = 'DSH_API_KEY_AUTH_REAL_COMPOSITION'
/** The accepted secret, supplied through the inherited environment for this test only. */
const SECRET = 'real-composition-secret-value'

/** Resolves when `signal` aborts, so an idle event source parks instead of ending the stream. */
function untilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

/**
 * An event stream that emits nothing and ends only on cancellation: these
 * cases observe whether the upgrade is accepted, not what it carries.
 */
async function * idle<F>(signal: AbortSignal): AsyncGenerator<RpcRequest<F>> {
  await untilAbort(signal)
}

/**
 * The composition's `apiProxy` row. It serves only what these arms reach:
 * `session.list` (the ordinary method), `credentials.describe` (a
 * `CONFIGURATION_METHODS` member, answered from the real credential seam), and
 * the two idle downlink sources. Registered under the `apiProxy` name, so
 * connection resolves it exactly as it resolves the shipped gateway.
 */
class StandInApiProxy extends Service {
  static inject = ['credentials']

  constructor(ctx: Context) {
    super(ctx, 'apiProxy')
  }

  readonly sessions = {
    list: (request: RpcRequest<unknown>): Promise<RpcResponse<{ items: [] }>> =>
      Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }),
  }

  readonly credentials = {
    describe: async (
      request: RpcRequest<{ refs: string[] }>,
    ): Promise<RpcResponse<{ credentials: Record<string, CredentialView> }>> => {
      const entries = await Promise.all(request.payload.refs.map(async ref =>
        [ref, await this.ctx.credentials.describe(credentialRef(ref))] as const))
      return { rpcId: request.rpcId, result: { ok: true, value: { credentials: Object.fromEntries(entries) } } }
    },
  }

  readonly events = {
    mux: (_request: RpcRequest<{}>, signal: AbortSignal): AsyncIterable<RpcRequest<MuxFrame>> => idle(signal),
    host: (_request: RpcRequest<{}>, signal: AbortSignal): AsyncIterable<RpcRequest<HostFrame>> => idle(signal),
  }
}

/** Times the Remote fixture's method ran; an unkeyed caller must leave it at zero. */
let echoCalls = 0

/**
 * The composition's Remote row. The Typert Gateway interceptor claims this
 * service's `demo/echo` endpoint on the shared `/api` channel from its SRC
 * marker alone — no generated definitions — so requests to it are answered by
 * the interceptor and never reach the `/api` fallback.
 */
class RemoteFixture extends Service {
  readonly typertRemote = bindTypertRemote(this, 'demo')

  constructor(ctx: Context) {
    super(ctx, 'demo')
  }

  @Remote
  echo(request: { readonly value: string }): { readonly echoed: string } {
    echoCalls += 1
    return { echoed: request.value }
  }
}

const contexts: Context[] = []
const roots: string[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  await Promise.all(sockets.splice(0).map(async (socket) => {
    if (socket.readyState === WebSocket.CLOSED) return
    const closed = once(socket, 'close')
    socket.close()
    await closed
  }))
  // Dispose newest first: the ungated composition holds no reference to the
  // gated one, but each owns a listening socket that must be released before
  // its temp directory is removed.
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
  for (const root of roots.splice(0)) {
    // maxRetries absorbs teardown stragglers (a late credential-file handle)
    // that can otherwise race the recursive scan into ENOTEMPTY.
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
  vi.unstubAllEnvs()
  echoCalls = 0
})

/**
 * Write a test-only cordis.yml and boot it through the real Loader.
 * @param gated Whether the `dsh-api-key-auth` row is present.
 * @returns the booted context and the origin its webserver actually bound.
 */
async function loadComposition(gated: boolean): Promise<{ ctx: Context; base: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-api-key-auth-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    `- name: '${WEBSERVER}'`,
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    `- name: '${CREDENTIALS_LOCAL}'`,
    '  config:',
    `    path: ${JSON.stringify(join(root, 'credentials.yaml'))}`,
    '    watch: false',
    `- name: '${API_PROXY}'`,
    `- name: '${CONNECTION}'`,
    `- name: '${TYPERT_REGISTRY}'`,
    `- name: '${GATEWAY}'`,
    `- name: '${REMOTE_FIXTURE}'`,
    ...gated
      ? [
        `- name: '${KEY_AUTH}'`,
        '  config:',
        '    keys:',
        `      - name: ${KEY_NAME}`,
        `        secret: ${SECRET_REF}`,
      ]
      : [],
    '',
  ].join('\n'))

  const context = new Context()
  contexts.push(context)
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    [WEBSERVER, HttpServer],
    [CREDENTIALS_LOCAL, LocalCredentialProvider],
    [API_PROXY, StandInApiProxy],
    [CONNECTION, Connection],
    [TYPERT_REGISTRY, TypertRegistry],
    [GATEWAY, TypertGateway],
    [REMOTE_FIXTURE, RemoteFixture],
    [KEY_AUTH, ApiKeyAuth],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return { ctx: context, base: `http://127.0.0.1:${String(context.webServer.port)}` }
}

/** One `/api/<method>` POST, with the bearer key when `key` is given. */
async function post(
  base: string,
  method: string,
  payload: unknown,
  key?: string,
): Promise<{ status: number; challenge: string | null; text: string }> {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...key === undefined ? {} : { authorization: `Bearer ${key}` },
    },
    body: JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method, payload }),
  })
  return { status: response.status, challenge: response.headers.get('www-authenticate'), text: await response.text() }
}

/** The RPC envelope a dispatched call answered with; fails loudly on a carrier-level status. */
function dispatched(response: { status: number; text: string }): ServerResponse {
  expect(response.status).toBe(200)
  return JSON.parse(response.text) as ServerResponse
}

/** Open an upgrade to `path`, with the bearer key when `key` is given. */
function upgrade(base: string, path: string, key?: string): WebSocket {
  const socket = new WebSocket(
    `ws://${new URL(base).host}${path}`,
    key === undefined ? {} : { headers: { authorization: `Bearer ${key}` } },
  )
  sockets.push(socket)
  return socket
}

/** How one upgrade attempt settled: the rejection's message, or `accepted`. */
async function upgradeOutcome(socket: WebSocket): Promise<string> {
  return await once(socket, 'open').then(() => 'accepted', (error: unknown) => (error as Error).message)
}

describe('real composition: the key gate on a listening server', () => {
  // The 60s budget covers this file's cold static imports (webserver, the
  // credential provider, and the whole connection/apiproxy graph through tsx);
  // the Loader resolves nothing itself — `loader.internal` is a module map.
  it('refuses an unkeyed /api call with 401 and a Bearer challenge, and admits the keyed one', { timeout: 60_000 }, async () => {
    vi.stubEnv(SECRET_REF, SECRET)
    const { base } = await loadComposition(true)

    const unkeyed = await post(base, 'session.list', {})
    expect(unkeyed.status).toBe(401)
    expect(unkeyed.challenge).toBe('Bearer')
    expect(unkeyed.text).toBe('missing bearer credential')

    const wrongKey = await post(base, 'session.list', {}, 'not-the-secret')
    expect(wrongKey.status).toBe(401)
    expect(wrongKey.text).toBe('unrecognized credential')

    const keyed = dispatched(await post(base, 'session.list', {}, SECRET))
    expect(keyed).toEqual({ type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: { items: [] } } })
  })

  it('refuses an unkeyed call to an interceptor-claimed endpoint before its Remote runs', { timeout: 60_000 }, async () => {
    vi.stubEnv(SECRET_REF, SECRET)
    const { base } = await loadComposition(true)
    const payload = { args: { request: { value: 'hello' } } }

    const unkeyed = await post(base, CLAIMED_ENDPOINT, payload)
    expect(unkeyed.status).toBe(401)
    expect(unkeyed.challenge).toBe('Bearer')
    expect(unkeyed.text).toBe('missing bearer credential')
    // The interceptor answers claimed endpoints ahead of the `/api` fallback,
    // so this counter is what separates "the gate refused it" from "the
    // Gateway ran and happened to fail".
    expect(echoCalls).toBe(0)

    const keyed = dispatched(await post(base, CLAIMED_ENDPOINT, payload, SECRET))
    expect(keyed).toEqual({
      type: 'server-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: { echoed: 'hello' } },
    })
    expect(echoCalls).toBe(1)
  })

  it('refuses a privileged method for a keyed caller while the ungated profile still serves it', { timeout: 60_000 }, async () => {
    vi.stubEnv(SECRET_REF, SECRET)
    const gated = await loadComposition(true)
    const ungated = await loadComposition(false)

    const refused = await post(gated.base, 'credentials.describe', { refs: [SECRET_REF] }, SECRET)
    expect(refused.status).toBe(403)
    expect(refused.text).toBe('forbidden')

    // Control arm: the identical call, on rows differing only by the gate.
    // Reaching the real credential seam is what proves the 403 above came from
    // the withheld privilege and not from the loopback trust fence — and the
    // view it returns carries source and writability, never the value.
    const served = dispatched(await post(ungated.base, 'credentials.describe', { refs: [SECRET_REF] }))
    expect(served.result).toEqual({
      ok: true,
      value: { credentials: { [SECRET_REF]: { configured: true, source: 'env', writable: false } } },
    })
    expect(JSON.stringify(served)).not.toContain(SECRET)
  })

  it.each([MUX_EVENTS_PATH, HOST_EVENTS_PATH])('rejects an unkeyed upgrade to %s at the socket and accepts the keyed one', { timeout: 60_000 }, async (path) => {
    vi.stubEnv(SECRET_REF, SECRET)
    const { base } = await loadComposition(true)

    expect(await upgradeOutcome(upgrade(base, path))).toContain('403')
    expect(await upgradeOutcome(upgrade(base, path, 'not-the-secret'))).toContain('403')

    // The positive arm is what makes the two above meaningful: the route is
    // registered and the server is listening, so the rejections are the gate's.
    expect(await upgradeOutcome(upgrade(base, path, SECRET))).toBe('accepted')
  })

  it.each([MUX_EVENTS_PATH, HOST_EVENTS_PATH])('accepts an unkeyed upgrade to %s on the ungated profile', { timeout: 60_000 }, async (path) => {
    const { base } = await loadComposition(false)

    expect(await upgradeOutcome(upgrade(base, path))).toBe('accepted')
  })
})
