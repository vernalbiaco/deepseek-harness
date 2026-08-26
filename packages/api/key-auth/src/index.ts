/**
 * API key admission gate for the `/api` transport. Registers one gate on
 * `dsh-client-connection`'s gate registry that admits a caller presenting a
 * configured bearer secret, and never grants the privileged-method plane.
 *
 * @module @deepseek-ai/dsh-api-key-auth
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ApiGateDecision, ApiGateRequest } from '@deepseek-ai/dsh-client-connection'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { bearerSecret, secretsMatch } from './keys.ts'

/** Stable Cordis plugin name. */
export const name = 'api-key-auth'

/** Services this plugin requires. */
export const inject = ['connection', 'credentials']

/** One accepted key: an audit label and the credential holding its secret. */
export interface KeyConfig {
  /** Audit label; unique across the list, never a secret. */
  name: string
  /** Credential reference resolving to the secret. */
  secret: string
}

/** Default gate order, leaving room for gates that must run earlier. */
const DEFAULT_ORDER = 100

/** Plugin configuration. */
export interface Config {
  /** Accepted keys; an empty list is a load error. */
  keys: KeyConfig[]
  /** Gate run order among all registered gates; defaults to `100` when omitted. */
  order?: number
}

/** Schema of the plugin configuration. */
export const Config: z<Config> = z.object({
  keys: z.array(z.object({
    name: z.string().required(),
    secret: z.string().required(),
  })).required(),
  order: z.natural().default(DEFAULT_ORDER),
})

/**
 * Plugin configuration after schema resolution: `order` is always populated
 * by `Config`'s `.default(DEFAULT_ORDER)` before `apply` runs, so it is
 * non-optional here. `Config` itself keeps `order` optional so a literal
 * caller (a raw `cordis.yml` entry, a hand-built test config) may omit it.
 */
type ResolvedConfig = Required<Config>

/** One validated key: its audit label and the branded reference to its secret. */
interface ResolvedKeyConfig {
  /** Audit label; never a secret. */
  name: string
  /** Branded credential reference. */
  secret: CredentialRef
}

/**
 * Validate the configured key list: at least one key, and every name unique.
 * Branding each `secret` here fails the load loudly on a malformed reference,
 * rather than at the first request.
 * @param keys - configured keys, as given.
 * @returns the same keys with `secret` branded as a {@link CredentialRef}.
 */
function validateKeys(keys: readonly KeyConfig[]): ResolvedKeyConfig[] {
  if (keys.length === 0) {
    throw new Error('api-key-auth: configure at least one key, or do not mount this plugin')
  }
  const seen = new Set<string>()
  return keys.map((key) => {
    if (seen.has(key.name)) throw new Error(`api-key-auth: duplicate key name "${key.name}"`)
    seen.add(key.name)
    try {
      return { name: key.name, secret: credentialRef(key.secret) }
    } catch {
      // credentialRef's own error interpolates the malformed value; a
      // caller who pasted a secret into this field (named `secret:`, not
      // `secretRef:`) must never see it echoed back in a load error.
      throw new Error(`api-key-auth: key "${key.name}" has an invalid credential reference`)
    }
  })
}

/**
 * Register the key gate.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolvedConfig = config as ResolvedConfig
  const keys = validateKeys(resolvedConfig.keys)

  const authorize = async (request: ApiGateRequest): Promise<ApiGateDecision> => {
    const presented = bearerSecret(request.headers)
    if (presented === undefined) {
      ctx.logger.info(`api-key-auth: denied none ${request.transport} ${request.method ?? 'upgrade'} (no credential)`)
      return { allow: false, status: 401, reason: 'missing bearer credential' }
    }
    for (const key of keys) {
      const resolved = await ctx.credentials.resolve(key.secret)
      if (resolved === undefined) continue
      if (!secretsMatch(presented, resolved.value)) continue
      ctx.logger.info(`api-key-auth: admitted ${key.name} ${request.transport} ${request.method ?? 'upgrade'}`)
      return { allow: true, principal: key.name, privileged: false }
    }
    ctx.logger.info(`api-key-auth: denied none ${request.transport} ${request.method ?? 'upgrade'} (unrecognized)`)
    return { allow: false, status: 401, reason: 'unrecognized credential' }
  }

  ctx.effect(() => ctx.connection.gates.register({ order: resolvedConfig.order, authorize }), 'api-key-auth: gate')
}
