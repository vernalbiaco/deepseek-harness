# Agent Note: Workspace MCP servers mounted per agent

Status: implemented

English | [中文](2026-09-15-workspace-mcp-servers-per-agent.zh.md)

## Problem

MCP servers reach a Harness process only as `@deepseek-ai/dsh-mcp-client` rows in a profile, a `--patch` layer, or an ACP `mcpServers` request. A profile row is process-global, so a Web deployment serving several workspaces cannot give one workspace its own servers, and a project that already ships a Claude Code `.mcp.json` must be hand-converted into Cordis rows. Loading a workspace's server list without a gate is not acceptable: a stdio server is an executable spawned outside the agent sandbox, and an HTTP server receives workspace data and bearer credentials.

## Decision

`@deepseek-ai/dsh-mcp-workspace` is mounted in the base bundle. For every root agent with a session cwd it reads `<canonical cwd>/.mcp.json`, admits each declared server only through a user decision stored in `$DSH_HOME/mcp-trust.yaml` or given for one session, and mounts one `dsh-mcp-client` instance per admitted server on that agent's context. The [package README](../../../../packages/mcp/mcp-workspace/README.md) owns the configuration, `.mcp.json` support, question, and log contracts.

- **Mounting.** `agent/created` is serial and awaited before the agent's first step. The listener mounts saved `allow` servers and waits for their first connection attempts up to `admissionTimeoutMs`, then returns; questions about undecided servers run afterwards and mount on a later step. `dsh-mcp-client` reserves `serverName` per registration scope, so agents in one workspace mount the same name independently, and ACP's per-session mounting follows the same model.
- **Trust.** Decisions are keyed by canonical path, server name, and a fingerprint of the entry before placeholder substitution. Each mount rereads the stored decision; a stored `deny` wins over Allow this session.
- **Credentials.** `${NAME}` placeholders resolve through `ctx.credentials` once per mount. Sensitive env and header fields must use a placeholder.
- **Lifetime.** A mounted server is a child plugin of the agent's context and stops with the agent; plugin disposal unmounts every server it mounted.
- **Invariant companion.** None is published: the agent-to-server relation is the Cordis fiber tree itself, with no independently observable second record.

## Alternatives considered

**One shared connection per workspace server.** The first implementation, kept on the local `master-backup` branch, pooled one supervised connection per `(workspace, server, fingerprint)` and published its tools to every attached agent. It required a `dsh-mcp-client` supervisor with a pluggable tool sink, per-attempt config resolution, error redaction, and a stopped signal. Upstream `dsh-mcp-client` has since added resources and server instructions to that supervisor, and rebasing the fork conflicted repeatedly. Sharing saved child processes and resolved credentials on every reconnect, but it is not required to scope servers to a workspace, and it duplicated lifetime tracking that the agent context already provides.

**Mounting through `AgentSetup`.** ACP mounts servers inside the `setup` callback of `ctx.agents.create`. That callback belongs to the caller that creates the agent, so a base-bundle plugin cannot contribute to agents created by Web, headless, or subagent callers through it.

**Asking inside `agent/created`.** Waiting for a user answer while the serial listener runs would block session creation on a question for a session the client cannot display yet.

## Consequences

- N sessions in one workspace run N copies of each stdio server.
- A rotated credential reaches only agents created afterwards, and `dsh-mcp-client` failure log lines are not redacted.
- Workspace servers contribute resources and server instructions exactly as profile rows do.
- A same-named ACP `mcpServers` entry and workspace server on one agent conflict; the workspace mount is logged as failed and the ACP server stays.
