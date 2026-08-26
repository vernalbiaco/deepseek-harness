# @deepseek-ai/dsh-api-key-auth

English | [中文](README.zh.md)

An API key admission gate for the `/api` transport. It registers one gate on [`dsh-client-connection`](../../client/connection/README.md)'s `ApiGateRegistry` ([gates](../../client/connection/src/gates.ts)) that admits a caller presenting a configured bearer secret and denies every other caller; it never grants the privileged-method plane.

A request is admitted when its `Authorization` header carries `Bearer <secret>` and `<secret>` matches one configured key's resolved credential, compared with `timingSafeEqual`. On a match the gate returns `{ allow: true, principal: <key name>, privileged: false }`; `privileged` is unconditional and not configurable, so no config makes a keyed caller privileged. A request with no bearer credential and a request with an unrecognized one both answer `401`. A `PRIVILEGED_METHODS` member (settings, credentials, preset authoring, and similar configuration-plane methods; see [gates.ts](../../client/connection/src/gates.ts) and `dsh-client-connection`'s `index.ts`) requires both an aggregate `privileged: true` verdict and passing the loopback-same-origin trust fence; this gate's `privileged: false` alone answers `403` regardless of where the request originated, which is the point — a relay terminating at loopback would otherwise pass the fence on transport alone. Composition — which profile mounts this plugin, and whether that profile also relaxes the trust fence — decides who reaches the configuration plane; no request-level test can distinguish a relayed request from a local one.

## Config

| Key | Default | Meaning |
|---|---|---|
| `keys[].name` | — | Audit label for one accepted key; unique across the list, never a secret. Logged as the principal on admission; every denial logs the literal `none` in its place. |
| `keys[].secret` | — | Credential reference resolving to the key's secret: a bare POSIX shell identifier (for example `DSH_KEY_CI`), matching the same form [`dsh-credentials`](../../credentials/credentials/README.md) reads elsewhere, resolved through `ctx.credentials` by whichever credentials provider the composition mounts. Resolved once per configured key per request, so a rotated secret needs no restart. |
| `order` | `100` | This gate's run order among all registered gates ([`ApiGateRegistry`](../../client/connection/src/gates.ts)), leaving room for gates that must run earlier. A duplicate order across gates is a registration error. |

At least one key is required; an empty `keys` list is a load error, and a duplicate `keys[].name` is a load error. A malformed `keys[].secret` reference fails the same way, at load rather than at the first request.

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

## Model Experience

None, as this package admits or refuses transport requests and contributes nothing to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **A gated profile is reachable by programmatic clients only** — a browser cannot set an `Authorization` header on a WebSocket handshake ([`WebApiClient`](../../client/connection/src/client/web-api-client.ts) opens both downlinks with a bare `new WebSocket(url)`), so the Web UI must stay on an ungated loopback profile.
- **Authentication, not authorization** — every accepted key reaches the same agent methods, workspace, and model quota, so a leaked key is a full agent compromise short of the configuration plane; per-key scopes would extend `ApiGateDecision` rather than replace it.
- **One credential read per configured key per request** — resolution is per request so a rotated secret needs no restart; a deployment with many keys would need a different store and its own invalidation.
- **Match position is observable by timing** — each secret comparison is constant-time, but the loop returns on the first match, so elapsed time reveals a key's position in the list. The list is deployment configuration, not a secret.
- **Secret length is not hidden** — an unequal length answers before the constant-time compare, which `timingSafeEqual` requires.
- **No rate limiting or lockout** — the gate answers every request; blunting brute force belongs to whatever fronts the deployment.
- **An unauthenticated caller still costs a full request buffer** — [`http-bridge.ts`](../../client/connection/src/http-bridge.ts) reads the whole body into memory, up to `maxRequestBodyBytes` (160 MiB by default), before the Fetch handler that runs the gates exists, so refusal cannot precede the allocation. The limit is pre-existing and inherent to the bridge, but a remotely reachable profile is where it becomes reachable by an unauthenticated caller; lower the cap or bound request size in whatever fronts the deployment.
