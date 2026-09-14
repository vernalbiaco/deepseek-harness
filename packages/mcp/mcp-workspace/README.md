# @deepseek-ai/dsh-mcp-workspace

English | [中文](README.zh.md)

Workspace-declared MCP servers: reads `.mcp.json` from each session's canonical cwd, connects a declared server only after a user decision, stored for the workspace in `$DSH_HOME/mcp-trust.yaml` or given for one session, shares one supervised connection per workspace server across the sessions that use it, and registers that server's tools on each eligible agent's own tool layer under the [`dsh-mcp-client`](../mcp-client/README.md) names `mcp__<serverName>__<rawName>`.

## Usage

The [base bundle](../../bundle/base/README.md) mounts one row, so every `dsh` profile reads workspace `.mcp.json` files:

```yaml
- id: mcp-workspace
  name: '@deepseek-ai/dsh-mcp-workspace'
  config:
    trustFile: !!js dshHomePath('mcp-trust.yaml')
```

A workspace declares servers in the Claude Code `.mcp.json` format. Secrets are `${NAME}` credential references, never literal values:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" }
    }
  }
}
```

## Config

| Field | Required | Description |
|---|---|---|
| `trustFile` | yes | Absolute path of the trust document holding per-workspace decisions; it must not be inside a workspace |
| `preconnect` | no | Connect servers with a saved `allow` for the process cwd and every registered Web workspace at activation (default `true`) |
| `preconnectTimeoutMs` | no | Longest time activation waits for preconnected servers' first connection attempts, in milliseconds (default 10000) |
| `toolCallTimeoutMs` | no | Timeout per tool call for every workspace server, in milliseconds (default 60000) |
| `reconnect.enabled` | no | Reconnect automatically after a lost connection (default `true`) |
| `reconnect.initialDelayMs` | no | First reconnect delay in milliseconds; doubles per consecutive failed attempt (default 500) |
| `reconnect.maxDelayMs` | no | Backoff ceiling in milliseconds; also the uptime after which the attempt budget resets (default 30000) |
| `reconnect.maxAttempts` | no | Consecutive failed attempts per outage before the connection stops (default 10) |

An invalid `reconnect` policy fails the plugin at load. The file name `.mcp.json` is fixed.

## `.mcp.json` support

The file must be a JSON object with an `mcpServers` object; otherwise the whole file is logged as unusable and no server from it is admitted. Each entry is parsed independently, and a refused entry is logged with its server name and reason, never a field value.

| Entry | Support |
|---|---|
| stdio: `command`, optional `args` and `env`, `type` absent or `"stdio"` | Supported; the child runs with the canonical workspace path as its cwd, the scrubbed parent environment, and the resolved `env` |
| HTTP: `type: "http"`, `url`, optional `headers` | Supported over Streamable HTTP |
| `type: "sse"` | Refused |
| Server name outside `[A-Za-z0-9_-]{1,32}`, a non-string `command` or `url`, `args` that is not a string array, or `env`/`headers` that are not string maps | Refused |

- **Placeholders** — `${NAME}`, with `NAME` matching `[A-Za-z_][A-Za-z0-9_]*`, may appear in `command`, `args`, `env` values, `url`, and header values. Any other `${` sequence, including `${NAME:-default}`, refuses the server.
- **Sensitive fields** — an `env` value whose name matches `KEY`, `PASSWORD`, `SECRET`, or `TOKEN` (case-insensitive), and a header value whose name matches that pattern or is `Authorization`, `Proxy-Authorization`, or `Cookie`, must contain a placeholder; a literal value refuses the server.
- **Fingerprint** — each entry's fingerprint is `sha256:<hex>` over its JSON with object keys sorted, computed before substitution and including keys this parser ignores. Changing a command, argument, URL, env or header template, or any other key changes the fingerprint; rotating a credential value does not.

## Trust decisions

Every declared server is admitted by the decision stored for its canonical workspace path, server name, and current fingerprint. A matching `allow` connects the server, a matching `deny` skips it without asking, and a missing entry or an entry for another fingerprint needs a decision.

An eligible agent that is not a subagent child asks one question listing every undecided server with its transport, its command and arguments or URL, and each referenced credential as `set` or `missing`. One question is pending per workspace path and undecided fingerprint set; sessions with the same undecided set wait for its answer. If the asking agent answers Allow this session or is disposed, each waiting session asks its own question.

| Option | Effect |
|---|---|
| Allow for this workspace | Records `allow` for every listed server and connects them |
| Allow this session | Connects the listed servers for the asking agent only; records nothing, and the allowance ends when that agent is disposed, resumed, or the process restarts |
| Deny | Records `deny` for every listed server |

Disposing the asking agent aborts the question, and the next session in that workspace asks again. When no question UI is available, undecided servers are skipped and logged as `mcp-workspace(<name>): not approved; no question UI is available`.

Every attachment of a server to an agent rechecks the stored decision: when an agent is created, once more after that agent's `.mcp.json` read, and immediately before an asynchronous attach. A stored `deny`, a missing entry without an Allow this session, a stored entry whose fingerprint no longer matches the `.mcp.json` entry, or an unreadable trust file withdraws the server from that agent and releases the plugin-held preconnect reference. Removing or changing the entry in `.mcp.json` withdraws the server from each agent that reads the file afterwards, but the plugin-held preconnect reference and its connection stay until the plugin is disposed. An unreadable or invalid trust file admits nothing, including servers allowed for this session.

### Trust file

The base bundle stores decisions in `$DSH_HOME/mcp-trust.yaml`, never in a workspace, so a project cannot approve its own servers. Writes take a cross-process file lock and replace the file atomically at mode `0600`:

```yaml
version: 1
workspaces:
  /home/user/projects/app:
    github:
      decision: allow
      fingerprint: sha256:3f1c…
      decidedAt: '2026-09-14T08:00:00.000Z'
```

To revoke a decision, delete that server's entry, or the workspace's entry for all of its servers; the next session in that workspace asks again where a question UI exists. Setting `decision: deny` skips the server without asking.

## Credentials

`${NAME}` placeholders resolve through `ctx.credentials`, so the [`dsh-credentials-local`](../../credentials/credentials-local/README.md) source order applies: inherited environment, `$DSH_HOME/.credentials.yaml`, the invoking directory's `.env`, then `$DSH_HOME/.env`. A server whose referenced credential is not set is skipped with the log line `mcp-workspace(<name>): credential <NAME> is not set`, and no connection starts. Resolution runs again before every connection attempt, so a reconnect uses rotated values. Resolved values never enter logs, questions, or the trust file.

## Sessions and surfaces

An agent receives a workspace server's tools when it is a root agent (`ctx.agents.roots()`, which includes top-level sessions and continuable subagent children) and its canonical cwd equals the workspace path. One-shot in-process subagent children receive none. A subagent-origin root attaches saved `allow` servers but never asks.

| Surface | Undecided servers |
|---|---|
| Web | The session shows the decision question |
| Headless, ACP, API | Skipped and logged; only saved `allow` decisions connect |

## Connections

One supervised connection exists per canonical workspace path, server name, and fingerprint; every agent using that server holds a reference, and releasing the last reference closes the connection. With `preconnect`, activation connects every server with a saved `allow` whose credentials are set for `process.cwd()` and for each workspace in `ctx.workspaceRegistry`, and holds one plugin-owned reference per server until the plugin is disposed or a recheck revokes it. Activation waits for those first attempts up to `preconnectTimeoutMs`; a slower connection continues in the background, and no preconnect failure fails activation.

An agent created after its workspace's servers published tools receives them before its first model request. A server admitted during a session, or whose connection completes after the agent was created, registers its tools on a later step. A lost transport keeps the last tool set registered while calls fail and reconnects under the `reconnect` policy; when the attempt budget is exhausted, the tools are removed from every attached agent, and the next session that attaches starts a new connection. Before registering, a warning is logged once per workspace and server when a global tool has the same name.

## Services consumed

| Service | Usage |
|---|---|
| `ctx.agents` | Observe `agent/created` and read the root agent set |
| `ctx.tools` | Register tools on each eligible agent's tool layer and detect same-named global tools |
| `ctx.credentials` | Resolve `${NAME}` references and report whether each is set |
| `ctx.userQuestions` | Optionally ask for decisions about undecided servers |
| `ctx.workspaceRegistry` | Optionally list Web workspaces to preconnect |

## Model Experience

### Workspace MCP tools

#### What the model sees

An eligible agent sees each tool of every admitted server of its workspace as a native tool named `mcp__<serverName>__<rawName>` (or its deterministic normalized form), with the server-provided description and input schema. Tools of a server connected before the agent was created are in the first request; tools of a server admitted or connected later appear on a later step with a `request/header` of reason `change`. A re-sync replaces the server's tools; a withdrawn decision at the next attachment, an exhausted reconnect budget, or agent or plugin disposal removes them. Questions, skipped servers, and refusals never reach the model.

#### Token effect

Data-dependent schema cost is paid on every request while the tools are registered. Re-sync replaces rather than accumulates schemas, and the server-qualified name adds tokens to every tool definition and call.

#### KV Cache effect

Prefix-stable while the agent's workspace tool set and schemas are unchanged. A server that joins or leaves during a session, or a re-sync that adds, removes, renames, or changes a tool, replaces tool definitions and may invalidate reuse from the first changed schema token; a reconnect that recovers an unchanged list reproduces identical definitions and stays prefix-stable.

### Tool-call history and results

#### What the model sees

Calls and results render exactly as for [`dsh-mcp-client`](../mcp-client/README.md#tool-call-history-and-results) tools, because this package registers the tool definitions `dsh-mcp-client` builds.

#### Token effect

The same as `dsh-mcp-client` tool calls: arguments, mapped text, and durable image references are retained until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **A revoked decision does not reach running agents** — the recheck runs when a server attaches to an agent, so an agent created before a decision was deleted or changed to `deny` keeps that server's tools until it is disposed.
- **Decisions are keyed by canonical path** — the same checkout mounted at two paths, such as a Web workspace and a container mount, needs a separate decision for each path.
- **`.mcp.json` is not watched** — an edit takes effect for the next session in that workspace, and a changed fingerprint asks again. A preconnected connection for a removed or changed entry stays open until the plugin is disposed, because only a stored-decision recheck of that same entry releases the plugin-held preconnect reference.
- **Approved stdio servers run outside the sandbox** — the decision authorizes an unsandboxed program with the scrubbed parent environment.
- **`sse` is unsupported** — an entry with `type: "sse"` is refused; only stdio and Streamable HTTP servers connect.
- **Broken approved servers are reported in host logs only** — a missing credential or an unreachable server produces a log line and no notice in any user interface.
- **Agent-scoped tools shadow a same-named global row** — a profile that also mounts a `dsh-mcp-client` row with the same server name opens two connections, and the agent calls the workspace server's tools.
