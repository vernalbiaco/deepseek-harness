# Agent Note: API request gates and key authentication

Status: implemented

English | [中文](2026-08-26-api-request-gates-and-key-authentication.zh.md)

## Problem

The `/api` surface carried no authentication, and the packages that own it said so. [`api-request-trust.ts`](../../../../packages/client/connection/src/api-request-trust.ts) describes itself as a DNS-rebinding fence and "not an auth layer"; [`connection`](../../../../packages/client/connection/src/index.ts) pins the whole configuration plane to loopback "until a real authentication layer exists"; the [webserver README](../../../../packages/host/webserver/README.md) places TLS and auth out of scope. Reaching the agent from another machine therefore meant exposing an unauthenticated surface that runs code in the workspace and spends the account's model quota.

No extension point could close this. The webserver dispatches one matched route with no middleware, no `next()`, and a duplicate registration throws, so a plugin can only shadow `/api` and orphan the real handler. The one interceptor seat on the `/api` channel is held by the Typert gateway in every shipped composition, and interceptors run inside RPC dispatch, which the `events.mux` and `events.host` WebSocket upgrades never enter. Deep-importing `connection`'s internals to wrap them works in this workspace only, because the package publishes `lib/` and not `src/`.

A second problem outlives the first. `PRIVILEGED_METHODS` — the `settings.*` and `credentials.*` operations, `host.openPath`, `host.pickDirectory`, `llm.discoverModels`, and the `agentPreset` authoring methods `agentPreset.read`, `agentPreset.copy`, `agentPreset.openDocument`, and `agentPreset.remove` (neither `agentPreset.list` nor preset selection is pinned) — is pinned by calling the trust fence with an empty list, meaning loopback. A tunnel daemon or reverse proxy relays to loopback, so a relayed request satisfies that pin. Any remote-access arrangement that terminates at `127.0.0.1` silently grants remote callers the configuration plane, including reading credential metadata and writing new credentials. Authenticating the caller does not fix this by itself: the check cannot distinguish a relayed request from a local one, because at the socket level there is nothing left to distinguish.

## Decision

`dsh-client-connection` owns an ordered request-gate registry, and a separate package implements one gate over it for API keys.

### The gate registry

[`gates.ts`](../../../../packages/client/connection/src/gates.ts) holds the registry; a plugin contributes a gate through `ctx.connection.gates.register()`, which returns the disposer:

```ts
/** One request presented to the gates. */
export interface ApiGateRequest {
  readonly transport: 'http' | 'websocket'
  /** Dotted RPC method or `<namespace>/<method>` interceptor endpoint; absent for an upgrade. */
  readonly method?: string
  readonly headers: Headers
}

/** One gate's verdict on one request. */
export type ApiGateDecision =
  | { readonly allow: true; readonly principal: string; readonly privileged: boolean }
  | { readonly allow: false; readonly status: 401 | 403; readonly reason: string }

/** An admission gate contributed by a plugin. */
export interface ApiRequestGate {
  /** Ascending run order; a duplicate order is a registration error. */
  readonly order: number
  authorize(request: ApiGateRequest): Promise<ApiGateDecision>
}

/** The registry's aggregate verdict over every registered gate. */
export type ApiGateVerdict =
  | { readonly admitted: true; readonly principals: readonly string[]; readonly privileged: boolean }
  | { readonly admitted: false; readonly status: 401 | 403; readonly reason: string }
```

Gates run in ascending order and the first denial wins. A duplicate `order` throws from `register()`, so the load of the plugin contributing the second gate fails. A gate that throws denies with `403` and its cause is discarded rather than logged or reported: the registry owns no logging channel, and the denial reason travels back to the caller that triggered it, so surfacing gate internals there would leak them.

Connection carries no policy. It applies two rules mechanically: a denial ends the request, and a request may call a `PRIVILEGED_METHODS` member only when the aggregate verdict carries `privileged: true` **and** the request passes the trust fence with an empty trust list. Privilege is the conjunction of every allowing decision, so one gate withholding it withholds it outright, and adding a gate can never widen what an earlier gate granted. The existing host, cross-site, and origin fences continue to run unchanged — a gate adds a requirement and never removes one. An empty registry admits every request with full privilege, which is the behavior of a composition that registers no gate.

