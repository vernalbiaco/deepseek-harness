import { expect, it } from 'vitest'
import { name } from '@deepseek-ai/dsh-llm-fallback'

it('publishes the plugin name', () => {
  expect(name).toBe('llm-fallback')
})
