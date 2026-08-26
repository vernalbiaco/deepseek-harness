/** Bearer extraction and comparison. */

import { describe, expect, it } from 'vitest'
import { bearerSecret, secretsMatch } from '../src/keys.ts'

describe('bearerSecret', () => {
  it('reads the token from a well-formed header', () => {
    expect(bearerSecret(new Headers({ authorization: 'Bearer abc123' }))).toBe('abc123')
  })

  it('accepts the scheme case-insensitively and trims surrounding space', () => {
    expect(bearerSecret(new Headers({ authorization: '  bearer   abc123  ' }))).toBe('abc123')
  })

  it('returns undefined for an absent, empty, or non-Bearer header', () => {
    expect(bearerSecret(new Headers())).toBeUndefined()
    expect(bearerSecret(new Headers({ authorization: 'Bearer ' }))).toBeUndefined()
    expect(bearerSecret(new Headers({ authorization: 'Basic abc123' }))).toBeUndefined()
  })
})

describe('secretsMatch', () => {
  it('is true only for an exact match', () => {
    expect(secretsMatch('abc123', 'abc123')).toBe(true)
    expect(secretsMatch('abc123', 'abc124')).toBe(false)
  })

  it('is false for differing lengths without throwing', () => {
    expect(secretsMatch('short', 'much-longer-secret')).toBe(false)
  })

  it('is false when either side is empty', () => {
    expect(secretsMatch('', '')).toBe(false)
    expect(secretsMatch('abc', '')).toBe(false)
  })
})
