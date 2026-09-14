# Agent Note: Workspace-declared MCP servers behind a project-trust gate

Status: proposed

English | [中文](2026-09-14-workspace-mcp-servers.zh.md)

## Problem

MCP servers reach a Harness process only as `@deepseek-ai/dsh-mcp-client` rows in a profile or `--patch` layer. Every row is process-global: its tools register on the global `ctx.tools` layer and reach every session in every workspace. A Web deployment that serves several workspaces from one process therefore cannot give one workspace its own servers, and a project that already ships a Claude Code `.mcp.json` must be hand-converted into Cordis rows before the Harness can use it.

Loading a workspace's own server list without a gate is not acceptable. A stdio MCP server is an executable spawned by the MCP SDK outside the agent sandbox, and an HTTP server receives workspace data and bearer credentials. The [configuration source ownership decision](../../implemented/architecture/2026-08-04-configuration-source-ownership.md) trusts the launch project for routing and credentials without a prompt and names "a later project-trust gate" as the place where discovered project configuration that runs code gets addressed. No such gate exists: project skills, `AGENTS.md`, and project `.env` values all load unconditionally, and no current plugin runs a program named by a workspace file.

## Proposal

Add `@deepseek-ai/dsh-mcp-workspace`, a plugin mounted in the base bundle, that reads `<canonical session cwd>/.mcp.json`, admits each declared server only through a user decision stored outside the workspace, shares one supervised connection per workspace server across the sessions that use it, and registers the discovered tools on each eligible agent's own tool layer.

### Changes to `@deepseek-ai/dsh-mcp-client`

The supervisor in `connection.ts` becomes reusable without mounting the plugin. `startConnection` accepts an options object with two members:

```ts
interface ToolSink {
  replace(definitions: ReadonlyMap<string, ToolDefinition>, failure: 'contain' | 'throw'): void
  clear(): void
}

interface ConnectionOptions {
  sink?: ToolSink
  resolveConfig?: () => Promise<Config>
}
```

`syncTools` splits into `fetchToolDefinitions`, which drains `tools/list` and builds definitions without touching a registry, and a default registry sink that performs today's dispose-then-register swap with rollback. The plugin's `apply` passes neither option and keeps its current behavior. `resolveConfig` runs before every connection attempt, so a caller that resolves credential placeholders sees rotated values on reconnect. A definition built once serves every agent: image admission reads `attachments` and `llm` through `ctx.get` and the calling route through `exec.agent` at execution time, and `ctx.tools.register` stores the definition without mutating it. `index.ts` exports `startConnection`, `resolveReconnectPolicy`, `fetchToolDefinitions`, `publicToolName`, `ToolSink`, and `ConnectionOptions`; the build entry list does not change.

### Package `@deepseek-ai/dsh-mcp-workspace`

| Module | Responsibility |
|---|---|
| `mcp-json.ts` | Parse `.mcp.json` `mcpServers` into stdio (`command`, `args`, `env`) or HTTP (`type: "http"`, `url`, `headers`) entries; refuse invalid server names, `sse`, `${NAME:-default}`, and literal secrets; compute each entry's SHA-256 fingerprint over its canonical JSON before substitution |
| `trust-store.ts` | Read and write `mcp-trust.yaml`: canonical workspace path → server name → `{ decision: allow \| deny, fingerprint, decidedAt }`, written under `withFileLock` with `writeFileAtomic` at mode `0600` |
| `pool.ts` | One entry per canonical workspace path holding one supervised connection per admitted server, its current definition set, and its attached agents; a reference count closes the connection after the last release |
| `binder.ts` | The `agent/created` listener: attach eligible agents synchronously, start asynchronous connects and questions, and release on agent disposal |
| `index.ts` | Plugin wiring, `Config`, and preconnect at activation |
| `invariant.ts` | Pool data relation checked by the package invariant companion |

`Config` fields: `trustFile` (the base bundle row sets `!!js dshHomePath('mcp-trust.yaml')`), `preconnect` (default `true`), `preconnectTimeoutMs` (default `10000`), `toolCallTimeoutMs` (default `60000`), and `reconnect` (the `mcp-client` reconnect policy). The file name `.mcp.json` is an external format and stays fixed.

