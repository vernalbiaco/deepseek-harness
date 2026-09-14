# Agent Note: Workspace-declared MCP servers behind a project-trust gate

Status: implemented

English | [中文](2026-09-14-workspace-mcp-servers.zh.md)

## Problem

MCP servers reach a Harness process only as `@deepseek-ai/dsh-mcp-client` rows in a profile or `--patch` layer. Every row is process-global: its tools register on the global `ctx.tools` layer and reach every session in every workspace. A Web deployment that serves several workspaces from one process therefore cannot give one workspace its own servers, and a project that already ships a Claude Code `.mcp.json` must be hand-converted into Cordis rows before the Harness can use it.

Loading a workspace's own server list without a gate is not acceptable. A stdio MCP server is an executable spawned by the MCP SDK outside the agent sandbox, and an HTTP server receives workspace data and bearer credentials. The [configuration source ownership decision](2026-08-04-configuration-source-ownership.md) trusts the launch project for routing and credentials without a prompt and names "a later project-trust gate" as the place where discovered project configuration that runs code gets addressed. No such gate exists: project skills, `AGENTS.md`, and project `.env` values all load unconditionally, and no current plugin runs a program named by a workspace file.

## Decision

`@deepseek-ai/dsh-mcp-workspace` is a plugin mounted in the base bundle. It reads `<canonical session cwd>/.mcp.json`, admits each declared server only through a user decision stored outside the workspace, shares one supervised connection per workspace server across the sessions that use it, and registers the discovered tools on each eligible agent's own tool layer. The [package README](../../../../packages/mcp/mcp-workspace/README.md) owns the configuration, `.mcp.json` support table, and log lines.

### Changes to `@deepseek-ai/dsh-mcp-client`

The supervisor in `connection.ts` is reusable without mounting the plugin. `startConnection(ctx, config, policy, options?)` accepts an options object with two members:

```ts
import type { Config, ToolDefinitions } from '@deepseek-ai/dsh-mcp-client'

interface ToolSink {
  replace(definitions: ToolDefinitions, failure: 'contain' | 'throw'): void
  clear(): void
}

interface ConnectionOptions {
  sink?: ToolSink
  resolveConfig?: () => Promise<Config>
}
```

`fetchToolDefinitions` drains `tools/list` and builds definitions without touching a registry, and `createRegistrySink` is the default sink that performs the dispose-then-register swap with rollback. The plugin's `apply` passes no options and keeps its behavior. `resolveConfig` runs before every connection attempt, so a caller that resolves credential placeholders sees rotated values on reconnect; a rejection counts toward the reconnect budget like a failed connect. A definition built once serves every agent: image admission reads `attachments` and `llm` through `ctx.get` and the calling route through `exec.agent` at execution time, and `ctx.tools.register` stores the definition without mutating it. `index.ts` exports `startConnection`, `resolveReconnectPolicy`, `RECONNECT_DEFAULTS`, `fetchToolDefinitions`, `createRegistrySink`, and `publicToolName`, plus the types `ConnectionHandle`, `ConnectionOptions`, `ConnectionOutcome`, `ToolSink`, `ToolDefinitions`, and `ToolBridgeOptions`; the build entry list is unchanged.

### Package `@deepseek-ai/dsh-mcp-workspace`

