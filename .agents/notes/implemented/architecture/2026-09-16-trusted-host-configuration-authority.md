# Agent Note: Trusted-host configuration authority

Status: implemented

English | [中文](2026-09-16-trusted-host-configuration-authority.zh.md)

## Problem

A deployment reached through a trusted, authenticated name keeps every Settings edit in page memory. The Web client selects Host persistence per page from `ctx.remote.$host.isLoopback`, so on any non-loopback authority the settings mirror starts `unavailable`: the Models page reports "settings are unavailable in this browser", theme and onboarding choices reset on reload, and a saved provider key never reaches the Host.

The server does not require this. [Browser launch-token authentication](2026-08-24-browser-token-authentication.md) replaced the method-specific loopback tier with one browser session for every `/api` method, so a cookie-holding page on a `trustedHosts` authority already reaches `settings/describe` and every write. Called over HTTP with a session cookie under a trusted non-loopback `Host`, `settings/describe` answers `ok` and `writable: true`; without the cookie it answers 401. The loopback restriction survives only as the Client's persistence choice.

## Decision

`@deepseek-ai/dsh-client-connection` takes `configurationAuthority: 'loopback' | 'trusted-host'`, default `loopback`. `trusted-host` with an empty `trustedHosts` list fails plugin load. The Host injects the value into each served page as `__DSH_CONFIGURATION_AUTHORITY__`, beside the recovery timing it already injects, and the Client validates it with the same schema before providing Connection.

`ctx.connection` gains `configurable`, true on a loopback page or under `trusted-host`, and API Gateway relays it as `ctx.remote.$host.configurable`. The Client need not match the page against `trustedHosts` again: `/api` refuses any `Host` that is neither loopback nor trusted, so a non-loopback page this Host served and admitted is a trusted one. `dsh-ui-settings` selects Host persistence from `configurable`. `isLoopback` keeps its meaning, so **Open configuration file**, which opens an editor on the Host's own desktop, stays loopback-only under both values.

`dsh web --configuration-authority <loopback|trusted-host>` feeds the Connection row through `ctx.webStartup`, and refuses `trusted-host` without a `--trusted-host`.

## Verification

Connection tests cover the injected global under both values, both load refusals, and the Client handle for a loopback page, an untrusted non-loopback page, a `trusted-host` page, and a malformed global. The Gateway test relays `configurable` independently of `isLoopback`. The `dsh-ui-settings` plugin test reads the Host from a configurable non-loopback page and keeps a non-configurable page in memory without a wire read. The web-app startup test covers the flag, its default, and both usage errors.

## Alternatives considered

**Restore the pre-rebase implementation.** It split the configuration methods from the desktop methods on the server, relayed the authority through the removed `dsh-host-apiproxy`, and started non-loopback pages pending until the handshake settled. Upstream has since removed the server tier and the relay, so only the Client choice remains to change. Injecting the value into the page makes it available synchronously in `apply`, so no pending state or welcome-notice flicker handling is needed.

**Treat every trusted authority as configurable without a switch.** That changes upstream's default for every deployment that names a LAN or ingress authority. An explicit value keeps `loopback` the default and records that a deployment chose otherwise.

**Widen `isLoopback` under `trusted-host`.** One field would suffice for Settings, but it would also enable the native editor action on the Host's desktop for remote pages.

## Consequences

Under `trusted-host`, anyone holding a browser session on a trusted authority can change Settings and replace stored credentials. A cookie holder can already run tools in the Host, so this adds no server capability, but the mode relies on a login in front of every trusted authority, such as an identity-aware proxy on the public name.

The value reaches the page only at load, so a Host restart with a different authority takes effect on the next page load. The `privileged` flag on an admitted gate verdict remains unused; this change does not read it.

A pull request carrying this change owes a GIF of the Models page on a trusted non-loopback authority under the `record-browser-gif` rule.
