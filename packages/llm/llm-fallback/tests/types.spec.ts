import { expectTypeOf, it } from 'vitest'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { LlmFallbackEventData } from '@deepseek-ai/dsh-llm-fallback/types'

it('keeps the browser-safe payload identical to the session event', () => {
  expectTypeOf<LlmFallbackEventData>().toEqualTypeOf<SessionEventMap['llm/fallback']>()
})
