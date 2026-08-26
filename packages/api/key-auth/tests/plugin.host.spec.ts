/** Config validation and gate behavior. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import type { ApiRequestGate } from '@deepseek-ai/dsh-client-connection'

/** Context with a gate registry double (real disposal) and a scripted credential store. */
function harness(secrets: Record<string, string>): { ctx: Context; gates: ApiRequestGate[]; gate: () => ApiRequestGate } {
  const gates: ApiRequestGate[] = []
  const ctx = new Context()
  ctx.provide('connection', {
    gates: {
      register: (gate: ApiRequestGate) => {
        gates.push(gate)
        return () => {
          const index = gates.indexOf(gate)
          if (index !== -1) gates.splice(index, 1)
        }
      },
    },
  })
  ctx.provide('credentials', {
    resolve: async (ref: string) => (ref in secrets ? { value: secrets[ref], source: 'test' } : undefined),
  })
  const gate = (): ApiRequestGate => {
    const [registered] = gates
    if (registered === undefined) throw new Error('api-key-auth: no gate was registered')
    return registered
  }
  return { ctx, gates, gate }
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

  it('refuses a malformed credential reference at load without echoing it', async () => {
    const { ctx } = harness({})
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'not a valid ref!' }] })
    const error: unknown = await fiber.await().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('api-key-auth: key "laptop" has an invalid credential reference')
    expect((error as Error).message).not.toContain('not a valid ref!')
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // A default export would make the Loader unwrap only `apply` and drop `inject` (postmortem 0001).
    expect('default' in plugin).toBe(false)
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

  it('revokes exactly the key whose row was removed, leaving its sibling admitting', async () => {
    // The removed row's secret stays resolvable throughout: dropping the row is
    // what revokes the key, independently of the credential it referenced.
    const { ctx, gates, gate } = harness({ A: 'secret-a', B: 'secret-b' })
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }, { name: 'ci', secret: 'B' }] })
    await fiber.await()
    await expect(gate().authorize(withKey('secret-a')))
      .resolves.toEqual({ allow: true, principal: 'laptop', privileged: false })

    await fiber.update({ keys: [{ name: 'ci', secret: 'B' }] })
    await fiber.await()
    expect(gates.length).toBe(1)
    await expect(gate().authorize(withKey('secret-a')))
      .resolves.toEqual({ allow: false, status: 401, reason: 'unrecognized credential' })
    await expect(gate().authorize(withKey('secret-b')))
      .resolves.toEqual({ allow: true, principal: 'ci', privileged: false })
  })

  it('registers at the configured order', async () => {
    const { ctx, gate } = harness({ A: 'a' })
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }], order: 42 })
    await fiber.await()
    expect(gate().order).toBe(42)
  })

  it('registers at the schema-default order when none is configured', async () => {
    const { ctx, gate } = harness({ A: 'a' })
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }] })
    await fiber.await()
    expect(gate().order).toBe(100)
  })

  it('unregisters the gate when its contributing fiber is disposed (HMR-safety)', async () => {
    const { ctx, gates } = harness({ A: 'a' })
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }] })
    await fiber.await()
    expect(gates.length).toBe(1)
    await fiber.dispose()
    expect(gates.length).toBe(0)
  })

  it('logs the principal (or "none"), transport, method, and outcome on every path', async () => {
    const { ctx, gate } = harness({ A: 'secret-a' })
    const fiber = ctx.plugin(plugin, { keys: [{ name: 'laptop', secret: 'A' }] })
    await fiber.await()
    const info = vi.spyOn(ctx.logger, 'info')

    // A WebSocket upgrade carries no `method`; every site must fall back to "upgrade".
    const upgrade = { transport: 'websocket' as const, headers: new Headers() }

    await gate().authorize(upgrade)
    expect(info).toHaveBeenLastCalledWith('api-key-auth: denied none websocket upgrade (no credential)')

    await gate().authorize({ ...upgrade, headers: new Headers({ authorization: 'Bearer wrong' }) })
    expect(info).toHaveBeenLastCalledWith('api-key-auth: denied none websocket upgrade (unrecognized)')

    await gate().authorize({ ...upgrade, headers: new Headers({ authorization: 'Bearer secret-a' }) })
    expect(info).toHaveBeenLastCalledWith('api-key-auth: admitted laptop websocket upgrade')
  })
})
