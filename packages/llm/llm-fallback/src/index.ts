/**
 * Ordered backup-model failover on the agent loop's request-recovery and
 * request-configuration extension points.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

export type { FallbackRoute, LlmFallbackEventData } from './types.ts'

/** Cordis plugin name. */
export const name = 'llm-fallback'
