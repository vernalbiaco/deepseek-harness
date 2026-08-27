import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_FAILOVER_CODES, resolveConfig } from '../src/config.ts'

describe('resolveConfig()', () => {
  it('resolves a route without swapping provider and model, and defaults the failover codes', () => {
    const resolved = resolveConfig({ backups: [{ provider: 'p', model: 'm' }] })
    expect(resolved.backups).toEqual([{ provider: 'p', model: 'm' }])
    expect([...resolved.failoverCodes].sort()).toEqual([...DEFAULT_FAILOVER_CODES].sort())
  })

  it('replaces the default codes with the configured list', () => {
    const resolved = resolveConfig({
      backups: [{ provider: 'p', model: 'm' }],
      failoverCodes: ['RATE_LIMIT'],
    })
    expect([...resolved.failoverCodes]).toEqual(['RATE_LIMIT'])
  })

  it('rejects an empty chain', () => {
    expect(() => resolveConfig({ backups: [] }))
      .toThrow('llm-fallback: backups must list at least one route')
  })

  it('rejects a duplicate route', () => {
    expect(() => resolveConfig({
      backups: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }],
    })).toThrow('llm-fallback: duplicate backup route "p/m"')
  })

  it('accepts two models behind one provider', () => {
    const resolved = resolveConfig({
      backups: [{ provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' }],
    })
    expect(resolved.backups).toEqual([
      { provider: 'p', model: 'm1' },
      { provider: 'p', model: 'm2' },
    ])
  })

  it('accepts one model behind two providers', () => {
    const resolved = resolveConfig({
      backups: [{ provider: 'p1', model: 'm' }, { provider: 'p2', model: 'm' }],
    })
    expect(resolved.backups).toEqual([
      { provider: 'p1', model: 'm' },
      { provider: 'p2', model: 'm' },
    ])
  })

  it('detaches the resolved chain from the caller\'s route objects', () => {
    const config: Config = { backups: [{ provider: 'p', model: 'm' }] }
    const resolved = resolveConfig(config)
    config.backups[0]!.model = 'mutated'
    expect(resolved.backups).toEqual([{ provider: 'p', model: 'm' }])
  })

  it('rejects an empty configured code list', () => {
    expect(() => resolveConfig({ backups: [{ provider: 'p', model: 'm' }], failoverCodes: [] }))
      .toThrow('llm-fallback: failoverCodes must list at least one code when present')
  })

  it('rejects an unknown key', () => {
    expect(() => resolveConfig({ backups: [{ provider: 'p', model: 'm' }], nope: 1 } as never))
      .toThrow('llm-fallback: unknown key "nope"')
  })
})

describe('Config schema', () => {
  it('rejects an entry with no backups list, naming the missing field', () => {
    expect(() => Config({} as never)).toThrow(/\$\.backups missing required value/)
  })
})