| Module | Responsibility |
|---|---|
| `mcp-json.ts` | Parse `.mcp.json` `mcpServers` into stdio (`command`, `args`, `env`) or HTTP (`type: "http"`, `url`, `headers`) entries; refuse invalid server names, `sse`, `${NAME:-default}`, and literal secrets; compute each entry's `sha256:` fingerprint over its key-sorted JSON before substitution |
| `trust-store.ts` | Read and write `mcp-trust.yaml`: canonical workspace path → server name → `{ decision: allow \| deny, fingerprint, decidedAt }`, written under `withFileLock` with `writeFileAtomic` at mode `0600`; `lookupAllSync` serves the synchronous attachment with one read |
| `pool.ts` | One supervised connection per `(workspace path, server name, fingerprint)`, its current definition set, and the agent contexts attached through its leases; releasing the last lease closes the connection |
| `binder.ts` | The `agent/created` handler: attach eligible agents synchronously, run `.mcp.json` reads, trust lookups, credential checks, and questions afterwards, and release leases on agent disposal |
| `index.ts` | Plugin wiring, `Config`, and preconnect at activation |
| `active-pools.ts` | The process-wide map from root context to live pool that the invariant companion reads; it is keyed through `Symbol.for`, so the separately built `index.js` and `invariant.js` share one map |
| `invariant.ts` | At every `request/header`, checks that every pool attachment belongs to a live agent whose canonical cwd is the attachment's workspace path, and that every tool name the pool reports for it resolves for that agent |
| `types.ts` | Parsed entry and declared-server types |

`Config` fields: `trustFile` (required; the base bundle row sets `!!js dshHomePath('mcp-trust.yaml')`), `preconnect` (default `true`), `preconnectTimeoutMs` (default `10000`), `toolCallTimeoutMs` (default `60000`), and `reconnect` (the `mcp-client` reconnect policy, validated by `resolveReconnectPolicy` at load). The file name `.mcp.json` is an external format and stays fixed. `tsdown.config.ts` builds `index.js` and `invariant.js` as two independent bundles, so the published package contains no shared chunk.

### Workspace identity

The workspace key is `realpath(session.header.cwd)`. The session header carries no workspace id, `dsh-workspace` is mounted only by the Web bundle, and a raw Web `payload.cwd` is not canonicalized by the host. The key is the canonical cwd itself, not the nearest `.git` ancestor, matching Claude Code's project `.mcp.json` and the Web workspace path. A stdio child runs with that canonical path as its cwd.

### Trust decisions

Each server's decision is looked up by canonical path, server name, and fingerprint. A matching `allow` connects; a matching `deny` skips without asking; a missing entry or a changed fingerprint needs a decision. The fingerprint excludes resolved credential values, so rotating a token does not re-ask, while changing a command, argument, URL, env or header template, or any other key does.

Every attachment rechecks the stored decision: the synchronous attachment in `agent/created`, the recheck after that agent's `.mcp.json` read, and the recheck immediately before an asynchronous attach. A stored `deny` withdraws that server from the agent and releases the plugin-held preconnect reference; a missing entry or a changed fingerprint does the same unless the agent holds an Allow this session for that server. `admits()` accepts a session allowance only while no decision is stored for the current fingerprint, because a stored `deny` is the user's newest decision. An unreadable or invalid trust file withdraws every server, including session-allowed ones.

Decisions come from `ctx.userQuestions.ask` with one question per workspace path and undecided fingerprint set. The question lists every undecided server with its transport, its command and arguments or URL, and each referenced credential reported as `set` or `missing` through `ctx.credentials.describe`, which never returns a value. The options are Allow for this workspace (writes `allow`), Allow this session (held in memory for the asking agent only and lost when that agent is disposed or resumed, or the process restarts), and Deny (writes `deny`). Sessions with the same undecided set wait for the pending question; when the asker answers Allow this session or is disposed, or the question provider rejects with `ASK_ABORTED`, each waiting session asks its own question without a logged failure. A missing `userQuestions` service or a `NO_PROVIDER` rejection means the surface has no question UI; undecided servers are skipped and logged as `mcp-workspace(<name>): not approved; no question UI is available`. Headless, ACP, and API surfaces therefore load saved `allow` decisions only. An agent whose header has `origin: 'subagent'` attaches saved `allow` servers and never asks.

The trust file lives under `$DSH_HOME`, never in the workspace, so a project cannot approve its own servers. It is not a section of `settings.yaml` because a deployment may disable the settings row while still needing saved decisions. A trust-file read or write failure admits nothing for that operation and is logged; nothing defaults to allow.

### Credentials

