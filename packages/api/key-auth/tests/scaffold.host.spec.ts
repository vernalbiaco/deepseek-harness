/** The package loads and declares its plugin identity. */

import { describe, expect, it } from 'vitest'
import { name } from '../src/index.ts'

describe('dsh-api-key-auth', () => {
  it('declares a stable plugin name', () => {
    expect(name).toBe('api-key-auth')
  })
})
