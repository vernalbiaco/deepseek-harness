/** Package-owned invariant companion for `@deepseek-ai/dsh-mcp-workspace`. @module @deepseek-ai/dsh-mcp-workspace/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-workspace'
/** Cordis companion plugin name. */
export const name = 'mcp-workspace-invariant'
/** Services required before package ownership can be reserved. */
export const inject = ['invariants']
/** No runtime invariant: the scaffold plugin registers no service, event stream, or mutable data; `apply` currently performs no work. */
const install: InvariantInstaller = () => {}
/**
 * Register the package invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
