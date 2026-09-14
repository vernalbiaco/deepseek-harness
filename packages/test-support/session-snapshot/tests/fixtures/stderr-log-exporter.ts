import { format } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'stderr-log-exporter'

/**
 * Write every logger message up to `warn` to stderr, where the snapshot
 * harness captures it; stdout stays reserved for ACP JSON-RPC. The exporter
 * sets its own level because Cordis drops `warn` below the default `info`
 * threshold.
 */
export function apply(ctx: Context): void {
  ctx.logger.exporter({
    levels: { default: 2 },
    export(message) {
      process.stderr.write(`[${message.type}] ${format(...(message.args as unknown[]))}\n`)
    },
  })
}