`${NAME}` placeholders in `command`, `args`, `env`, `url`, and header values resolve through `ctx.credentials.resolve(credentialRef(NAME))` before every connection attempt, following the credential source order of process environment, `$DSH_HOME/.credentials.yaml`, the project `.env`, and `$DSH_HOME/.env`. An env value whose name matches `SENSITIVE_ENV_PATTERN` from `@deepseek-ai/dsh-subprocess`, and a header value whose name matches that pattern or is `Authorization`, `Proxy-Authorization`, or `Cookie`, must contain a placeholder; otherwise the server is refused and the log names the server and field without the value. A credential that is not set skips that server with `mcp-workspace(<name>): credential <NAME> is not set`, and no connection starts. Resolved values never enter questions or the trust file. Stdio children receive the scrubbed parent environment plus the resolved `env`, as `mcp-client` children do.

### Registration and agent eligibility

An agent receives a workspace server's tools when `ctx.agents.roots().includes(agent)` and its canonical cwd equals the connection's workspace path. That set contains top-level sessions and continuable subagent children and excludes one-shot in-process children, which are created through a parent agent context. An Allow this session decision applies only to the asking agent.

Attachment inside `agent/created` is synchronous: for every connection the binder offers for the agent's path that has published tools, that the path's `.mcp.json`, read through `readMcpJsonSync`, still declares, and whose stored decision, read for all such connections through one `lookupAllSync`, is still `allow`, the binder acquires a lease and attaches it to the agent context inside an `agent.ctx.effect` whose cleanup releases every lease that agent owns. A path without offered connections reads neither file. An offered connection the file no longer declares, including every one when the file is missing or cannot be read or parsed, is revoked. The agent's asynchronous pass reads `.mcp.json` again, logs a file that cannot be read or parsed and treats it as declaring nothing, and withdraws attachments and revokes offered connections for entries the file no longer declares. Connecting, asking, and credential resolution run after the listener returns and register their results on a later step. When a connection replaces its definition set after `tools/list_changed` or a reconnect, the pool's sink replaces the registrations on every attached agent; a registration failure on one agent leaves that agent without tools from that server and is logged. Before attaching, the binder checks `ctx.tools.get(name)` without a scope for a global tool of the same name, such as a profile-level `mcp-client` row with the same server name, and logs one warning per path and server; the agent-scoped tool shadows the global one as the registry specifies.

No session event is added. Tool definitions reach the model only through the request, and the agent loop already records the visible tool set in `request/header` with reason `initial`, `resume`, or `change`, per [reconstructable requests](2026-07-05-reconstructable-requests.md). Skipped and refused servers are reported to host logs only and never enter a prompt.

### Startup and first-step visibility

The agent loop announces `agent/created` synchronously inside `publish`, and the first `systemPrompt.assemble` runs only when the driver claims a prompt. Tools registered synchronously in the listener are therefore present in the first request, while tools registered after an asynchronous connect appear on a later step and produce a `request/header` `change`.

With `preconnect`, activation reads `.mcp.json` for `process.cwd()` and acquires one plugin-owned lease for every server with a saved `allow` whose credentials are set. `apply` awaits those leases' first connection attempts up to `preconnectTimeoutMs`; a slower connection continues in the background, and no preconnect failure fails activation. Through `ctx.inject(['workspaceRegistry'], …)`, activation also preconnects every workspace the registry lists, including a registry that mounts after activation, but starts those connections without awaiting them. Only the process cwd's servers are awaited, up to `preconnectTimeoutMs`, before the first step. A session whose cwd is a registered workspace sees preconnected tools from its first step once that connection has published them; an ACP client whose `session/new` cwd is neither the process cwd nor an already-connected registered workspace receives its servers through the agent's asynchronous admission, and they may first appear on a later step. Plugin-owned leases are held until the plugin is disposed or a recheck revokes them.

### Host readiness

A startup-time connection is useful only if the host answers its readiness request after the Loader tree settles. ACP `initialize` awaits `ctx.get('loader')?.await()` before negotiating, like sdk/server `initialize`, headless `run`, and the web-app ready announcement, so workspace servers with a stored `allow` for the process cwd are visible from the first step on ACP. A failed tree rejects `initialize`; a context without Loader answers at once.

