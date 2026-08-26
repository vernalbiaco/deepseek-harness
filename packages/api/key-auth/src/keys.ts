/**
 * Credential extraction and comparison for the API key gate.
 *
 * @module @deepseek-ai/dsh-api-key-auth/keys
 */

import { timingSafeEqual } from 'node:crypto'

const BEARER = /^bearer\s+(\S+)$/i

/**
 * Read the bearer token presented on a request.
 * @param headers - request headers.
 * @returns the token, or undefined when absent, empty, or another scheme.
 */
export function bearerSecret(headers: Headers): string | undefined {
  const raw = headers.get('authorization')
  if (raw === null) return undefined
  const match = BEARER.exec(raw.trim())
  return match?.[1]
}

/**
 * Compare a presented secret with a stored one without leaking the position of
 * the first differing byte. Length is not secret: an unequal length answers
 * immediately, which `timingSafeEqual` requires.
 * @param presented - the value the caller sent.
 * @param stored - the configured value.
 * @returns whether the two are byte-identical and non-empty.
 */
export function secretsMatch(presented: string, stored: string): boolean {
  if (presented.length === 0 || stored.length === 0) return false
  const left = Buffer.from(presented, 'utf8')
  const right = Buffer.from(stored, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
