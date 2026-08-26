/** Gate enforcement on the event WebSocket upgrades. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as connectionPlugin from '../src/index.ts'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../src/api-path.ts'

type UpgradeHandler = (req: unknown, socket: unknown, head: unknown) => unknown

/** Structural webServer/apiProxy fake capturing the registered upgrade handlers. */
function harness(): { ctx: Context; upgrades: Map<string, UpgradeHandler> } {
  const upgrades = new Map<string, UpgradeHandler>()
  const ctx = new Context()
  ctx.provide('webServer', {
    register: () => () => {},
    registerUpgrade: (route: { path: string; handler: UpgradeHandler }) => {
      upgrades.set(route.path, route.handler)
      return () => upgrades.delete(route.path)
    },
  })
  ctx.provide('apiProxy', { subscribe: () => ({ close: () => {} }) })
  return { ctx, upgrades }
}

describe.each([MUX_EVENTS_PATH, HOST_EVENTS_PATH])('%s upgrade', (path) => {
  it('rejects the upgrade with a 403 when no gate admits it', async () => {
    const { ctx, upgrades } = harness()
    const fiber = ctx.plugin({ inject: [...connectionPlugin.inject], apply: connectionPlugin.apply }, { trustedHosts: [] })
    await fiber.await()
    ctx.connection.gates.register({
      order: 10,
      authorize: async () => ({ allow: false, status: 401, reason: 'missing bearer credential' }),
    })
    const chunks: Buffer[] = []
    const socket = {
      end: (value: string) => { chunks.push(Buffer.from(value)) },
      writable: true,
    }
    // Loopback Host passes the trust fence; the registered gate above is the
    // sole reason this upgrade is refused.
    await upgrades.get(path)!(
      { headers: { host: '127.0.0.1:3080' }, url: path },
      socket,
      Buffer.alloc(0),
    )
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    await fiber.dispose()
  })
})
