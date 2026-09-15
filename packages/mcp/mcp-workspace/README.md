---
description: "Workspace .mcp.json servers for deployments and maintainers approving, mounting, or debugging per-workspace MCP servers that each eligible agent connects through its own dsh-mcp-client instances."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-workspace

English | [中文](README.zh.md)

## Summary

`dsh-mcp-workspace` lets a workspace declare MCP servers in a Claude Code `.mcp.json` file. A declared server connects only after a user decision, stored for the workspace in `$DSH_HOME/mcp-trust.yaml` or given for one session. Each eligible agent mounts its own [`dsh-mcp-client`](../mcp-client/README.md) instance per admitted server, so the server's tools, resources, and instructions belong to that agent and stop with it. Saved decisions mount before the agent's first model request; servers decided during a session appear on a later step. Headless, ACP, and API surfaces load saved `allow` decisions only.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The [base bundle](../../bundle/base/README.md) mounts this plugin, so every `dsh` profile reads workspace `.mcp.json` files. Add your own row only for a composition without the base bundle.

### Minimal configuration

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

| Field | Default | Meaning |
|---|---|---|
| `trustFile` | required | Absolute path of the trust document holding per-workspace decisions; it must not be inside a workspace |
| `admissionTimeoutMs` | `10,000` | Longest time agent creation waits for saved `allow` servers' first connection attempts, at most 2147483647 |
| `toolCallTimeoutMs` | `60,000` | Timeout per tool call or resource request for every workspace server, at most 2147483647 |
| `reconnect.enabled` | `true` | Reconnect automatically after a lost connection |
| `reconnect.initialDelayMs` | `500` | First reconnect delay; doubles per consecutive failed attempt |
| `reconnect.maxDelayMs` | `30,000` | Backoff ceiling; also the uptime after which the attempt budget resets |
| `reconnect.maxAttempts` | `10` | Consecutive failed attempts per outage before the connection stops |

The `reconnect` defaults and bounds are those of `dsh-mcp-client`; a policy outside them fails the plugin at load. The file name `.mcp.json` is fixed. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-workspace) lists every accepted field.

### `.mcp.json` support

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

### Trust decisions

Every declared server is admitted by the decision stored for its canonical workspace path, server name, and current fingerprint. A matching `allow` mounts the server, a matching `deny` skips it without asking, and a missing entry or an entry for another fingerprint needs a decision.

An eligible agent that is not a subagent-origin root asks one question listing every undecided server with its transport, its command and arguments or URL, each JSON-quoted when it is empty or contains whitespace, a double quote, or a control character, and each referenced credential as `set` or `missing`. One question is pending per workspace path and set of undecided server names and fingerprints; sessions with the same undecided set wait for its answer. If the asking agent answers Allow this session or is disposed, or the question UI aborts the question, each waiting session asks its own question.

| Option | Effect |
|---|---|
| Allow for this workspace | Records `allow` for every listed server and mounts them on every waiting agent |
| Allow this session | Mounts the listed servers on the asking agent only; records nothing, and the allowance ends when that agent is disposed, resumed, or the process restarts |
| Deny | Records `deny` for every listed server |

When no question UI is available, undecided servers are skipped and logged as `mcp-workspace(<name>): not approved; no question UI is available`. The stored decision is read again immediately before each mount: a stored `deny`, even for an agent holding Allow this session, or an unreadable trust file mounts nothing. An unreadable or invalid trust file admits nothing, including servers allowed for this session.

### Trust file

The base bundle stores decisions in `$DSH_HOME/mcp-trust.yaml`, never in a workspace, so a project cannot approve its own servers. Writes take a cross-process file lock and replace the file atomically at mode `0600`:

```yaml
version: 1
workspaces:
  /home/user/projects/app:
    github:
      decision: allow
      fingerprint: sha256:3f1c…
      decidedAt: '2026-09-15T08:00:00.000Z'
```

To revoke a decision, delete that server's entry, or the workspace's entry for all of its servers; the next session in that workspace asks again where a question UI exists. Setting `decision: deny` skips the server without asking.

### Credentials

`${NAME}` placeholders resolve through `ctx.credentials` when a server mounts, so the [`dsh-credentials-local`](../../credentials/credentials-local/README.md) source order applies: inherited environment, `$DSH_HOME/.credentials.yaml`, the invoking directory's `.env`, then `$DSH_HOME/.env`. A server whose referenced credential is not set is skipped with the log line `mcp-workspace(<name>): credential <NAME> is not set`, and nothing is mounted. Resolved values never enter questions or the trust file, and this package's own log lines replace them with their `${NAME}` placeholder.

### Sessions and surfaces

An agent is eligible when it is a root agent (`ctx.agents.roots()`, agents created without a live parent agent) and its session header has a cwd. Its canonical cwd is the workspace path. Children created with a parent agent receive no servers of their own. A subagent-origin root mounts saved `allow` servers but never asks.

| Surface | Undecided servers |
|---|---|
| Web | The session shows the decision question |
| Headless, ACP, API | Skipped and logged; only saved `allow` decisions mount |

### Startup, mounting, and disposal

`agent/created` is a serial event that agent creation awaits before the agent's first step. The plugin's listener reads `.mcp.json`, looks up every stored decision, and mounts each saved `allow` server, waiting for their first connection attempts up to `admissionTimeoutMs`; a slower server keeps connecting and its tools appear on a later step with a `request/header` of reason `change`. A workspace server never fails agent creation. Questions about undecided servers run after the listener returns.

