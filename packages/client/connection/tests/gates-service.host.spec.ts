/** The gate registry reached through the Connection service. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '../src/rpc-host.ts'
import { headersOf, type ApiRequestGate } from '../src/gates.ts'

const gate = (order: number): ApiRequestGate => ({
  order,
  authorize: async () => ({ allow: true, principal: 'p', privileged: false }),
})

describe('ctx.connection.gates', () => {
  it('registers a gate and returns a disposer that frees its order', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(HostConnectionService, [])
    await fiber.await()
    const dispose = ctx.connection.gates.register(gate(10))
    expect(() => ctx.connection.gates.register(gate(10))).toThrow('order 10')
    dispose()
    expect(() => ctx.connection.gates.register(gate(10))).not.toThrow()
  })

  it('runs registered gates through authorizeApiRequest', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(HostConnectionService, [])
    await fiber.await()
    ctx.connection.gates.register(gate(1))
    const verdict = await (ctx.connection as HostConnectionService).authorizeApiRequest({
      transport: 'http',
      method: 'session.list',
      headers: headersOf({}),
    })
    expect(verdict).toEqual({ admitted: true, principals: ['p'], privileged: false })
  })
})
