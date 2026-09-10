# @deepseek-ai/dsh-discord-bot

English | [中文](README.zh.md)

Discord bridge for the dsh `api` service. Mentioning the bot in a channel opens a Discord thread and a harness session; every later message in that thread continues that session, and the agent's tool calls, answers, approval requests, and questions post back into the thread. The bot is a client of `POST /api/<method>` and the `/api/events.mux` WebSocket, the same surface the Web UI uses, so its sessions appear in the Web UI as well.

## Run

The bot needs a Discord application with a bot user whose **Message Content** intent is enabled, invited to the server with View Channels, Send Messages, Send Messages in Threads, Create Public Threads, and Read Message History (permissions integer `309237713920`).

1. Write the bot token to `secrets/github-token`'s sibling `secrets/discord-token` (the file is gitignored and bind-mounted read-only).
2. Set `DISCORD_ALLOWED_USER_IDS` in `.env` to the comma-separated Discord user ids that may drive the agent.
3. With the api service already running under whatever overlay it uses, start the bot with `docker compose --profile discord up -d --no-deps discord-bot` (or `make docker-discord`). `--no-deps` keeps compose from recreating `api` against a different file set; the bot joins the running container's network namespace by service name.

The service shares the api service's network namespace and reaches the API on that namespace's loopback, so no trusted host is declared for it. It exits at start when the token file or the allowlist is missing, and when `host.describe` on the api service fails.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_TOKEN_FILE` | `/etc/dsh/secrets/discord-token` | File holding the bot token |
| `DISCORD_ALLOWED_USER_IDS` | required | Comma-separated Discord user ids allowed to prompt, approve, and answer |
| `DSH_API_URL` | `http://127.0.0.1:3081` | Base URL of the api service |
| `DSH_DISCORD_STATE_FILE` | `$DSH_HOME/discord-bot/threads.json` | Thread-to-session map, kept across restarts |
| `DSH_SESSION_CWD` | api service cwd | Working directory for every session the bot creates |

## Conversation rules

- A mention in a guild channel creates a thread named after the message and a fresh session; the mention text is the first prompt. A message in a thread the bot owns continues its session. A DM channel is its own thread.
- Messages, button clicks, and menu choices from users outside the allowlist are ignored and logged; strangers who click get an ephemeral refusal.
- Each message is queued as one prompt. `!cancel` aborts the running turn.
- Each tool call posts one line with the tool name and the host's presentation title, or a compacted argument summary. A failed tool result posts its first line. Every assistant message with text posts as text, split at 2000 characters. A turn that ends for any reason other than completion posts why.
- An approval request posts Allow once and Reject buttons; a click answers through `/api/respond`, and the message is edited with the outcome once the host confirms it. Every `ask_user_question` option list becomes a select menu; a question without options is answered by the next thread message; the prompt is sent once every question has an answer.
- Approvals and questions that were pending when the stream reopens are replayed by the host and posted once.

## Known Limitations and Deferred Work

- **A reconnect gap drops events** — the WebSocket carrier does not honor `since`, so anything the host emitted while the stream was down is not replayed except pending approvals and questions.
- **Text prompts only** — Discord attachments are not forwarded as image prompts.
- **Five option lists per question prompt** — Discord allows five component rows per message; further questions are shown but cannot be answered from the menu.
- **Unrelated sessions are invisible** — only sessions the bot created are projected; the Web UI's sessions do not appear in Discord.
- **Bash needs a working sandbox in the container** — the api service runs the base bundle's `workspace-write` policy, and the bot only relays what the host asks; where no sandbox backend is usable, every bash call fails closed and posts that failure.
