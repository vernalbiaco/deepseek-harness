/** Shared validation for the Host-configured, page-injected configuration authority. */
import z from '@deepseek-ai/schemastery'

/**
 * Which pages may read and write Host configuration (the `settings` and
 * `credentials` Remote namespaces) instead of keeping edits in page memory.
 * `loopback` admits only a loopback page; `trusted-host` also admits a page
 * served under a `trustedHosts` authority. Actions on the Host's own desktop,
 * such as opening the settings document, stay loopback-only under both.
 */
export type ConfigurationAuthority = 'loopback' | 'trusted-host'

/** Schema shared by the Host plugin and the Client's page-global parser. */
export const ConfigurationAuthoritySchema: z<ConfigurationAuthority> = z.union(['loopback', 'trusted-host']).default('loopback')

/**
 * Validate a configuration authority and supply its default.
 * @param value - Host configuration or page bootstrap data; absent selects `loopback`.
 * @returns the validated authority.
 */
export function resolveConfigurationAuthority(value?: unknown): ConfigurationAuthority {
  return ConfigurationAuthoritySchema(value as ConfigurationAuthority)
}
