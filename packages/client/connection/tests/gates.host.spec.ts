/** Ordered admission gates for the `/api` transport. */

import { describe, expect, it } from 'vitest'
import { ApiGateRegistry, headersOf, type ApiRequestGate } from '../src/gates.ts'

const allow = (order: number, principal: string, privileged = false): ApiRequestGate => ({
  order,
  authorize: async () => ({ allow: true, principal, privileged }),
})

const httpRequest = { transport: 'http' as const, method: 'session.list', headers: new Headers() }

describe('ApiGateRegistry', () => {
  it('admits with full privilege when no gate is registered', async () => {
    await expect(new ApiGateRegistry().authorize(httpRequest))
      .resolves.toEqual({ admitted: true, principals: [], privileged: true })
  })

  it('collects principals in ascending order and folds privilege with AND', async () => {
    const registry = new ApiGateRegistry()
    registry.register(allow(20, 'second', true))
    registry.register(allow(10, 'first', true))
    await expect(registry.authorize(httpRequest))
      .resolves.toEqual({ admitted: true, principals: ['first', 'second'], privileged: true })
  })

  it('withholds privilege when any allowing gate withholds it', async () => {
    const registry = new ApiGateRegistry()
    registry.register(allow(10, 'first', true))
    registry.register(allow(20, 'second', false))
    await expect(registry.authorize(httpRequest))
      .resolves.toMatchObject({ admitted: true, privileged: false })
  })

  it('stops at the first denial and reports its status', async () => {
    const registry = new ApiGateRegistry()
    let reached = false
    registry.register({ order: 10, authorize: async () => ({ allow: false, status: 401, reason: 'no credential' }) })
    registry.register({ order: 20, authorize: async () => { reached = true; return { allow: true, principal: 'x', privileged: true } } })
    await expect(registry.authorize(httpRequest))
      .resolves.toEqual({ admitted: false, status: 401, reason: 'no credential' })
    expect(reached).toBe(false)
  })

  it('denies with 403 when a gate throws, and does not leak the cause', async () => {
    const registry = new ApiGateRegistry()
    registry.register({ order: 10, authorize: async () => { throw new Error('secret-bearing detail') } })
    const verdict = await registry.authorize(httpRequest)
    expect(verdict).toEqual({ admitted: false, status: 403, reason: 'gate failed' })
  })

  it('rejects a duplicate order at registration', () => {
    const registry = new ApiGateRegistry()
    registry.register(allow(10, 'first'))
    expect(() => registry.register(allow(10, 'second')))
      .toThrow('connection: an API gate is already registered at order 10')
  })

  it('frees the order when a registration is disposed', () => {
    const registry = new ApiGateRegistry()
    const dispose = registry.register(allow(10, 'first'))
    dispose()
    expect(() => registry.register(allow(10, 'second'))).not.toThrow()
  })

  it('ignores a stale disposer, keeping the gate that now holds the order', async () => {
    const registry = new ApiGateRegistry()
    const stale = registry.register(allow(10, 'first'))
    stale()
    registry.register(allow(10, 'second'))
    stale()
    await expect(registry.authorize(httpRequest))
      .resolves.toMatchObject({ admitted: true, principals: ['second'] })
  })

  it('is idempotent when a live disposer is called twice', async () => {
    const registry = new ApiGateRegistry()
    const dispose = registry.register(allow(10, 'first'))
    registry.register(allow(20, 'second'))
    dispose()
    dispose()
    await expect(registry.authorize(httpRequest))
      .resolves.toMatchObject({ admitted: true, principals: ['second'] })
  })

  it('folds Node header maps, joining repeated values', () => {
    const headers = headersOf({ authorization: 'Bearer k', 'x-multi': ['a', 'b'], absent: undefined })
    expect(headers.get('authorization')).toBe('Bearer k')
    expect(headers.get('x-multi')).toBe('a, b')
    expect(headers.get('absent')).toBeNull()
  })
})
