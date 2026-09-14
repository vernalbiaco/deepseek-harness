/**
 * The live connection pool of each mounted plugin, keyed by root context, for
 * the invariant companion. The package's `tsdown.config.ts` builds
 * `lib/index.js` and `lib/invariant.js` as independent bundles, so each
 * inlines its own copy of this module's code. `Symbol.for` interns by string
 * key, so both copies' `ACTIVE_POOLS` constants are the identical symbol;
 * reading and writing `globalThis[ACTIVE_POOLS]` therefore reaches one shared
 * map regardless of which bundle set it first.
 * @module @deepseek-ai/dsh-mcp-workspace/active-pools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WorkspacePool } from './pool.ts'

const ACTIVE_POOLS = Symbol.for('@deepseek-ai/dsh-mcp-workspace/active-pools')

/**
 * The process-wide pool map.
 * @returns the map from root context to the pool of the plugin mounted in that app.
 */
export function activePools(): WeakMap<Context, WorkspacePool> {
  const holder = globalThis as Record<symbol, WeakMap<Context, WorkspacePool> | undefined>
  return holder[ACTIVE_POOLS] ??= new WeakMap()
}
