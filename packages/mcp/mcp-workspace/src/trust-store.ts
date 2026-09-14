/**
 * Persists per-workspace MCP server trust decisions to a YAML document under
 * `$DSH_HOME`, keyed by canonical workspace path and server name. A decision
 * only ever applies to the exact fingerprint it was recorded against, so a
 * changed `.mcp.json` entry needs a fresh decision rather than inheriting a
 * stale one. The document is never written inside a workspace: a project must
 * never be able to approve its own servers.
 * @module @deepseek-ai/dsh-mcp-workspace/trust-store
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** A stored user decision for one workspace server. */
export type TrustDecision = 'allow' | 'deny'

/** One decision to persist through {@link TrustStore.record}. */
export interface TrustDecisionInput {
  readonly serverName: string
  readonly decision: TrustDecision
  readonly fingerprint: string
}

/**
 * Raised when the trust document cannot be read or does not match the
 * expected format. The caller must treat this as "no decision admits
 * anything" rather than fall back to a default.
 */
export class TrustStoreError extends Error {}

const trustEntrySchema = z.object({
  decision: z.enum(['allow', 'deny']),
  fingerprint: z.string(),
  decidedAt: z.string(),
})

const trustDocumentSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(z.string(), z.record(z.string(), trustEntrySchema)),
})

type TrustDocument = z.infer<typeof trustDocumentSchema>

/** Document written when the trust file does not exist yet. */
function emptyDocument(): TrustDocument {
  return { version: 1, workspaces: {} }
}

/**
 * Resolves a failed read of the trust document. A missing file is a valid
 * empty document, matching "no decision recorded yet" rather than an error.
 * @param error - the read failure.
 * @param filename - absolute path of the trust document.
 * @returns the empty document when the file does not exist.
 * @throws {TrustStoreError} for any other read failure.
 */
function missingDocument(error: unknown, filename: string): TrustDocument {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyDocument()
  throw new TrustStoreError(`mcp-workspace: cannot read trust file ${filename}`)
}

/**
 * Parses and validates the trust document text.
 * @param text - the file's contents.
 * @param filename - absolute path of the trust document, used in error messages.
 * @returns the validated document.
 * @throws {TrustStoreError} when the text is not valid YAML or does not match the document schema.
 */
function parseDocument(text: string, filename: string): TrustDocument {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch {
    throw new TrustStoreError(`mcp-workspace: invalid YAML in trust file ${filename}`)
  }

  const result = trustDocumentSchema.safeParse(parsed)
  if (!result.success) {
    const paths = result.error.issues.map(issue => issue.path.join('.') || '<root>').join(', ')
    throw new TrustStoreError(`mcp-workspace: trust file ${filename} does not match the expected format at ${paths}`)
  }
  return result.data
}

/**
 * Reads and validates the trust document at `filename`.
 * @param filename - absolute path of the trust document.
 * @returns the validated document; empty when the file does not exist.
 * @throws {TrustStoreError} per {@link missingDocument} and {@link parseDocument}.
 */
async function readDocument(filename: string): Promise<TrustDocument> {
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    return missingDocument(error, filename)
  }
  return parseDocument(text, filename)
}

/**
 * Synchronous {@link readDocument}.
 * @param filename - absolute path of the trust document.
 * @returns the validated document; empty when the file does not exist.
 * @throws {TrustStoreError} per {@link missingDocument} and {@link parseDocument}.
 */
function readDocumentSync(filename: string): TrustDocument {
  let text: string
  try {
    text = readFileSync(filename, 'utf8')
  } catch (error) {
    return missingDocument(error, filename)
  }
  return parseDocument(text, filename)
}

/**
 * The stored decision for one workspace server at one fingerprint.
 * @param document - the validated trust document.
 * @param workspacePath - canonical workspace path.
 * @param serverName - the server's name within the workspace.
 * @param fingerprint - the server entry's current fingerprint.
 * @returns the decision, or `undefined` when no record exists or the stored fingerprint differs.
 */
