/**
 * Durable thread-to-session map. The file lives on the `dsh-home` volume so a
 * restarted bot keeps answering in threads it opened before.
 * @module @deepseek-ai/dsh-discord-bot/state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Persistent map from Discord thread id to harness session id. */
export interface ThreadStore {
  /** Session bound to `threadId`, or undefined when the bot never opened one there. */
  get(threadId: string): string | undefined
  /** Bind `threadId` to `sessionId` and persist the map before resolving. */
  set(threadId: string, sessionId: string): Promise<void>
  /** Every known binding. */
  entries(): Iterable<[threadId: string, sessionId: string]>
}

interface StateFile {
  version: 1
  threads: Record<string, string>
}

function parseState(text: string, path: string): Map<string, string> {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`discord-bot: ${path} is not a version 1 thread map`)
  const { version, threads } = parsed as Record<string, unknown>
  if (version !== 1) throw new Error(`discord-bot: ${path} is not a version 1 thread map`)
  if (typeof threads !== 'object' || threads === null) throw new Error(`discord-bot: ${path} has no threads object`)
  const map = new Map<string, string>()
  for (const [threadId, sessionId] of Object.entries(threads)) {
    if (typeof sessionId !== 'string') throw new Error(`discord-bot: ${path} maps thread ${threadId} to a non-string`)
    map.set(threadId, sessionId)
  }
  return map
}

/**
 * Open the thread map at `path`, creating an empty one when the file is absent.
 * Writes go to a sibling temporary file and rename over the target, so a
 * crash mid-write leaves the previous map intact.
 * @param path - JSON file path.
 * @returns the store.
 * @throws when an existing file is not a valid thread map.
 */
export async function openThreadStore(path: string): Promise<ThreadStore> {
  let map: Map<string, string>
  try {
    map = parseState(await readFile(path, 'utf8'), path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    map = new Map()
  }
  const persist = async (): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    const body: StateFile = { version: 1, threads: Object.fromEntries(map) }
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    await rename(temp, path)
  }
  return {
    get: threadId => map.get(threadId),
    async set(threadId, sessionId) {
      map.set(threadId, sessionId)
      await persist()
    },
    entries: () => map.entries(),
  }
}

/**
 * In-memory store for tests and dry runs; nothing is written.
 * @param initial - bindings to start with.
 * @returns the store.
 */
export function memoryThreadStore(initial: Iterable<[string, string]> = []): ThreadStore {
  const map = new Map(initial)
  return {
    get: threadId => map.get(threadId),
    set(threadId, sessionId) {
      map.set(threadId, sessionId)
      return Promise.resolve()
    },
    entries: () => map.entries(),
  }
}
