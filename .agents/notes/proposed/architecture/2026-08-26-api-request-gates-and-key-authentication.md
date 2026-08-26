# Agent Note: API request gates and key authentication

Status: proposed

English | [中文](2026-08-26-api-request-gates-and-key-authentication.zh.md)

## Problem

The `/api` surface has no authentication, and the packages that own it say so. [`api-request-trust.ts`](../../../../packages/client/connection/src/api-request-trust.ts) describes itself as a DNS-rebinding fence and "not an auth layer"; [`connection`](../../../../packages/client/connection/src/index.ts) pins the whole configuration plane to loopback "until a real authentication layer exists"; the [webserver README](../../../../packages/host/webserver/README.md) places TLS and auth out of scope. Reaching the agent from another machine therefore means exposing an unauthenticated surface that runs code in the workspace and spends the account's model quota.

No extension point can close this. The webserver dispatches one matched route with no middleware, no `next()`, and a duplicate registration throws, so a plugin can only shadow `/api` and orphan the real handler. The one interceptor seat on the `/api` channel is held by the Typert gateway in every shipped composition, and interceptors run inside RPC dispatch, which the `events.mux` and `events.host` WebSocket upgrades never enter. Deep-importing `connection`'s internals to wrap them works in this workspace only, because the package publishes `lib/` and not `src/`.

A second problem outlives the first. `PRIVILEGED_METHODS` — every `settings.*` and `credentials.*` operation, `host.openPath`, `host.pickDirectory`, `agentPreset.*` — is pinned by calling the trust fence with an empty list, meaning loopback. A tunnel daemon or reverse proxy relays to loopback, so a relayed request satisfies that pin. Any remote-access arrangement that terminates at `127.0.0.1` silently grants remote callers the configuration plane, including reading credential metadata and writing new credentials. Authenticating the caller does not fix this by itself: the check cannot distinguish a relayed request from a local one, because at the socket level there is nothing left to distinguish.

## Proposal

Add an ordered request-gate registry to `dsh-client-connection`, and a separate package that implements one gate for API keys.

### The gate registry

`HostConnectionService` gains a registry consulted at each of the three entry checks that exist today — the `/api` HTTP route, the privileged-method decision, and both WebSocket upgrade handlers:

```ts
interface ApiRequestGate {
  /** Ascending run order; a duplicate order is a load error. */
  readonly order: number
  authorize(request: ApiGateRequest): Promise<ApiGateDecision>
}

interface ApiGateRequest {
  transport: 'http' | 'websocket'
  /** RPC method for an `/api/<method>` request; absent for an upgrade. */
  method?: string
  headers: Headers
}

type ApiGateDecision =
  | { allow: true, principal: string, privileged: boolean }
  | { allow: false, status: 401 | 403, reason: string }
```

`register()` returns its disposer. Gates run in ascending order and the first denial wins; a gate that throws denies with `403` and logs the cause, because a gate failing open would defeat its purpose.

Connection carries no policy. It applies two rules mechanically: a denial ends the request, and a request may call a `PRIVILEGED_METHODS` member only when every allowing decision carried `privileged: true`. One gate withholding privilege is therefore sufficient to withhold it, so adding a gate can never widen what an earlier gate granted. The existing host, cross-site, and origin fences continue to run unchanged — a gate adds a requirement and never removes one. A composition with no gate registered behaves exactly as it does today.

### The key-authentication package

`@deepseek-ai/dsh-api-key-auth` registers one gate. It reads `Authorization: Bearer <secret>`, resolves each configured key through `ctx.credentials` on every request so a rotated secret takes effect without a restart, compares in constant time, and returns `{ allow: true, principal: <name>, privileged: false }` on a match. Its `privileged: false` is unconditional and not configurable.

Configuration names keys and references secrets; it never carries a secret value:

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

`name` is the audit label and must be unique. `secret` is a [credential reference](../../../../packages/credentials/credentials/README.md). An empty `keys` list fails at load rather than admitting every caller, and a reference that resolves to nothing denies rather than matching an absent secret.

### Deployment

