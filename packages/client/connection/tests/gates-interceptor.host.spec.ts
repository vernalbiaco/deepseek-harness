/** Gate enforcement on `/api` endpoints claimed by a registered interceptor. */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { ApiGateDecision } from '../src/gates.ts'
import { apply, inject } from '../src/index.ts'

/** Endpoint the test interceptor claims: two segments, as `TypertGateway` claims. */
const CLAIMED = 'demo/ping'

/** Structural webServer fake capturing the registered `/api` route. */
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

/** One mounted Connection: its `/api` route, a claimed endpoint, and what the gate saw. */
interface Harness {
  /** The registered `/api` route handler. */
  handle: WebRoute['handler']
  /** Times the interceptor's handler ran. */
  handled: number
  /** Times a gate was consulted. */
  authorized: number
  /** The `method` of the most recent gate consultation. */
  method: string | undefined
}

/**
 * Mount Connection with an empty trust list, an interceptor claiming
 * {@link CLAIMED}, and one gate returning `decision`.
 * @param decision - the verdict the single registered gate returns.
 * @returns the mounted route handler and its live counters.
 */
async function mounted(decision: ApiGateDecision): Promise<Harness> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('webServer', fakeWebServer(routes) as WebServer)
  const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: [] })
  await fiber.await()
  const [route] = routes
  if (route === undefined) throw new Error('client-connection: /api route was not registered')
  const harness: Harness = { handle: route.handler, handled: 0, authorized: 0, method: undefined }
  ctx.connection.rpc.intercept(
    '/api',
    endpoint => endpoint === CLAIMED,
    async () => {
      harness.handled += 1
      return { ok: true, value: 'pong' }
    },
    { authority: 'trusted-host' },
  )
  ctx.connection.gates.register({
    order: 10,
    authorize: async (request) => {
      harness.authorized += 1
      harness.method = request.method
      return decision
    },
  })
  return harness
}

/**
 * POST one path from a loopback origin and capture the response.
 * @param handle - the mounted `/api` route handler.
 * @param path - absolute request path, `/api` itself included.
 * @param endpoint - RPC method carried in the envelope; defaults to the path's tail.
 * @returns the captured status, `writeHead` headers, and body.
 */
async function post(
  handle: WebRoute['handler'],
  path: string,
  endpoint = path.slice('/api/'.length),
): Promise<{ status: number | undefined; headers: Record<string, string> | undefined; body: string | undefined }> {
  const envelope = JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: endpoint, payload: {} })
  const request = Readable.from([Buffer.from(envelope)]) as unknown as IncomingMessage
  Object.assign(request, {
    url: path,
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
  })
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
  await handle(request, response)
  return {
    status: state.status,
    headers: state.headers,
    body: chunks.length > 0 ? Buffer.concat(chunks).toString() : undefined,
  }
}

describe('/api gate enforcement on interceptor-claimed endpoints', () => {
  it('refuses a claimed endpoint without reaching the interceptor handler', async () => {
    const harness = await mounted({ allow: false, status: 401, reason: 'missing bearer credential' })
    const response = await post(harness.handle, `/api/${CLAIMED}`)
    expect(response.status).toBe(401)
    expect(response.headers?.['www-authenticate']).toBe('Bearer')
    expect(response.body).toBe('missing bearer credential')
    expect(harness.handled).toBe(0)
  })

  it('answers a 403 gate denial on a claimed endpoint with no Bearer challenge', async () => {
    const harness = await mounted({ allow: false, status: 403, reason: 'gate failed' })
    const response = await post(harness.handle, `/api/${CLAIMED}`)
    expect(response.status).toBe(403)
    expect(response.headers?.['www-authenticate']).toBeUndefined()
    expect(response.body).toBe('gate failed')
    expect(harness.handled).toBe(0)
  })

  it('consults the gates exactly once and dispatches to the interceptor when admitted', async () => {
    const harness = await mounted({ allow: true, principal: 'laptop', privileged: false })
    const response = await post(harness.handle, `/api/${CLAIMED}`)
    expect(response.status).toBe(200)
    expect(harness.handled).toBe(1)
    expect(harness.authorized).toBe(1)
    expect(harness.method).toBe(CLAIMED)
  })

  it('consults the gates exactly once on an endpoint the interceptor does not claim', async () => {
    const harness = await mounted({ allow: true, principal: 'laptop', privileged: false })
    await post(harness.handle, '/api/session.list')
    expect(harness.handled).toBe(0)
    expect(harness.authorized).toBe(1)
    expect(harness.method).toBe('session.list')
  })

  it('gates the bare `/api` path, presenting it to the gates with no method', async () => {
    const harness = await mounted({ allow: true, principal: 'laptop', privileged: false })
    const response = await post(harness.handle, '/api', CLAIMED)
    expect(harness.authorized).toBe(1)
    expect(harness.method).toBeUndefined()
    expect(harness.handled).toBe(0)
    // No API Proxy is mounted, so the admitted request falls through to 404.
    expect(response.status).toBe(404)
  })
})
