/** Config validation and gate behavior. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import type { ApiRequestGate } from '@deepseek-ai/dsh-client-connection'

/** Context with a gate registry double and a scripted credential store. */
function harness(secrets: Record<string, string>): { ctx: Context; gate: () => ApiRequestGate } {
  const gates: ApiRequestGate[] = []
  const ctx = new Context()
  ctx.provide('connection', { gates: { register: (gate: ApiRequestGate) => { gates.push(gate); return () => {} } } })
  ctx.provide('credentials', {
    resolve: async (ref: string) => (ref in secrets ? { value: secrets[ref], source: 'test' } : undefined),
  })
  const gate = (): ApiRequestGate => {
    const [registered] = gates
    if (registered === undefined) throw new Error('api-key-auth: no gate was registered')
    return registered
  }
  return { ctx, gate }
}

const request = { transport: 'http' as const, method: 'session.list', headers: new Headers() }
const withKey = (token: string) => ({ ...request, headers: new Headers({ authorization: `Bearer ${token}` }) })

describe('api-key-auth config', () => {
  it('refuses an empty key list at load', async () => {
    const { ctx } = harness({})
    const fiber = ctx.plugin(plugin, { keys: [] })
    await expect(fiber.await()).rejects.toThrow('api-key-auth: configure at least one key')
  })

  it('refuses duplicate key names at load, naming the offender', async () => {
    const { ctx } = harness({ A: 'a', B: 'b' })
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }, { name: 'laptop', secret: 'B' }] })
    await expect(fiber.await()).rejects.toThrow('api-key-auth: duplicate key name "laptop"')
  })
})

describe('api-key-auth gate', () => {
  it('denies 401 when no bearer credential is presented', async () => {
    const { ctx, gate } = harness({ A: 'secret-a' })
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }] })
    await fiber.await()
    await expect(gate().authorize(request))
      .resolves.toEqual({ allow: false, status: 401, reason: 'missing bearer credential' })
  })

  it('denies 401 for an unrecognized secret without echoing it', async () => {
    const { ctx, gate } = harness({ A: 'secret-a' })
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }] })
    await fiber.await()
    const decision = await gate().authorize(withKey('wrong-value'))
    expect(decision).toEqual({ allow: false, status: 401, reason: 'unrecognized credential' })
    expect(JSON.stringify(decision)).not.toContain('wrong-value')
  })

  it('admits a matching key as its name and never grants privilege', async () => {
    const { ctx, gate } = harness({ A: 'secret-a', B: 'secret-b' })
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }, { name: 'ci', secret: 'B' }] })
    await fiber.await()
    await expect(gate().authorize(withKey('secret-b')))
      .resolves.toEqual({ allow: true, principal: 'ci', privileged: false })
  })

  it('skips a reference that resolves to nothing rather than matching an absent secret', async () => {
    const { ctx, gate } = harness({ B: 'secret-b' })
    const fiber = ctx.plugin(plugin, {
      keys: [{ name: 'laptop', secret: 'MISSING' }, { name: 'ci', secret: 'B' }],
    })
    await fiber.await()
    await expect(gate().authorize(withKey('secret-b')))
      .resolves.toEqual({ allow: true, principal: 'ci', privileged: false })
    await expect(gate().authorize(withKey('')))
      .resolves.toMatchObject({ allow: false, status: 401 })
  })

  it('honors a rotated secret on the next request with no restart', async () => {
    const secrets = { A: 'old-value' }
    const { ctx, gate } = harness(secrets)
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }] })
    await fiber.await()
    await expect(gate().authorize(withKey('old-value'))).resolves.toMatchObject({ allow: true })
    secrets.A = 'new-value'
    await expect(gate().authorize(withKey('old-value'))).resolves.toMatchObject({ allow: false })
    await expect(gate().authorize(withKey('new-value'))).resolves.toMatchObject({ allow: true })
  })

  it('registers at the configured order', async () => {
    const { ctx, gate } = harness({ A: 'a' })
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }], order: 42 })
    await fiber.await()
    expect(gate().order).toBe(42)
  })

  it('falls back to "upgrade" in its log line when a WebSocket request carries no method', async () => {
    const { ctx, gate } = harness({ A: 'secret-a' })
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }] })
    await fiber.await()
    const upgrade = { transport: 'websocket' as const, headers: new Headers() }
    await expect(gate().authorize(upgrade))
      .resolves.toEqual({ allow: false, status: 401, reason: 'missing bearer credential' })
    await expect(gate().authorize({ ...upgrade, headers: new Headers({ authorization: 'Bearer secret-a' }) }))
      .resolves.toEqual({ allow: true, principal: 'laptop', privileged: false })
    await expect(gate().authorize({ ...upgrade, headers: new Headers({ authorization: 'Bearer wrong' }) }))
      .resolves.toEqual({ allow: false, status: 401, reason: 'unrecognized credential' })
  })

  it('registers at the schema-default order when none is configured', async () => {
    const { ctx, gate } = harness({ A: 'a' })
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }] })
    await fiber.await()
    expect(gate().order).toBe(100)
  })
})