function decisionIn(document: TrustDocument, workspacePath: string, serverName: string, fingerprint: string): TrustDecision | undefined {
  const entry = document.workspaces[workspacePath]?.[serverName]
  if (entry === undefined || entry.fingerprint !== fingerprint) return undefined
  return entry.decision
}

/**
 * Reads and writes `mcp-trust.yaml`: canonical workspace path to server name
 * to `{ decision, fingerprint, decidedAt }`. Writes go through the shared
 * cross-process writer lock in `@deepseek-ai/dsh-atomic-write`, mirroring
 * `@deepseek-ai/dsh-credentials-local`'s read-modify-write cycle.
 */
export class TrustStore {
  private readonly filename: string

  /**
   * @param filename - absolute path of the trust document.
   */
  constructor(filename: string) {
    this.filename = filename
  }

  /**
   * Looks up the stored decision for one workspace server at one fingerprint.
   * @param workspacePath - canonical workspace path used as the top-level document key.
   * @param serverName - the server's name within the workspace.
   * @param fingerprint - the server entry's current fingerprint; a stored decision for a different fingerprint does not match.
   * @returns the stored decision, or `undefined` when no record exists or the stored fingerprint differs.
   * @throws {TrustStoreError} per {@link readDocument}.
   */
  async lookup(workspacePath: string, serverName: string, fingerprint: string): Promise<TrustDecision | undefined> {
    return decisionIn(await readDocument(this.filename), workspacePath, serverName, fingerprint)
  }

  /**
   * Synchronous, lock-free {@link lookup} of several servers from one read of
   * the trust document, for callers that must decide before returning, such as
   * an `agent/created` listener.
   * @param workspacePath - canonical workspace path used as the top-level document key.
   * @param servers - each server's name within the workspace and current entry fingerprint;
   *   a stored decision for a different fingerprint does not match.
   * @returns the stored decisions in `servers` order, `undefined` where no record exists or the stored fingerprint differs.
   * @throws {TrustStoreError} per {@link readDocumentSync}.
   */
  lookupAllSync(
    workspacePath: string,
    servers: ReadonlyArray<{ readonly name: string; readonly fingerprint: string }>,
  ): Array<TrustDecision | undefined> {
    const document = readDocumentSync(this.filename)
    return servers.map(server => decisionIn(document, workspacePath, server.name, server.fingerprint))
  }

  /**
   * Merges decisions for one workspace into the trust document under the
   * cross-process writer lock, re-reading the document inside the lock so a
   * concurrent writer's decisions for other servers are preserved.
   * @param workspacePath - canonical workspace path to record decisions under.
   * @param decisions - the decisions to merge; each overwrites any existing record for the same server name.
   * @param now - timestamp stamped as `decidedAt` on every decision in this call, in ISO 8601.
   * @throws {TrustStoreError} per {@link readDocument} when re-reading inside the lock.
   */
  async record(workspacePath: string, decisions: readonly TrustDecisionInput[], now: Date): Promise<void> {
    // The lock file's exclusive create needs the parent directory to exist;
    // 0700 because the harness home holds user-private data.
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await withFileLock(this.filename, async () => {
      const document = await readDocument(this.filename)
      const decidedAt = now.toISOString()
      const servers = { ...document.workspaces[workspacePath] }
      for (const decision of decisions) {
        servers[decision.serverName] = { decision: decision.decision, fingerprint: decision.fingerprint, decidedAt }
      }
      const next: TrustDocument = {
        version: 1,
        workspaces: { ...document.workspaces, [workspacePath]: servers },
      }
      // 0600: the trust document lives outside the workspace specifically so
      // a project cannot approve its own servers; it is never world-readable.
      await writeFileAtomic(this.filename, stringifyYaml(next), { mode: 0o600, dirMode: 0o700 })
    })
  }
}