### Workspace identity

The workspace key is `realpath(session.header.cwd)`. The session header carries no workspace id, `dsh-workspace` is mounted only by the Web bundle, and a raw Web `payload.cwd` is not canonicalized by the host. The key is the canonical cwd itself, not the nearest `.git` ancestor, matching Claude Code's project `.mcp.json` and the Web workspace path.

### Trust decisions

Each server's decision is looked up by canonical path, server name, and fingerprint. A matching `allow` connects; a matching `deny` skips without asking; a missing entry or a changed fingerprint needs a decision. The fingerprint excludes resolved credential values, so rotating a token does not re-ask, while changing a command, argument, URL, or header template does. Every attachment rechecks the stored decision, including the synchronous attachment of a preconnected server; a `deny`, a changed fingerprint, a missing entry without a session allowance, or an unreadable trust file withdraws that server from the agent and releases the plugin-held reference.

Decisions come from `ctx.userQuestions.ask` with one question per workspace that lists every undecided server with its transport, its command and arguments or URL, and each required credential reported as set or missing through `ctx.credentials.describe`, which never returns a value. The options are Allow for this workspace (writes `allow`), Allow this session (held in memory for that agent only and lost on resume or restart), and Deny (writes `deny`). One pending question exists per workspace path and fingerprint set; other sessions in that workspace wait for its result. Disposing the asking agent aborts the question, and the next session asks again. `NO_PROVIDER` means the surface has no question UI; undecided servers are skipped and logged. Headless, ACP, and API surfaces therefore load saved `allow` decisions only.

The trust file lives under `$DSH_HOME`, never in the workspace, so a project cannot approve its own servers. It is not a section of `settings.yaml` because a deployment may disable the settings row while still needing saved decisions. A trust-file read or write failure admits nothing for that operation and is logged; nothing defaults to allow.

### Credentials

`${NAME}` placeholders in `command`, `args`, `env`, `url`, and header values resolve through `ctx.credentials.resolve(credentialRef(NAME))` inside `resolveConfig` before every connection attempt, following the credential source order of process environment, `$DSH_HOME/.credentials.yaml`, the project `.env`, and `$DSH_HOME/.env`. An env value whose name matches `SENSITIVE_ENV_PATTERN` from `@deepseek-ai/dsh-subprocess`, and a header value whose name matches that pattern or is `Authorization`, `Proxy-Authorization`, or `Cookie`, must contain a placeholder; otherwise the server is refused and the log names the server and field without the value. A missing credential skips that server with a log line naming the reference. Resolved values never enter logs, questions, or the trust file. Stdio children receive the scrubbed parent environment plus the resolved `env`, as `mcp-client` children do today.

### Registration and agent eligibility

An agent receives a workspace server's tools when `ctx.agents.roots().includes(agent)` and its canonical cwd equals the pool entry's path. That set contains top-level sessions and continuable subagent children and excludes one-shot in-process children, which are created through a parent agent context. Only an agent whose header has no `origin: 'subagent'` is asked for a decision. An Allow this session decision applies only to the asking agent.

Attachment inside `agent/created` is synchronous: for every server with a current definition set, the binder calls `agent.ctx.tools.register` for each definition inside `agent.ctx.effect`, whose cleanup also releases the pool reference. Connecting, asking, and credential resolution run after the listener returns and register their results on a later step. When a connection replaces its definition set after `tools/list_changed` or a reconnect, the pool's sink replaces the registrations on every attached agent; a failure on one agent leaves that agent without tools from that server and is logged. Before registering, the binder checks `ctx.tools.get(name)` without a scope for a global tool of the same name, such as a profile-level `mcp-client` row with the same server name, and logs one warning per path and server; the agent-scoped tool shadows the global one as the registry specifies.

