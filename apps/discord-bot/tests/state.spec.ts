import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryThreadStore, openThreadStore } from '../src/state.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-discord-state-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('openThreadStore', () => {
  it('starts empty without a file and persists bindings for a reopen', async () => {
    const path = join(dir, 'nested', 'threads.json')
    const store = await openThreadStore(path)
    expect(store.get('t1')).toBeUndefined()
    await store.set('t1', 'session-1')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, threads: { t1: 'session-1' } })
    const reopened = await openThreadStore(path)
    expect(reopened.get('t1')).toBe('session-1')
    expect([...reopened.entries()]).toEqual([['t1', 'session-1']])
  })

  it('refuses a file that is not a version 1 thread map', async () => {
    const path = join(dir, 'threads.json')
    await writeFile(path, '{"version":2,"threads":{}}')
    await expect(openThreadStore(path)).rejects.toThrow('not a version 1 thread map')
    await writeFile(path, '{"version":1,"threads":{"t":3}}')
    await expect(openThreadStore(path)).rejects.toThrow('non-string')
    await writeFile(path, '{"version":1}')
    await expect(openThreadStore(path)).rejects.toThrow('no threads object')
  })
})

describe('memoryThreadStore', () => {
  it('holds bindings without touching disk', async () => {
    const store = memoryThreadStore([['a', 's-a']])
    await store.set('b', 's-b')
    expect(store.get('b')).toBe('s-b')
    expect([...store.entries()]).toHaveLength(2)
  })
})