Composition decides which callers may reach the configuration plane, because no request-level test can. The remote-facing profile mounts the gate; the local profile does not. A relayed request arrives at a server where every request needs a key and every privileged method is refused, so the escalation path closes by construction rather than by detection. Local configuration continues to work on the ungated loopback profile.

## Alternatives considered

**Make the `intercept()` registry multi-seat.** It is a smaller change to an existing mechanism, and an interceptor can already reject. It is disqualified because interceptors run inside RPC dispatch, which the two WebSocket upgrade routes never reach, so both downlinks would stay unauthenticated. It also overloads a contract whose meaning is "this handler claims these endpoints" with an unrelated one.

**Shadow `/api` from a new plugin using longest-prefix precedence.** A more specific route does win, so no core change is needed. But the shadowed handler becomes unreachable — there is no chaining — and reaching the original by proxying to `http://127.0.0.1:<port>/api` rewrites `Host` to loopback, which converts the privileged-method fence into a privilege-escalation path. It also cannot cover the upgrade routes.

**Replace the `connection` row with an auth-wrapping package.** This needs no change to a shipped package and can deep-import `isTrustedApiRequest` and `bridge`. Those imports resolve through `./src/*`, which the package does not publish, so the arrangement works in this workspace and breaks for an installed consumer, and it duplicates registration logic that must then track connection forever.

**Detect relayed requests instead of splitting by composition.** Inspecting `X-Forwarded-For`, comparing socket peers, or requiring a relay header would let one server serve both local and remote callers. Every such signal is supplied by the relay and forgeable by anyone who can reach the port, so the check would protect the configuration plane with a header an attacker controls.

**Terminate authentication in a reverse proxy and change nothing here.** This is the smallest option and uses mature software. It leaves the harness with no concept of who called, so no audit trail, no per-key identity, and no defence if the proxy is ever misconfigured or bypassed. It also leaves the privileged-method escalation intact, since the proxy still relays to loopback.

**Configurable privileged-method policy.** Letting a deployment choose which methods a keyed caller reaches is more flexible. A misconfiguration is silent and the blast radius is the credential store, so the default would be the only real protection; a fixed refusal in the gate package is the safer contract.

## Acceptance criteria

An `/api` HTTP request without a valid key is refused with `401` and `WWW-Authenticate: Bearer`; with a valid key it dispatches normally. A WebSocket upgrade to `events.mux` or `events.host` without a valid key is rejected at the socket. A keyed caller invoking any `PRIVILEGED_METHODS` member receives `403`, and the same call on the ungated loopback profile still succeeds.

Rotating a key's secret takes effect on the next request with no restart. Deleting a key's row revokes exactly that key. An empty `keys` list, a duplicate `name`, and a duplicate gate `order` each fail at load with a message naming the offending entry.

No log line, error message, RPC response, or `describe()` result contains a secret. Every decision logs the principal name or `none`, the method, the transport, and the outcome. A composition that registers no gate produces byte-identical behaviour to the current one.

Both packages hold per-file 100% coverage. A real-composition webserver test proves the HTTP route and both upgrade routes reject an unkeyed request, and `pnpm run test:coverage` and the snapshot suite pass.

## Risks

A gate sits on the request path for every `/api` call, so a bug there fails every caller rather than one feature. The mitigation is that connection holds no policy and a throwing gate denies rather than admits, which makes the failure loud and safe.

Resolving every configured key per request costs one credential read per key per request. That is acceptable for a handful of keys and would need a different store — with its own invalidation — if a deployment ever wants many.

The composition split is a real constraint that a person can get wrong: mounting the gate on the profile a tunnel does not point at, or exposing the ungated profile, reopens exactly the hole this closes. Nothing in the code can detect that mistake, so it must be stated wherever the remote-access arrangement is documented.

Key authentication is not authorization. Every accepted key reaches the same agent methods with the same workspace and the same model quota, so a leaked key is a full agent compromise short of the configuration plane. Per-key scopes are deliberately out of scope here and would extend `ApiGateDecision` rather than replace it.