Each mount is one `dsh-mcp-client` instance on the agent's context with `serverName` set to the `.mcp.json` name, `failOnStartupError: false`, and the configured timeout and reconnect policy. The agent therefore owns one stdio child or HTTP connection per admitted server; disposing the agent stops them, and disposing this plugin unmounts every server it mounted. A server name already mounted on the same agent, such as an ACP `mcpServers` entry with that name, fails the workspace mount, which is logged as `mcp-workspace(<name>): failed to mount: …`. When an agent's admission pass settles, including when nothing was admitted, the plugin emits the in-memory event `mcp-workspace/binding-settled` with `{ agent }`; it never reaches the model or the session log.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **The agent owns its servers.** A workspace server is a child plugin of the agent's context, so its tools, resources, instructions, and transport share the agent's scope and lifetime without a separate reference count.
- **The decision lives outside the workspace.** Only a user answer writes the trust file, and every mount rereads it, so neither a project nor a stale in-memory answer can admit a server.
- **Nothing blocks on a person during creation.** Saved decisions are applied inside `agent/created`; questions wait for an answer only after the agent is published.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, reconnect validation, `agent/created` wiring, `binding-settled` event declaration |
| [`src/binder.ts`](src/binder.ts) | Per-agent admission: `.mcp.json` read, decision lookups, shared questions, credential resolution, `mcp-client` mounts |
| [`src/mcp-json.ts`](src/mcp-json.ts) | `.mcp.json` parsing, refusal rules, fingerprints, placeholder substitution |
| [`src/trust-store.ts`](src/trust-store.ts) | `mcp-trust.yaml` reads and locked atomic writes |
| [`src/types.ts`](src/types.ts) | Parsed entry and declared-server types |
| — | No runtime invariant companion is published: every mounted server is a child plugin of its agent's context, so no workspace-to-agent relation exists outside the Cordis fiber tree to observe independently. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace MCP servers Agent Note](../../../.agents/notes/implemented/architecture/2026-09-15-workspace-mcp-servers-per-agent.md) — the per-agent mounting decision and the alternatives considered.
- [`dsh-mcp-client` README](../mcp-client/README.md) — tool naming, reconnection, resources, and server instructions of every mounted server.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-workspace) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Workspace MCP tools

#### What the model sees

An eligible agent sees each tool of every server mounted on it as a native tool named `mcp__<serverName>__<rawName>` (or its deterministic normalized form), with the server-provided description and input schema. Tools of saved `allow` servers that connected within `admissionTimeoutMs` are in the first request; tools of a server admitted or connected later appear on a later step with a `request/header` of reason `change`. Questions, skipped servers, and refusals never reach the model.

#### Token effect

Data-dependent schema cost is paid on every request while the tools are registered. Re-sync replaces rather than accumulates schemas, and the server-qualified name adds tokens to every tool definition and call.

#### KV Cache effect

Prefix-stable while the agent's workspace tool set and schemas are unchanged. A server that joins during a session, or a re-sync that adds, removes, renames, or changes a tool, replaces tool definitions and may invalidate reuse from the first changed schema token.

### Tool-call history, results, and server instructions

#### What the model sees

Calls, results, and server instructions render exactly as for [`dsh-mcp-client`](../mcp-client/README.md#model-experience) servers, because each workspace server is a `dsh-mcp-client` instance scoped to the agent.

#### Token effect

The same as `dsh-mcp-client`: arguments, mapped text, and durable image references are retained until compaction, and server instructions add prompt text on every request.

#### KV Cache effect

Tool calls and results are append-only. Server instructions that change on a reconnect change the next assembled system message and its reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One connection per agent per server** — every eligible session in a workspace starts its own stdio child or HTTP connection for each admitted server, so N sessions run N copies of a stdio server.
- **Credentials are resolved once per mount** — a rotated credential reaches a server only in an agent created after the rotation; a reconnect reuses the values resolved at mount.
- **`dsh-mcp-client` failure logs are not redacted** — connection and re-sync failure lines logged by `dsh-mcp-client` include the error text, which can contain a resolved credential value substituted into a URL, argument, or header; only this package's own log lines replace resolved values.
- **A revoked decision does not reach running agents** — the decision is read before each mount, so an agent that already mounted a server keeps it until the agent is disposed.
- **Decisions are keyed by canonical path** — the same checkout mounted at two paths, such as a Web workspace and a container mount, needs a separate decision for each path.
- **`.mcp.json` is not watched** — an edit takes effect when the next agent in that workspace is created, and a changed fingerprint asks again; running agents keep the servers they mounted.
- **Approved stdio servers run outside the sandbox** — the decision authorizes an unsandboxed program with the scrubbed parent environment.
- **`sse` is unsupported** — an entry with `type: "sse"` is refused; only stdio and Streamable HTTP servers connect.
- **Broken approved servers are reported in host logs only** — a missing credential or an unreachable server produces a log line and no notice in any user interface.
- **Agent-scoped tools shadow a same-named global row** — a profile that also mounts a `dsh-mcp-client` row with the same server name opens two connections, and the agent calls the workspace server's tools.
- **An approval covers the `.mcp.json` entry, not what the entry runs** — the fingerprint covers the entry's text only, so a changed workspace script such as `./mcp/server.js`, a changed `package.json` script, or a new package version that `npx -y` resolves runs under the existing approval without a new question.
- **Agent creation can wait for a slow saved server** — a saved `allow` server that never answers delays each new agent in that workspace by up to `admissionTimeoutMs`.
- **A question can repeat right after Allow for this workspace** — a session that looked up its stored decisions just before another session's Allow for this workspace was recorded asks the same question again; answering it records the same decision.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Sharing one connection per workspace server across agents needs a `dsh-mcp-client` supervisor that accepts an external tool sink and per-attempt config; that change would also restore per-reconnect credential resolution and redacted failure logs.
- Withdrawing a server from running agents after a decision changes needs a trust-file watch and a defined notice to the affected sessions.

</details>
