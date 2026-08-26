/** Gate enforcement on the `/api` HTTP path. */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, inject } from '../src/index.ts'

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

/** Mounts Connection with an empty trust list and returns its `/api` route handler. */
async function mounted(): Promise<{ ctx: Context; handle: WebRoute['handler'] }> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('webServer', fakeWebServer(routes) as WebServer)
  const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: [] })
  await fiber.await()
  return { ctx, handle: routes[0].handler }
}

/** POST `/api/<method>` from a loopback origin and capture the response. */
async function post(
  handle: WebRoute['handler'],
  method: string,
): Promise<{ status?: number; headers?: Record<string, string>; body?: string }> {
  const request = Readable.from([Buffer.from('{}')]) as unknown as IncomingMessage
  Object.assign(request, {
    url: `/api/${method}`,
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
  })
  const chunks: Buffer[] = []
  const state: { status?: number; headers?: Record<string, string> } = {}
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

describe('/api gate enforcement', () => {
  it('refuses an unadmitted request with the gate status and a Bearer challenge', async () => {
    const { ctx, handle } = await mounted()
    ctx.connection.gates.register({
      order: 10,
      authorize: async () => ({ allow: false, status: 401, reason: 'missing bearer credential' }),
    })
    const response = await post(handle, 'session.list')
    expect(response.status).toBe(401)
    expect(response.headers?.['www-authenticate']).toBe('Bearer')
    expect(response.body).toBe('missing bearer credential')
  })

  it('refuses a privileged method for an admitted caller without privilege', async () => {
    const { ctx, handle } = await mounted()
    ctx.connection.gates.register({
      order: 10,
      authorize: async () => ({ allow: true, principal: 'laptop', privileged: false }),
    })
    const response = await post(handle, 'credentials.set')
    expect(response.status).toBe(403)
  })
})