### Where the gates are consulted

`/api` HTTP requests are gated inside `createSharedFetchHandler` ([`rpc-host.ts`](../../../../packages/client/connection/src/rpc-host.ts)), **ahead of interceptor selection**, so every request on the channel is authorized exactly once no matter which target claims it. Behind interceptor selection, the interceptor's endpoints would be an unauthenticated seat on the transport: [`packages/api/gateway`](../../../../packages/api/gateway/README.md) holds the single `/api` interceptor seat in every default profile through [`packages/bundle/base/cordis.patch.yml`](../../../../packages/bundle/base/cordis.patch.yml), so a claimed endpoint would dispatch for an anonymous caller. Connection's fallback receives the admitting verdict and the same `method` string the gates were given, so its privileged-method decision cannot read a different method than the one authorized.

Both WebSocket upgrade handlers ([`index.ts`](../../../../packages/client/connection/src/index.ts)) call `authorizeApiRequest` after the trust fence, and an unadmitted verdict rejects the upgrade with the fixed `403 Forbidden` response `rejectWebSocketUpgrade` writes, so a gate that denies with `401` still surfaces as `403` on an upgrade.

A denied HTTP request answers with the gate's status and its reason as the body; a `401` additionally carries `WWW-Authenticate: Bearer`.

### The key-authentication package

`@deepseek-ai/dsh-api-key-auth` registers one gate, at order `100` by default. It reads `Authorization: Bearer <secret>`, resolves each configured key through `ctx.credentials` on every request so a rotated secret takes effect without a restart, compares with `timingSafeEqual`, and returns `{ allow: true, principal: <name>, privileged: false }` on a match. Its `privileged: false` is unconditional and not configurable, so no configuration makes a keyed caller privileged.

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

`name` is the audit label and must be unique. `secret` is a [credential reference](../../../../packages/credentials/credentials/README.md). An empty `keys` list, a duplicate `name`, and a malformed reference each fail at load rather than at the first request, and a reference that resolves to nothing is skipped rather than matched against an absent secret, so a caller whose secret matches only an unresolvable reference ends at the ordinary `401 unrecognized credential`.

### Deployment

Composition decides which callers may reach the configuration plane, because no request-level test can. The remote-facing profile mounts the gate; the local profile does not. A relayed request arrives at a server where every request needs a key and every privileged method is refused, so the escalation path closes by construction rather than by detection. Local configuration continues to work on the ungated loopback profile, which is also the only profile the Web UI can use: a browser cannot set an `Authorization` header on a WebSocket handshake, so a gated profile serves programmatic clients only.

## Alternatives considered

**Make the `intercept()` registry multi-seat.** It is a smaller change to an existing mechanism, and an interceptor can already reject. It is disqualified because interceptors run inside RPC dispatch, which the two WebSocket upgrade routes never reach, so both downlinks would stay unauthenticated. It also overloads a contract whose meaning is "this handler claims these endpoints" with an unrelated one.

**Shadow `/api` from a new plugin using longest-prefix precedence.** A more specific route does win, so no core change is needed. But the shadowed handler becomes unreachable — there is no chaining — and reaching the original by proxying to `http://127.0.0.1:<port>/api` rewrites `Host` to loopback, which converts the privileged-method fence into a privilege-escalation path. It also cannot cover the upgrade routes.

**Replace the `connection` row with an auth-wrapping package.** This needs no change to a shipped package and can deep-import `isTrustedApiRequest` and `bridge`. Those imports resolve through `./src/*`, which the package does not publish, so the arrangement works in this workspace and breaks for an installed consumer, and it duplicates registration logic that must then track connection forever.

**Detect relayed requests instead of splitting by composition.** Inspecting `X-Forwarded-For`, comparing socket peers, or requiring a relay header would let one server serve both local and remote callers. Every such signal is supplied by the relay and forgeable by anyone who can reach the port, so the check would protect the configuration plane with a header an attacker controls.

