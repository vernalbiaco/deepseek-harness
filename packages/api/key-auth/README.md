---
description: "API key admission gate for the /api transport: admits a browser session that also presents a configured bearer secret."
kind: "package-reference"
---
# API Key Auth

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-key-auth` registers one admission gate on [`dsh-client-connection`](../../client/connection/README.md)'s gate registry ([`gates.ts`](../../client/connection/src/gates.ts)). The gate admits a request whose `Authorization` header carries `Bearer <secret>` matching one configured key's resolved credential and refuses every other request with `401`. Connection runs gates only after its Host/Origin fence and its browser-session cookie check, so an admitted request needs both a browser session and a key.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a profile that also mounts `dsh-client-connection` and a credentials provider. The secret comparison uses `timingSafeEqual`. On a match the gate returns `{ allow: true, principal: <key name>, privileged: false }`; `privileged` is always `false`, and the current Connection has no method that reads it. A request without a bearer credential and a request with an unrecognized one both answer `401` with a `www-authenticate: Bearer` challenge on the HTTP path; a refused `/api/remote.mux` upgrade answers the gate's status.

Connection refuses a request without a valid browser-session cookie before any gate runs, so a program holding only a key receives Connection's `401`, not this gate's decision.

```yaml
- id: api-key-auth
  name: '@deepseek-ai/dsh-api-key-auth'
  config:
    keys:
      - name: laptop
        secret: DSH_KEY_LAPTOP
      - name: ci
        secret: DSH_KEY_CI
```

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `keys[].name` | — | Audit label for one accepted key; unique across the list, never a secret. Logged as the principal on admission; every denial logs `none` in its place. |
| `keys[].secret` | — | Credential reference resolving to the key's secret, a bare POSIX shell identifier such as `DSH_KEY_CI`, resolved through `ctx.credentials` on every request, so a rotated secret needs no restart. |
| `order` | `100` | This gate's run order among all registered gates; a duplicate order across gates is a registration error. |

An empty `keys` list, a duplicate `keys[].name`, and a malformed `keys[].secret` reference are load errors. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-key-auth) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package admits or refuses transport requests and contributes nothing to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No key-only client can reach `/api`** — Connection's browser-session check precedes every gate, so this package cannot admit a program that has no browser cookie.
- **A gated profile refuses the Web UI's stream** — a browser cannot set `Authorization` on a WebSocket handshake, so mounting this gate on a browser profile refuses its `/api/remote.mux` upgrade.
- **Authentication, not authorization** — every accepted key reaches the same agent methods, workspace, and model quota.
- **One credential read per configured key per request** — a deployment with many keys would need a different store and its own invalidation.
- **Match position is observable by timing** — each comparison is constant-time, but the loop returns on the first match; the key list is deployment configuration, not a secret.
- **Secret length is not hidden** — an unequal length answers before the constant-time compare, which `timingSafeEqual` requires.
- **No rate limiting or lockout** — blunting brute force belongs to whatever fronts the deployment.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The gate was designed for a Connection that admitted cookie-less loopback and trusted-host requests; the [admission-gate Agent Note](../../../.agents/notes/implemented/architecture/2026-08-26-api-request-gates-and-key-authentication.md) records that design.

</details>

**Runtime invariant:** No companion is published. This package owns no event stream or mutable runtime data; its validated key list and gate registration live in one `apply` call's closure.
