/**
 * The live connection pool of each mounted plugin, keyed by root context, for
 * the invariant companion. `lib/index.js` and `lib/invariant.js` are separate
 * bundles that each inline this module, so the map is stored under a
 * registered global symbol and both bundles read one instance.
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
