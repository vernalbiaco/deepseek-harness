import { describe, expect, it } from 'vitest'
import { DEFAULT_FAILOVER_CODES, resolveConfig } from '../src/config.ts'

describe('resolveConfig()', () => {
  it('defaults the failover codes when none are configured', () => {
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

  it('rejects an empty configured code list', () => {
    expect(() => resolveConfig({ backups: [{ provider: 'p', model: 'm' }], failoverCodes: [] }))
      .toThrow('llm-fallback: failoverCodes must list at least one code when present')
  })

  it('rejects an unknown key', () => {
    expect(() => resolveConfig({ backups: [{ provider: 'p', model: 'm' }], nope: 1 } as never))
      .toThrow('llm-fallback: unknown key "nope"')
  })
})
