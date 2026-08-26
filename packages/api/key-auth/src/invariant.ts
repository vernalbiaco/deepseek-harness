/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-api-key-auth`.
 * @module @deepseek-ai/dsh-api-key-auth/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-api-key-auth'

/** Cordis companion plugin name. */
export const name = 'api-key-auth-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns no event stream or mutable runtime
 * data. Its validated key list and gate registration live in a closure local
 * to one `apply` call, not a shared registry this package owns.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
