import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TrustStore, TrustStoreError } from '../src/trust-store.ts'

const WORKSPACE = '/workspace/one'
const OTHER_WORKSPACE = '/workspace/two'
const NOW = new Date('2026-09-14T10:00:00.000Z')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function trustFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-trust-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return join(dir, 'mcp-trust.yaml')
}

describe('TrustStore', () => {
  it('lookup returns undefined when the file does not exist', async () => {
    const store = new TrustStore(await trustFile())
    await expect(store.lookup(WORKSPACE, 'brandguard', 'sha256:abc')).resolves.toBeUndefined()
  })

  it('record creates the file with mode 0o600', async () => {
    const filename = await trustFile()
    const store = new TrustStore(filename)
    await store.record(WORKSPACE, [{ serverName: 'brandguard', decision: 'allow', fingerprint: 'sha256:abc' }], NOW)
    const stats = await stat(filename)
    if (process.platform !== 'win32') expect(stats.mode & 0o777).toBe(0o600)
  })

  it('round-trips an allow decision', async () => {
    const store = new TrustStore(await trustFile())
    await store.record(WORKSPACE, [{ serverName: 'brandguard', decision: 'allow', fingerprint: 'sha256:abc' }], NOW)
    await expect(store.lookup(WORKSPACE, 'brandguard', 'sha256:abc')).resolves.toBe('allow')
  })

  it('round-trips a deny decision', async () => {
    const store = new TrustStore(await trustFile())
    await store.record(WORKSPACE, [{ serverName: 'brandguard', decision: 'deny', fingerprint: 'sha256:abc' }], NOW)
    await expect(store.lookup(WORKSPACE, 'brandguard', 'sha256:abc')).resolves.toBe('deny')
  })

  it('lookup returns undefined when the stored fingerprint differs', async () => {
    const store = new TrustStore(await trustFile())
    await store.record(WORKSPACE, [{ serverName: 'brandguard', decision: 'allow', fingerprint: 'sha256:abc' }], NOW)
    await expect(store.lookup(WORKSPACE, 'brandguard', 'sha256:different')).resolves.toBeUndefined()
  })

  it('record preserves other workspaces and other servers', async () => {
    const store = new TrustStore(await trustFile())
    await store.record(WORKSPACE, [{ serverName: 'brandguard', decision: 'allow', fingerprint: 'sha256:abc' }], NOW)
    await store.record(OTHER_WORKSPACE, [{ serverName: 'fixture', decision: 'deny', fingerprint: 'sha256:def' }], NOW)
    await store.record(WORKSPACE, [{ serverName: 'second', decision: 'allow', fingerprint: 'sha256:ghi' }], NOW)

    await expect(store.lookup(WORKSPACE, 'brandguard', 'sha256:abc')).resolves.toBe('allow')
    await expect(store.lookup(WORKSPACE, 'second', 'sha256:ghi')).resolves.toBe('allow')
    await expect(store.lookup(OTHER_WORKSPACE, 'fixture', 'sha256:def')).resolves.toBe('deny')
  })

  it('record overwrites the same server\'s decision', async () => {
    const store = new TrustStore(await trustFile())
    await store.record(WORKSPACE, [{ serverName: 'brandguard', decision: 'allow', fingerprint: 'sha256:abc' }], NOW)
    await store.record(WORKSPACE, [{ serverName: 'brandguard', decision: 'deny', fingerprint: 'sha256:def' }], NOW)

    await expect(store.lookup(WORKSPACE, 'brandguard', 'sha256:abc')).resolves.toBeUndefined()
    await expect(store.lookup(WORKSPACE, 'brandguard', 'sha256:def')).resolves.toBe('deny')
  })

  it('throws TrustStoreError on invalid YAML', async () => {
    const filename = await trustFile()
    await writeFile(filename, ': not valid yaml : [', 'utf8')
    const store = new TrustStore(filename)
    await expect(store.lookup(WORKSPACE, 'brandguard', 'sha256:abc')).rejects.toThrow(TrustStoreError)
  })

  it('throws TrustStoreError on an unsupported version', async () => {
    const filename = await trustFile()
    await writeFile(filename, 'version: 2\nworkspaces: {}\n', 'utf8')
    const store = new TrustStore(filename)
    await expect(store.lookup(WORKSPACE, 'brandguard', 'sha256:abc')).rejects.toThrow(TrustStoreError)
  })

  it('throws TrustStoreError when the document root is not a mapping', async () => {
    const filename = await trustFile()
    await writeFile(filename, '- just a list\n', 'utf8')
    const store = new TrustStore(filename)
    await expect(store.lookup(WORKSPACE, 'brandguard', 'sha256:abc')).rejects.toThrow(TrustStoreError)
  })

  it('throws TrustStoreError when the file cannot be read for a reason other than absence', async () => {
    // A directory at the trust-file path fails `readFile` with EISDIR, not ENOENT.
    const filename = await trustFile()
    await mkdir(filename)
    const store = new TrustStore(filename)
    await expect(store.lookup(WORKSPACE, 'brandguard', 'sha256:abc')).rejects.toThrow(TrustStoreError)
  })

  it('keeps the underlying read or parse failure as the TrustStoreError cause', async () => {
    const invalidYaml = await trustFile()
    await writeFile(invalidYaml, ': not valid yaml : [', 'utf8')
    const parseFailure: unknown = await new TrustStore(invalidYaml).lookup(WORKSPACE, 'brandguard', 'sha256:abc').catch((error: unknown) => error)
    expect(parseFailure).toBeInstanceOf(TrustStoreError)
    expect((parseFailure as Error).cause).toBeInstanceOf(Error)

    // A directory at the trust-file path fails the read with EISDIR, not ENOENT.
    const directory = await trustFile()
    await mkdir(directory)
    const readFailure: unknown = await new TrustStore(directory).lookup(WORKSPACE, 'brandguard', 'sha256:abc').catch((error: unknown) => error)
    expect(readFailure).toBeInstanceOf(TrustStoreError)
    expect((readFailure as Error).cause).toMatchObject({ code: 'EISDIR' })
  })

  it('two concurrent record calls on different servers both persist', async () => {
    const store = new TrustStore(await trustFile())
    await Promise.all([
      store.record(WORKSPACE, [{ serverName: 'first', decision: 'allow', fingerprint: 'sha256:one' }], NOW),
      store.record(WORKSPACE, [{ serverName: 'second', decision: 'allow', fingerprint: 'sha256:two' }], NOW),
    ])

    await expect(store.lookup(WORKSPACE, 'first', 'sha256:one')).resolves.toBe('allow')
    await expect(store.lookup(WORKSPACE, 'second', 'sha256:two')).resolves.toBe('allow')
  })

  it('lookupAllSync reads the same decisions as lookup, in server order', async () => {
    const store = new TrustStore(await trustFile())
    const servers = [
      { name: 'brandguard', fingerprint: 'sha256:abc' },
      { name: 'brandguard', fingerprint: 'sha256:different' },
      { name: 'second', fingerprint: 'sha256:def' },
    ]
    expect(store.lookupAllSync(WORKSPACE, servers)).toEqual([undefined, undefined, undefined])
    await store.record(WORKSPACE, [
      { serverName: 'brandguard', decision: 'allow', fingerprint: 'sha256:abc' },
      { serverName: 'second', decision: 'deny', fingerprint: 'sha256:def' },
    ], NOW)
    expect(store.lookupAllSync(WORKSPACE, servers)).toEqual(['allow', undefined, 'deny'])
  })

  it('lookupAllSync throws TrustStoreError for an invalid document or an unreadable file', async () => {
    const servers = [{ name: 'brandguard', fingerprint: 'sha256:abc' }]
    const invalid = await trustFile()
    await writeFile(invalid, 'version: 2\nworkspaces: {}\n', 'utf8')
    expect(() => new TrustStore(invalid).lookupAllSync(WORKSPACE, servers)).toThrow(TrustStoreError)
    // A directory at the trust-file path fails the read with EISDIR, not ENOENT.
    const directory = await trustFile()
    await mkdir(directory)
    expect(() => new TrustStore(directory).lookupAllSync(WORKSPACE, servers)).toThrow(TrustStoreError)
  })

  it('stamps decidedAt as now.toISOString()', async () => {
    const filename = await trustFile()
    const store = new TrustStore(filename)
    await store.record(WORKSPACE, [{ serverName: 'brandguard', decision: 'allow', fingerprint: 'sha256:abc' }], NOW)
    const text = await readFile(filename, 'utf8')
    expect(text).toContain(NOW.toISOString())
  })
})
