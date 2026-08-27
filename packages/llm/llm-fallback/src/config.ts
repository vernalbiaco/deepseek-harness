/**
 * Composition entry and resolved chain for backup-model failover.
 *
 * @module @deepseek-ai/dsh-llm-fallback/config
 */

import z from '@deepseek-ai/schemastery'
import type { FallbackRoute } from './types.ts'

/**
 * Codes that move the cursor when no downstream policy owns the failure.
 * The transient codes act only after `dsh-llm-retry` exhausts its budget and
 * delegates; the credential, quota, and routing codes are outside every
 * retryable set, so they reach this plugin on the first failure.
 */
export const DEFAULT_FAILOVER_CODES: readonly string[] = Object.freeze([
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
  'AUTH',
  'QUOTA',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'NO_ADAPTER',
])

/** Composition entry for the failover chain. */
export interface Config {
  /** Ordered backup routes tried after the session's current route fails. */
  backups: FallbackRoute[]
  /** Failure codes that move the cursor; defaults to {@link DEFAULT_FAILOVER_CODES}. */
  failoverCodes?: string[]
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  backups: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
  })).required(),
  failoverCodes: z.array(z.string()),
})

/** Validated chain and code membership used by the plugin at runtime. */
export interface ResolvedFallbackConfig {
  /** Ordered backup routes; `backups[n - 1]` serves cursor `n`. */
  readonly backups: readonly FallbackRoute[]
  /** Failure codes that move the cursor. */
  readonly failoverCodes: ReadonlySet<string>
}

/**
 * Validate the composition entry and resolve it into runtime lookups.
 *
 * @param config - the composition entry as written in cordis.yml.
 * @returns the ordered chain and the code membership set.
 * @throws when the chain is empty, holds a duplicate route, or supplies an empty code list.
 */
export function resolveConfig(config: Config): ResolvedFallbackConfig {
  if (config.backups.length === 0) {
    throw new Error('llm-fallback: backups must list at least one route')
  }
  const seen = new Set<string>()
  for (const route of config.backups) {
    const key = `${route.provider}/${route.model}`
    if (seen.has(key)) throw new Error(`llm-fallback: duplicate backup route "${key}"`)
    seen.add(key)
  }
  if (config.failoverCodes !== undefined && config.failoverCodes.length === 0) {
    throw new Error('llm-fallback: failoverCodes must list at least one code when present')
  }
  return {
    backups: config.backups.map(route => ({ provider: route.provider, model: route.model })),
    failoverCodes: new Set(config.failoverCodes ?? DEFAULT_FAILOVER_CODES),
  }
}