**Terminate authentication in a reverse proxy and change nothing here.** This is the smallest option and uses mature software. It leaves the harness with no concept of who called, so no audit trail, no per-key identity, and no defense if the proxy is ever misconfigured or bypassed. It also leaves the privileged-method escalation intact, since the proxy still relays to loopback.

**Configurable privileged-method policy.** Letting a deployment choose which methods a keyed caller reaches is more flexible. A misconfiguration is silent and the blast radius is the credential store, so the default would be the only real protection; a fixed refusal in the gate package is the safer contract.

## Testing

Registry semantics are pinned directly: an empty registry admits with full privilege, principals accumulate in ascending order, privilege folds with AND, the first denial reports its own status, a throwing gate denies `403` without leaking the cause, a duplicate order is refused at registration, and a disposer frees its order for a later gate.

Enforcement is pinned at each seam. An unadmitted `/api` request answers the gate's status, with the `Bearer` challenge on a `401` and none on a `403`; an admitted but unprivileged caller is refused a `PRIVILEGED_METHODS` member; an interceptor-claimed endpoint is refused without reaching the interceptor's handler; the gates run exactly once per request whether or not the interceptor claims it, and the bare `/api` path reaches them with no method. Both upgrade routes reject an unadmitted upgrade at the socket.

The key gate's own tests cover the load failures (empty list, duplicate name, malformed reference, none echoing the offending value), `401` for a missing and for an unrecognized credential, admission as the key's name with privilege never granted, a reference resolving to nothing, rotation taking effect on the next request, removal revoking exactly one key while its sibling still admits, configured and default order, disposal on fiber teardown, and that every decision logs the principal name or `none`, the transport, the method, and the outcome.

A real-composition test boots two cordis.yml compositions through the vendored Loader onto listening loopback sockets and crosses them with a real HTTP client and the real `ws` client; the two differ in one row, the gate. It proves that an unkeyed `/api` call, an unkeyed call to a Gateway-claimed endpoint, and an unkeyed upgrade to either downlink are all refused while the keyed arm succeeds, and that a keyed caller is refused `credentials.describe`. The ungated arm is what makes that last `403` a result rather than an artifact: the same call succeeds there and reaches the real credential seam, separating "the gate withheld privilege" from "the trust fence refused the request". A call counter on `RemoteFixture`, the test Remote the Gateway claims, proves the claimed-endpoint refusal lands before the interceptor runs, not after.

## Consequences

Gate consultation sits ahead of interceptor selection on the `/api` channel, so an interceptor is no longer a place where authentication can be skipped. The cost is that an interceptor no longer sees the requests the gates refuse, and any future interceptor inherits the gate requirement whether or not its author knows the registry exists.

That placement is invisible to a unit test built on a fake `webServer`: such a test registers the route and calls the handler it captured, which exercises the seam it already believes in. Only a request that crosses a real socket into an endpoint a real interceptor claims observes which of the two answers first. Coverage for the `/api` transport therefore needs at least one arm assembled through the Loader over a listening port; a fake-transport suite at full coverage is not evidence about dispatch order.

A gate sits on the request path for every `/api` call, so a bug there fails every caller rather than one feature. Connection holds no policy and a throwing gate denies rather than admits, which makes such a failure loud and safe.

Resolving every configured key per request costs one credential read per key per request. That is acceptable for a handful of keys and would need a different store — with its own invalidation — if a deployment ever wants many.

The composition split is a real constraint that a person can get wrong: mounting the gate on the profile a tunnel does not point at, or exposing the ungated profile, reopens exactly the hole this closes. Nothing in the code can detect that mistake, so it must be stated wherever the remote-access arrangement is documented.

Key authentication is not authorization. Every accepted key reaches the same agent methods with the same workspace and the same model quota, so a leaked key is a full agent compromise short of the configuration plane. Per-key scopes are out of scope here and would extend `ApiGateDecision` rather than replace it.
