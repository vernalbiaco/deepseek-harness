# dsh-llm-local-token runtime patches

English | [中文](README.zh.md)

Local fixes for the third-party [`dsh-llm-local-token`](https://github.com/tianxia--/dsh-llm-local-token) plugin, pinned at **1.3.2** (the latest published version as of 2026-08-26).

These are **not** pnpm dependency patches. The sibling `patches/*.patch` files belong to `patchedDependencies` in `pnpm-workspace.yaml` and are applied at install time to workspace dependencies. The files here replace two modules of a plugin installed at runtime into a dsh profile, which lives in the `dsh-home` Docker volume rather than in this repository's `node_modules`. Nothing applies them automatically; `make docker-patch-plugins` does.

## Why they exist

The plugin serves LLM calls with the OAuth tokens the local Claude Code and Codex CLIs already hold, so a personal subscription becomes a model route. Two defects block or endanger that on Linux.

**`claude-keychain.js` — the Claude route never registers.** Current Claude Code builds write the `claudeAiOauth` payload to `~/.claude/.credentials.json` on every platform. Upstream reads that shape from the macOS Keychain only; its file reader understands just the older `tokens[0].accessToken` layout. On Linux the file parses, yields no token, and the resolver falls through to a `darwin`-gated branch that throws. Because `requireClaude` defaults to `false`, the failure is swallowed and the route disappears with no error. The patch gives the file store the same read, refresh, and write-back the Keychain store already had.

**`token-store.js` — a refresh can lock the host CLI out.** `writeCodexAuth` replaces `~/.codex/auth.json` at mode `0600` but never restores the original owner. When the harness runs as root against a bind-mounted credential file owned by the desktop user, the first refresh leaves a root-owned file that the host `codex` CLI can no longer read. The patch carries the original uid/gid across the replace.

Both rewrites preserve the file's mode and owner and keep sibling fields (`mcpOAuth`, `scopes`, `subscriptionType`, `account_id`, `auth_mode`) intact. The Claude patch stores the true expiry rather than expiry-minus-skew, because the official CLI reads that same field and the refresh skew belongs to the comparison, not to storage.

## Contents

| File | Role |
|---|---|
| `claude-keychain.js` | Patched module, copied over the installed one |
| `token-store.js` | Patched module, copied over the installed one |
| `claude-file-oauth.patch` | Unified diff against upstream 1.3.2, for review or upstreaming |
| `codex-writeback-owner.patch` | Unified diff against upstream 1.3.2 |

## Applying

```sh
make docker-patch-plugins     # copy into every running profile, then restart
```

The target finds the running `web` and `api` containers by their Compose labels, copies both modules into each profile's `dsh-llm-local-token` installation, restarts the container so the running process loads them, and restarts its `-proxy` sidecar so the sidecar rejoins the restarted network namespace. It reads no Compose file set, so it recreates and rebuilds nothing and works from any checkout or worktree; when more than one Compose project runs the dsh image, `DSH_STACK_PROJECT` names the one to patch. A service whose profile does not have the plugin installed is reported and skipped.

Reapply after any `dsh plugin ... add`, update, or reinstall of this package: pnpm replaces the whole package directory, so the patched modules are silently overwritten and the Claude route disappears again. Verify with `make docker-check-plugins`, which lists the registered routes — a healthy `web` or `api` service reports both `openai-codex` and `anthropic`.

## Upstreaming

Both fixes belong upstream at <https://github.com/tianxia--/dsh-llm-local-token>. The `.patch` files apply to `lib/` in the published tarball; the equivalent change in that repository's sources retires this directory.
