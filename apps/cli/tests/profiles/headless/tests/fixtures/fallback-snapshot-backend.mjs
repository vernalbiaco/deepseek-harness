/** Deterministic provider adapter for the headless backup-model failover snapshot. */

import {
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'

/** Route the base composition already selects; every request to it fails. */
const PRIMARY_PROVIDER = 'deepseek-official'
/** Route the configured backup names; it answers once the cursor moves. */
const BACKUP_PROVIDER = 'deepseek-backup'

class FallbackSnapshotAdapter extends LlmAdapter {
  firstMessages
  policy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    retryableCodes: ['RATE_LIMIT'],
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'fallback-snapshot-backend.retryPolicy')

  providerRetryPolicy() {
    return this.policy
  }

  async * stream(options) {
    const messages = JSON.stringify(options.messages)
    this.firstMessages ??= messages
    // Held across the failover, not only across the same-route retry: the
    // backup answers the request the primary was sent, reconstructed from
    // durable surface history rather than carried over from the failed call.
    if (messages !== this.firstMessages) {
      throw new Error('fallback snapshot changed the model-visible messages')
    }
    if (options.provider === PRIMARY_PROVIDER) {
      throw new LlmError('snapshot route exhausted', 'RATE_LIMIT', { status: 429 })
    }
    const text = 'FALLBACK_OK'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Cordis plugin name. */
export const name = 'fallback-snapshot-backend'
/** Required LLM registry service. */
export const inject = ['llm']

/**
 * Register one adapter instance for both failover routes, so the model-visible
 * message check spans the primary and the backup.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the LLM service.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter([PRIMARY_PROVIDER, BACKUP_PROVIDER], new FallbackSnapshotAdapter())
}
