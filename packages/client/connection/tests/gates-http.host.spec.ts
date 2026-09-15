/** Gate enforcement on the `/api` HTTP path, including endpoints claimed by a registered interceptor. */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { ApiGateDecision } from '../src/gates.ts'
import { API_PATH, apply, inject, type HostConnectionHandle } from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

/** Loopback authority every request names; the browser cookie is bound to it. */
const AUTHORITY = '127.0.0.1:3080'

/** Endpoint the test interceptor claims: two segments, as `TypertGateway` claims. */
const CLAIMED = 'demo/ping'

interface CapturedResponse {
  status: number | undefined
  headers: Record<string, string> | undefined
  body: string | undefined
}

interface MountedConnection {
  connection: HostConnectionHandle
  handle: WebRoute['handler']
  /** `name=value` Cookie header minted by the launch-token exchange. */
  cookie: string
}

const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map(dispose => dispose()))
})

function fakeWebServer(routes: WebRoute[]): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade: () => () => {},
    tapIndex: () => () => {},
    port: 0,
  }
}

function fakeRequest(method: string, url: string, headers: Record<string, string>, body?: string): IncomingMessage {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, { url, method, headers })
  return request
}

function recorder(): { response: ServerResponse; captured: () => CapturedResponse } {
  const chunks: Buffer[] = []
  const state: { status: number | undefined; headers: Record<string, string> | undefined } = {
    status: undefined,
    headers: undefined,
  }
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(code: number, values?: Record<string, string>) { state.status = code; state.headers = values; return this },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: string | Uint8Array) {
      if (value !== undefined) chunks.push(Buffer.from(value))
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return {
    response,
    captured: () => ({ ...state, body: chunks.length > 0 ? Buffer.concat(chunks).toString() : undefined }),
  }
}

/** Mount Connection with an empty trust list, then exchange its launch token for the browser cookie `/api` requires. */
async function mountConnection(): Promise<MountedConnection> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  provideBrowserCredentials(ctx)
  ctx.provide('webServer', fakeWebServer(routes) as WebServer)
  const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: [] })
  await fiber.await()
  disposers.push(() => fiber.dispose())
  const route = routes.find(candidate => candidate.path === API_PATH)
  if (route === undefined) throw new Error('client-connection: /api route was not registered')
  const connection = ctx.get('connection') as HostConnectionHandle
  const launch = new URL(connection.authenticatedUrl(`http://${AUTHORITY}`))
  const exchange = recorder()
  connection.authorizeIndex(fakeRequest('GET', `${launch.pathname}${launch.search}`, { host: AUTHORITY }), exchange.response)
  const setCookie = exchange.captured().headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('browser token exchange did not set a cookie')
  return { connection, handle: route.handler, cookie: setCookie.split(';', 1)[0]! }
}

/** POST one client-request envelope to `path`; `endpoint` overrides the envelope method taken from the path's tail. */
async function post(
  handle: WebRoute['handler'],
  path: string,
  options: { cookie?: string; endpoint?: string } = {},
): Promise<CapturedResponse> {
  const endpoint = options.endpoint ?? path.slice(`${API_PATH}/`.length)
  const envelope = JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: endpoint, payload: {} })
  const headers = {
    host: AUTHORITY,
    'content-type': 'application/json',
    ...options.cookie === undefined ? {} : { cookie: options.cookie },
  }
  const { response, captured } = recorder()
  await handle(fakeRequest('POST', path, headers, envelope), response)
  return captured()
}

describe('/api gate enforcement', () => {
  it('refuses a request without a browser session before consulting any gate', async () => {
    const { connection, handle } = await mountConnection()
    let authorized = 0
    connection.gates.register({
      order: 10,
      authorize: async () => {
        authorized += 1
        return { allow: true, principal: 'laptop', privileged: true }
      },
    })
    const response = await post(handle, '/api/session.list')
    expect(response.status).toBe(401)
    expect(authorized).toBe(0)
  })

  it('refuses an unadmitted browser session with the gate status and a Bearer challenge', async () => {
    const { connection, handle, cookie } = await mountConnection()
    connection.gates.register({
      order: 10,
      authorize: async () => ({ allow: false, status: 401, reason: 'missing bearer credential' }),
    })
    const response = await post(handle, '/api/session.list', { cookie })
    expect(response.status).toBe(401)
    expect(response.headers?.['www-authenticate']).toBe('Bearer')
    expect(response.body).toBe('missing bearer credential')
  })
})

describe('/api gate enforcement on interceptor-claimed endpoints', () => {
  /** A claimed endpoint, what the gate saw, and an authenticated sender. */
  interface Harness {
    handled: number
    authorized: number
    method: string | undefined
    send: (path: string, endpoint?: string) => Promise<CapturedResponse>
  }

  async function mounted(decision: ApiGateDecision): Promise<Harness> {
    const { connection, handle, cookie } = await mountConnection()
    const harness: Harness = {
      handled: 0,
      authorized: 0,
      method: undefined,
      send: (path, endpoint) => post(handle, path, { cookie, ...endpoint === undefined ? {} : { endpoint } }),
    }
    connection.rpc.intercept(
      '/api',
      endpoint => endpoint === CLAIMED,
      async () => {
        harness.handled += 1
        return { ok: true, value: 'pong' }
      },
    )
    connection.gates.register({
      order: 10,
      authorize: async (request) => {
        harness.authorized += 1
        harness.method = request.method
        return decision
      },
    })
    return harness
  }

  it('refuses a claimed endpoint without reaching the interceptor handler', async () => {
    const harness = await mounted({ allow: false, status: 401, reason: 'missing bearer credential' })
    const response = await harness.send(`/api/${CLAIMED}`)
    expect(response.status).toBe(401)
    expect(response.headers?.['www-authenticate']).toBe('Bearer')
    expect(response.body).toBe('missing bearer credential')
    expect(harness.handled).toBe(0)
  })

  it('answers a 403 gate denial on a claimed endpoint with no Bearer challenge', async () => {
    const harness = await mounted({ allow: false, status: 403, reason: 'gate failed' })
    const response = await harness.send(`/api/${CLAIMED}`)
    expect(response.status).toBe(403)
    expect(response.headers?.['www-authenticate']).toBeUndefined()
    expect(response.body).toBe('gate failed')
    expect(harness.handled).toBe(0)
  })

  it('consults the gates exactly once and dispatches to the interceptor when admitted', async () => {
    const harness = await mounted({ allow: true, principal: 'laptop', privileged: false })
    const response = await harness.send(`/api/${CLAIMED}`)
    expect(response.status).toBe(200)
    expect(harness.handled).toBe(1)
    expect(harness.authorized).toBe(1)
    expect(harness.method).toBe(CLAIMED)
  })

  it('consults the gates exactly once on an endpoint the interceptor does not claim', async () => {
    const harness = await mounted({ allow: true, principal: 'laptop', privileged: false })
    await harness.send('/api/session.list')
    expect(harness.handled).toBe(0)
    expect(harness.authorized).toBe(1)
    expect(harness.method).toBe('session.list')
  })

  it('gates the bare `/api` path, presenting it to the gates with no method', async () => {
    const harness = await mounted({ allow: true, principal: 'laptop', privileged: false })
    const response = await harness.send('/api', CLAIMED)
    expect(harness.authorized).toBe(1)
    expect(harness.method).toBeUndefined()
    expect(harness.handled).toBe(0)
    // Nothing serves the bare path, so the admitted request falls through to 404.
    expect(response.status).toBe(404)
  })
})