No session event is added. Tool definitions reach the model only through the request, and the agent loop already records the visible tool set in `request/header` with reason `initial`, `resume`, or `change`, per [reconstructable requests](../../implemented/architecture/2026-07-05-reconstructable-requests.md). Skipped and refused servers are reported to host logs only and never enter a prompt.

### Startup and first-step visibility

The agent loop announces `agent/created` synchronously inside `publish`, and the first `systemPrompt.assemble` runs only when the driver claims a prompt. Tools registered synchronously in the listener are therefore present in the first request, while tools registered after an asynchronous connect appear on a later step and produce a `request/header` `change`. With `preconnect`, activation connects every server that has a saved `allow` for `process.cwd()` and, through `ctx.inject(['workspaceRegistry'], …)`, for each registered Web workspace, holding one plugin-owned reference per entry for the plugin lifetime. Activation awaits those connections up to `preconnectTimeoutMs`; a slower connection continues in the background, and no preconnect failure fails activation. Preconnected servers are therefore visible from the first step on every surface, and only a server admitted during a session joins later.

The first binder test must show a `request/header` with reason `initial` that lists `mcp__fixture__*` for an agent created after preconnect. If that ordering does not hold, this proposal degrades to one connection per session, and this note must be revised before implementation continues.

### Failure handling

A lost transport keeps the last definition set registered while calls fail, and reconnects under the configured policy. When the reconnect budget is exhausted, the sink clears every attached agent's registrations, and the next attaching session starts one fresh connection. `.mcp.json` is read when a session attaches and at preconnect; the plugin does not watch it, so an edit takes effect for the next session in that workspace, and a changed fingerprint asks again while the previous connection stays until its last reference is released. Plugin disposal closes all connections in parallel through the supervisor's bounded close.

### Coverage and documentation

Unit tests hold the per-file coverage gate for the new package and the changed `mcp-client` modules. A keyless end-to-end test uses the existing stdio `fixture-server.ts` to show two agents in one workspace sharing one child process that exits after the last release, and a `${TOKEN}` reaching the child environment. `examples/acp-agent` gains a scenario whose committed `workspace/.mcp.json` names the fixture server with a `prepareWorkspace`-seeded `allow` that shows the tool in the first step, and a scenario without a decision whose tool schema omits it. `apps/web/tests/snapshots` gains a scenario in which the question lists the server with its credential status, Allow for this workspace writes the trust file, and the tool is called on the next step. Documentation updates the new package README, a library section in the `mcp-client` README, the CLI reference statement that no MCP server is enabled by default, and the base bundle README, each with its Chinese counterpart.

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

## Acceptance criteria

- A Web session in a workspace with an undecided `.mcp.json` server shows one question listing the server and its credential status; Allow for this workspace writes `mcp-trust.yaml` and the server's tools are callable on the next step.
- An agent created after preconnect in a workspace with a saved `allow` has the server's tools in its `initial` `request/header`.
- Two root agents in one workspace share one stdio child process, which exits after both are disposed.
- One-shot in-process children receive no workspace tools; continuable children in the same workspace do.
- Headless and ACP sessions load saved `allow` decisions and skip undecided servers with a log line, without asking.
- A literal secret in a sensitive env or header field refuses that server, and a changed fingerprint asks again.
- The global `mcp-client` plugin behaves as before; its existing tests pass unchanged.
- `pnpm run test:coverage` scoped to both packages, `typecheck`, `lint`, `duplication`, `hygiene`, `doc-sync`, and the new snapshot scenarios pass.

## Risks

- The first-step visibility relies on `agent/created` being announced before the first prompt assembly. A future loop change that assembles earlier would silently move workspace tools to the second step.
- Stdio servers still spawn outside the sandbox after approval; the decision authorizes an unsandboxed program.
- An approved server whose credential is missing or whose endpoint is unreachable is visible in host logs only; the Web UI has no notice for it.
- Decisions are keyed by canonical path, so the same checkout mounted at different paths, such as Web at `/workspaces/<name>` and a container run at `/workspace`, needs separate decisions.
- Agent-scoped tools shadow global tools of the same name, so a deployment that keeps a profile-level row for the same server opens two connections and relies on the logged warning.
