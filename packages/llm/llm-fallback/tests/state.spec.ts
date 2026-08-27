import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { adoptIfChanged, advance, createState, promotePending, refreshPrimaryEffort, resetForTurn, targetFor } from '../src/state.ts'

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

  it('detaches the primary it returns from the stored state', () => {
    const state = createState()
    advance(state, chain, primary)
    resetForTurn(state, 2)
    const asserted = targetFor(state, chain)!
    asserted.provider = 'mutated'
    expect(state.primary).toEqual(primary)
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

  it('stages a model switch within the provider it last wrote', () => {
    const state = createState()
    state.lastWritten = { provider: 'b1', model: 'm1' }
    expect(adoptIfChanged(state, { provider: 'b1', model: 'm2' })).toBe(true)
    expect(state.pending).toEqual({ provider: 'b1', model: 'm2' })
  })

  it('stages a provider switch keeping the model it last wrote', () => {
    const state = createState()
    state.lastWritten = { provider: 'b1', model: 'm1' }
    expect(adoptIfChanged(state, { provider: 'b2', model: 'm1' })).toBe(true)
    expect(state.pending).toEqual({ provider: 'b2', model: 'm1' })
  })

  it('ignores a standing selection re-asserted while the cursor sits on a backup', () => {
    const state = createState()
    advance(state, chain, primary)
    // The route owner asserted the same selection on the previous step, so this
    // delegation differs from the plugin's write without anything having changed.
    adoptIfChanged(state, primary)
    state.lastWritten = { provider: 'b1', model: 'm1' }
    expect(adoptIfChanged(state, primary)).toBe(false)
    expect(state.pending).toBeUndefined()
    expect(state.lastWritten).toEqual({ provider: 'b1', model: 'm1' })
    expect(state.cursor).toBe(1)
  })

  it('stages a route differing from both the last write and the last delegation', () => {
    const state = createState()
    advance(state, chain, primary)
    adoptIfChanged(state, primary)
    state.lastWritten = { provider: 'b1', model: 'm1' }
    expect(adoptIfChanged(state, { provider: 'picked', model: 'x' })).toBe(true)
    expect(state.pending).toEqual({ provider: 'picked', model: 'x' })
  })

  it('stages an external route instead of applying it immediately', () => {
    const state = createState()
    advance(state, chain, primary)
    state.lastWritten = { provider: 'b1', model: 'm1' }
    expect(adoptIfChanged(state, { provider: 'picked', model: 'x' })).toBe(true)
    expect(state.pending).toEqual({ provider: 'picked', model: 'x' })
    expect(state.primary).toEqual(primary)
    expect(state.cursor).toBe(1)
    expect(state.lastWritten).toBeUndefined()
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

  it('detaches the primary it captures from the caller\'s route', () => {
    const state = createState()
    const failed = { ...primary }
    advance(state, chain, failed)
    failed.model = 'mutated'
    expect(state.primary).toEqual(primary)
  })

  it('detaches the route it returns from the configured chain', () => {
    const state = createState()
    const moved = advance(state, chain, primary)!
    moved.provider = 'mutated'
    expect(chain.backups[0]).toEqual({ provider: 'b1', model: 'm1' })
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

describe('reset then adopt', () => {
  it('re-asserts the primary when the host echoes the logged backup', () => {
    const state = createState()
    advance(state, chain, primary)
    state.lastWritten = { provider: 'b1', model: 'm1' }
    resetForTurn(state, 2)
    expect(adoptIfChanged(state, { provider: 'b1', model: 'm1' })).toBe(false)
    expect(targetFor(state, chain)).toEqual(primary)
  })

  it('stages a pick made between turns and applies it after promotion', () => {
    const state = createState()
    advance(state, chain, primary)
    state.lastWritten = { provider: 'b1', model: 'm1' }
    resetForTurn(state, 2)
    expect(adoptIfChanged(state, { provider: 'picked', model: 'x' })).toBe(true)
    expect(targetFor(state, chain)).toEqual(primary)
    promotePending(state)
    expect(targetFor(state, chain)).toEqual({ provider: 'picked', model: 'x' })
  })
})

describe('promotePending()', () => {
  it('leaves the cursor alone when nothing is staged', () => {
    const state = createState()
    advance(state, chain, primary)
    promotePending(state)
    expect(state.cursor).toBe(1)
    expect(state.primary).toEqual(primary)
  })

  it('promotes a staged route and restarts the chain from it', () => {
    const state = createState()
    advance(state, chain, primary)
    state.lastWritten = { provider: 'b1', model: 'm1' }
    adoptIfChanged(state, { provider: 'picked', model: 'x' })
    promotePending(state)
    expect(state.primary).toEqual({ provider: 'picked', model: 'x' })
    expect(state.cursor).toBe(0)
    expect(state.pending).toBeUndefined()
  })
})

describe('refreshPrimaryEffort()', () => {
  it('leaves the state alone before a failover captured a primary', () => {
    const state = createState()
    refreshPrimaryEffort(state, { ...primary, reasoningEffort: 'high' })
    expect(state.primary).toBeUndefined()
  })

  it('ignores a delegation differing in provider alone', () => {
    const state = createState()
    advance(state, chain, { ...primary, reasoningEffort: 'low' })
    refreshPrimaryEffort(state, { provider: 'other', model: primary.model, reasoningEffort: 'high' })
    expect(state.primary).toEqual({ ...primary, reasoningEffort: 'low' })
  })

  it('ignores a delegation differing in model alone', () => {
    const state = createState()
    advance(state, chain, { ...primary, reasoningEffort: 'low' })
    refreshPrimaryEffort(state, { provider: primary.provider, model: 'other', reasoningEffort: 'high' })
    expect(state.primary).toEqual({ ...primary, reasoningEffort: 'low' })
  })

  it('takes an effort changed on the primary route without moving the cursor', () => {
    const state = createState()
    advance(state, chain, { ...primary, reasoningEffort: 'low' })
    refreshPrimaryEffort(state, { ...primary, reasoningEffort: 'high' })
    expect(state.primary).toEqual({ ...primary, reasoningEffort: 'high' })
    expect(state.cursor).toBe(1)
  })

  it('clears the captured effort when the delegation carries none', () => {
    const state = createState()
    advance(state, chain, { ...primary, reasoningEffort: 'low' })
    refreshPrimaryEffort(state, primary)
    expect(state.primary).toEqual(primary)
  })
})
