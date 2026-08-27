/**
 * Browser-safe durable payload for one backup-model failover.
 *
 * @module @deepseek-ai/dsh-llm-fallback/types
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'
// The module augmentation below is this package's only reference to
// dsh-session. Without a main-entry import, TypeScript resolves the
// augmented subpath through `paths` to session's source rather than its
// project-reference output and reports TS6305.
import type {} from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable, non-surface record of one move from a failing route to the next
     * configured backup. Required on read, matching `llm/retry`: the envelope's
     * `ignorable` marker has no writer path through `Session.append()`.
     */
    'llm/fallback': LlmFallbackEventData
  }
}

/** One provider route in the failover chain. */
export interface FallbackRoute {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** Durable payload recorded when the plugin moves to the next backup route. */
export interface LlmFallbackEventData {
  /** Turn whose request failed. */
  turn: number
  /** Step whose request failed. */
  step: number
  /** Route that just failed. */
  from: FallbackRoute
  /** Route the retry turn requests. */
  to: FallbackRoute
  /** Cursor after the move; `1` selects `backups[0]`. */
  cursor: number
  /** Provider-neutral failure facts that caused the move. */
  failure: LlmFailure
}
