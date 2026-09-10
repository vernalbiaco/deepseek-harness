# Agent Note: Discord bridge over the api service

Status: implemented

English | [中文](2026-09-10-discord-bridge-over-the-api-service.zh.md)

## Problem

Users wanted to talk to the agent from Discord: open a task from a channel, watch it run, approve its tool calls, and answer its questions without opening the Web UI. The repository had no chat-platform integration, and the three programmatic surfaces differ in what they can carry. The stdio SDKs own a private runtime whose sessions the Web UI never sees and whose wire has no approval flow; the ACP server answers approvals by machine policy and is built for subagents; only the `api` service exposes the approval and question server-requests the Web UI itself answers.

## Decision

Ship `apps/discord-bot`, a private app that is an ordinary client of the `api` service. It calls `session.create`, `session.prompt`, and `session.cancel` over `POST /api/<method>`, consumes `/api/events.mux` over WebSocket, and answers `approval/requested` and `question/requested` frames through `/api/respond`. Sessions it creates therefore appear in the Web UI and share the deployment's model default, presets, and tools.

The Discord-agnostic core (`bridge.ts`) maps thread ids to session ids, filters the mux stream to sessions it created, and speaks to the chat platform through a `Poster` interface; `discord.ts` implements that interface with discord.js. One thread is one session: a mention in a guild channel opens a thread, a DM channel is its own thread. Only allowlisted Discord user ids may prompt, approve, or answer; every other user is ignored and logged. The thread map persists as JSON on the `dsh-home` volume so a restart keeps old threads alive; the mux reopens with exponential backoff and deduplicates the host's replay of pending prompts by server-request id.

The compose service shares the api service's network namespace (`network_mode: "service:api"`), like the proxy sidecars, so the bot reaches the API on that namespace's loopback and passes the `/api` Host fence without adding a trusted host. It lives behind the `discord` compose profile, so a stack without a bot token still starts. The bot token is a file under `secrets/`, matching the GitHub token; the allowlist is plain configuration in `.env`. The app sits in `apps/` rather than `packages/` because it is an assembly with no reusable contract, and the per-file coverage gate applies to `packages/*/*/src` only.

## Alternatives considered

**A `dsh-discord` plugin inside the Host.** The idiomatic long-term shape: it would drive `ctx.agents` directly and answer `approval/request` in process, like the ACP bridge. It also binds a third-party gateway library into the Host process and carries every package gate from the first commit. A client of the existing gateway proves the message mapping and the approval UX first; promotion into a plugin stays open.

**Drive the harness through the SDK.** Simplest client code, but each bot would own a runtime the Web UI cannot see, and the SDK wire has neither an approval flow nor a mid-turn cancel, so the bot would need the `never` approval policy.

**Reach the API through the compose network by service name.** That sends `Host: api:8081`, which the fence refuses unless the api profile's `trustedHosts` names it, and the profile is deployment state in the volume. Sharing the namespace keeps the fence untouched.

**Stream assistant text as message edits.** Closest to the Web UI, but Discord rate-limits edits and a long turn would stall the bot. Whole messages per assistant message keep the bot within limits.

## Consequences

Anyone on the allowlist runs code in the api container and, with the GitHub token mounted there, pushes as its account. The reconnect path drops events emitted while the stream was down, because the WebSocket carrier does not honor `since`; pending approvals and questions are the exception. Bash calls depend on a usable sandbox backend inside the container; where none exists, the api service's `workspace-write` policy fails every call closed and the thread shows that failure.