The `acp-demo` and `jsonrpc-demo` app bins register their stdin EOF handler, and for `jsonrpc-demo` also `SIGTERM` and `SIGINT`, in `boot`'s `prepare` callback, before any tree entry mounts, so an exit event during startup is not missed; `acp-demo` registers EOF handling in snapshot modes only. The first event disposes the root at once, and the process exits only after `boot` resolves: with that event's code when the event interrupted startup, while a genuine startup failure rejects `boot` and exits non-zero with its diagnostic.

### Failure handling

A lost transport keeps the last definition set registered while calls fail, and reconnects under the configured policy. When the reconnect budget is exhausted, the sink clears every attached agent's registrations, and the next acquire of that key starts a fresh connection while keeping existing attachments. `.mcp.json` is read when a session attaches and at preconnect; the plugin does not watch it, so an edit takes effect for the next session in that workspace, and a changed fingerprint asks again. An agent's pass withdraws its own attachments for entries the file no longer declares, stops offering those connections to later agents, and releases the plugin-held preconnect leases on them, so each connection closes once no agent holds it. Plugin disposal releases every lease and closes all connections in parallel through the supervisor's bounded close.

## Alternatives considered

**One connection per session.** Each agent would start its own supervisor with no pool or sink split. Every session would miss its first step, pay a prompt-cache miss when tools arrive, and spawn one stdio child per session; headless tasks would always start without the tools.

**A workspace mode inside `dsh-mcp-client`.** One plugin would then hold two roles with different trust and lifetime rules: operator-named rows admitted by configuration, and workspace-discovered servers admitted by a user decision.

**Trust workspace files automatically.** This matches project skills and `AGENTS.md`, but those are prompt text. A stdio entry in a cloned repository would run an unsandboxed program as soon as a session opened there.

**Admit HTTP automatically and ask only for stdio.** An HTTP server runs no local code but still receives workspace data and credentials.

**Decisions only through a Settings page.** No in-session question, but every new workspace would require a separate visit to Settings before its servers work.

**Store decisions in `settings.yaml` or `storageDomain`.** A deployment can disable the settings row, and `storageDomain` is mounted only by the Web bundle, so headless runs would not see decisions made in the Web UI.

**Accept literal tokens in `.mcp.json`.** Existing files would work unchanged, but committed secrets would become a supported configuration.

**A `.dsh/mcp/` directory of YAML entries.** It would expose every `mcp-client` option, but Claude Code would not read it, and projects would maintain two server lists.

**Per-workspace `--patch` layers.** They work for one process per workspace, as in headless runs, but a Web process serving several workspaces applies every patch row to all sessions.

## Consequences

- A project's existing Claude Code `.mcp.json` works without conversion, and one Web process gives each workspace its own servers. Sessions in one workspace share one child process or HTTP connection per server, and the process cwd's saved servers are in the first request on every surface.
- First-step visibility relies on `agent/created` being announced before the first prompt assembly. A loop change that assembles earlier would move workspace tools to the second step without failing any unrelated test.
- Preconnect runs inside `apply`, and Cordis runs disposers only after `apply` returns. A shutdown requested during startup therefore waits up to `preconnectTimeoutMs` when an approved server never answers.
- Registered Web workspaces are preconnected without being awaited, so their tools are in the first request only when the connection published them before the session's agent was created.
- ACP `initialize` waits for the whole Loader tree, so an entry that never settles also stalls `initialize`.
- Stdio servers spawn outside the sandbox after approval; the decision authorizes an unsandboxed program.
- An approved server whose credential is missing or whose endpoint is unreachable is visible in host logs only; no user interface shows a notice.
- Decisions are keyed by canonical path, so the same checkout mounted at different paths, such as Web at `/workspaces/<name>` and a container run at `/workspace`, needs separate decisions.
- The recheck runs only when a server attaches, so a running agent keeps a server's tools after its decision is deleted or changed to `deny` until the agent is disposed.
- A `deny` recorded while an agent holding Allow this session is still connecting that server withdraws the server before it attaches; an agent that already attached it keeps its tools until disposed, like any running agent.
- Running agents keep the tools of an entry removed from or changed in `.mcp.json`, and its connection stays open until they are disposed.
- An agent created while `.mcp.json` is missing or cannot be parsed, such as in the middle of an edit, revokes every offered connection of that workspace, so those connections close unless another agent holds them; a later agent's admission connects them again without a preconnect reference.
- Agent-scoped tools shadow global tools of the same name, so a deployment that keeps a profile-level row for the same server opens two connections and relies on the logged warning.
- In the ACP snapshot scenarios the trust file lives inside the generated workspace, because the snapshot harness sets `DSH_HOME` there; a real deployment keeps it in `$DSH_HOME` outside every workspace.
- The `workspace-mcp-unapproved` stderr assertion has no completion signal for the asynchronous admission pass: the harness closes stdin after `prompt` resolves, and the assertion relies on the skip warning having been written before that.

