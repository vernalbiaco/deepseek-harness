import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { adoptIfChanged, advance, createState, resetForTurn, targetFor } from '../src/state.ts'

const chain = resolveConfig({
  backups: [{ provider: 'b1', model: 'm1' }, { provider: 'b2', model: 'm2' }],
})
const primary = { provider: 'p', model: 'm' }

describe('targetFor()', () => {
  it('names no target before any failover', () => {
    expect(targetFor(createState(), chain)).toBeUndefined()
  })

  it('names the backup the cursor selects', () => {
    const state = createState()
    advance(state, chain, primary)
    expect(targetFor(state, chain)).toEqual({ provider: 'b1', model: 'm1' })
  })

  it('names the captured primary at cursor zero after a failover', () => {
    const state = createState()
    advance(state, chain, { ...primary, reasoningEffort: 'high' })
    resetForTurn(state, 2)
    expect(targetFor(state, chain)).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })
})

describe('adoptIfChanged()', () => {
  it('ignores a delegated route before this plugin has written one', () => {
    const state = createState()
    expect(adoptIfChanged(state, { provider: 'x', model: 'y' })).toBe(false)
  })

  it('ignores the log echoing this plugin\'s own write', () => {
    const state = createState()
    state.lastWritten = { provider: 'b1', model: 'm1' }
    expect(adoptIfChanged(state, { provider: 'b1', model: 'm1' })).toBe(false)
  })

  it('adopts an external route as the new primary and clears the cursor', () => {
    const state = createState()
    advance(state, chain, primary)
    state.lastWritten = { provider: 'b1', model: 'm1' }
    expect(adoptIfChanged(state, { provider: 'picked', model: 'x' })).toBe(true)
    expect(state.cursor).toBe(0)
    expect(state.primary).toEqual({ provider: 'picked', model: 'x' })
    expect(state.lastWritten).toBeUndefined()
    expect(state.assembled).toBeUndefined()
  })
})

describe('advance()', () => {
  it('captures the failing route as the primary on the first move', () => {
    const state = createState()
    expect(advance(state, chain, primary)).toEqual({ provider: 'b1', model: 'm1' })
    expect(state.primary).toEqual(primary)
    expect(state.cursor).toBe(1)
  })

  it('walks the chain in order', () => {
    const state = createState()
    advance(state, chain, primary)
    expect(advance(state, chain, { provider: 'b1', model: 'm1' }))
      .toEqual({ provider: 'b2', model: 'm2' })
    expect(state.cursor).toBe(2)
  })

  it('returns undefined once the chain is exhausted and leaves the cursor put', () => {
    const state = createState()
    advance(state, chain, primary)
    advance(state, chain, { provider: 'b1', model: 'm1' })
    expect(advance(state, chain, { provider: 'b2', model: 'm2' })).toBeUndefined()
    expect(state.cursor).toBe(2)
  })

  it('keeps the originally captured primary across later moves', () => {
    const state = createState()
    advance(state, chain, { ...primary, reasoningEffort: 'high' })
    advance(state, chain, { provider: 'b1', model: 'm1' })
    expect(state.primary).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })
})

describe('resetForTurn()', () => {
  it('resets the cursor on a new turn', () => {
    const state = createState()
    advance(state, chain, primary)
    resetForTurn(state, 2)
    expect(state.cursor).toBe(0)
  })

  it('ignores a repeated turn so mid-turn steering does not re-probe', () => {
    const state = createState()
    resetForTurn(state, 2)
    advance(state, chain, primary)
    resetForTurn(state, 2)
    expect(state.cursor).toBe(1)
  })
})