## Testing

- **Unit:** `packages/mcp/mcp-client/tests/connection-options.spec.ts` covers `fetchToolDefinitions`, `createRegistrySink` rollback, custom sinks, per-attempt `resolveConfig`, disposal during `resolveConfig`, and `stopped()`; the existing `mcp-client.spec.ts` covers the plugin path. In `packages/mcp/mcp-workspace/tests`, `mcp-json.spec.ts` covers parsing, refusals, placeholders, fingerprints, and both reads; `trust-store.spec.ts` covers round-trips, mode `0600`, invalid documents, concurrent records, and `lookupAllSync`; `pool.spec.ts` covers sharing, attach and detach, credentials, reconnect exhaustion, and disposal; `binder.spec.ts` covers first-step visibility, eligibility, decisions and shared questions, failures, the stored-decision recheck, and disposal; `invariant.spec.ts` covers the invariant companion.
- **First-step visibility:** `binder.spec.ts` "lists a preconnected server tool in the initial request header of an agent created afterwards" asserts a `request/header` of reason `initial` that lists the fixture tool.
- **Dispose before ready:** `pool.spec.ts` "dispose settles during a connection first attempt" and "dispose settles after the child started and before the first attempt settles", and `plugin.spec.ts` "settles fiber disposal requested while activation awaits a connecting server" and "…a silent server within preconnectTimeoutMs".
- **Composition:** `composition.spec.ts` boots `tests/fixtures/composition.cordis.yml` through the Loader and asserts that a saved-`allow` server tool is in the first request and its call result is logged.
- **End to end:** `mcp-workspace.e2e.ts` shows two root sessions sharing one stdio child, a `${MCP_FIXTURE_TOKEN}` placeholder resolved from `$DSH_HOME/.env` into the child environment, and the child exiting after both sessions are disposed.
- **ACP readiness:** `packages/acp/acp/tests/bridge.spec.ts` "answers initialize only after the Loader tree settles" and "rejects initialize when the Loader tree fails to settle".
- **ACP snapshots:** `examples/acp-agent` scenario `workspace-mcp` seeds a saved `allow` for a generated `.mcp.json` that names `tests/fixtures/mcp-echo-server.mjs` and pins the request header and tool schemas with `mcp__fixture__echo` in the first step. Scenario `workspace-mcp-unapproved` has no decision; its request header equals the default class pin, and `acp.snapshot.ts` asserts the stderr line `mcp-workspace(fixture): not approved; no question UI is available`. The snapshot-only `tests/fixtures/stderr-log-exporter.ts` row delivers that line, because Cordis exporters without `levels` drop `warn`.
- **Web snapshot:** `apps/web/tests/workspace-mcp-approval.e2e.ts` asserts that the question composer shows the server line with `credentials: MCP_FIXTURE_TOKEN missing` and pins it in `snapshots/workspace-mcp-approval/ui.expected.md`; it then sets the credential, selects Allow for this workspace and submits, asserts that `mcp-trust.yaml` records `allow` at mode `0600`, and asserts that the next step calls `mcp__fixture__echo` and renders its tool row.
