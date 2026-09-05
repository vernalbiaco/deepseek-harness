# Agent Note: Docker Compose deployment stack

Status: implemented

English | [中文](2026-08-26-docker-compose-deployment-stack.zh.md)

## Problem

Running `dsh` from a checkout requires a matching Node toolchain, a pnpm install, and a build, and it leaves profile state in the developer's own `$DSH_HOME`. Evaluating the harness, running it against an unrelated project, or driving it from a program each want an isolated runtime with reproducible dependencies instead.

Two constraints make a container arrangement non-obvious. Each `dsh` server binds container loopback because the CLI refuses a routable bind, so a published port cannot reach it directly. And the surfaces worth exposing carry no authentication: `/api` enforces a `Host`-header reachability policy, and privileged methods are pinned to loopback, so any published port is a capability grant to whoever can route to it — one that includes running code inside the container and spending the account's model quota.

A third problem is credential-shaped. Serving a personal Claude or Codex subscription as a model route means the container reads the OAuth token the host CLI maintains, and the plugin that does this refreshes that token near expiry and writes it back to the same file. The credential is therefore shared mutable state between the host CLI and the container, not an input the container merely consumes.

## Decision

A Compose stack builds the CLI and Web UI from the checkout and runs three `dsh` services — `web`, one-shot `headless`, and `api` — over one `dsh-home` volume that owns profile state across image rebuilds. `make` targets front the ordinary operations, and [README](../../../../README.md) documents the stack under `Run`.

Every published port binds the host loopback. Because a `dsh` server binds container loopback, each exposed service pairs with a `socat` sidecar that joins the service network namespace through `network_mode: "service:<name>"` and relays the published port inward. A sidecar cannot rejoin a namespace its service replaced, so restarting a `dsh` service requires recreating its sidecar rather than restarting it; `make docker-patch-plugins` encodes that order.

The `api` service composes the `/api` gateway from host-plane rows only, with no `web-app`, `frontend-static`, `modules`, or `ui-*` row, so a program can create a session, select a model, submit a prompt, and read the transcript without a browser client. Its `connection` row carries a literal `trustedHosts` rather than injecting `webRuntime`, whose provider mounts the built frontend dist unconditionally. The profile lives in the volume rather than the repository, because a profile is deployment state that a user edits and installs into.

`workspaces/` is a bind-mount root for unrelated checkouts, each possibly its own repository. Git tracks only its `.gitkeep`, the build context excludes it, and it joins the non-source directories that bilingual discovery skips: a mounted project's READMEs are not this repository's translation source.

### Routing through a shared Traefik

[`docker-compose.raven.yml`](../../../../docker-compose.raven.yml) is an override that adds a second path to the same two services: Traefik router labels publishing them as `harness.local.raven.com` and `harness-api.local.raven.com`. The labels sit on the `dsh` service rather than its sidecar, because Traefik discovers the service and the port it targets is the sidecar's listener inside that service network namespace. The loopback publishes stay; the override adds a path rather than replacing one.

Both hostnames are declared to the `/api` browser-trust fence, which refuses any `Host` that is neither loopback nor configured. The `web` service declares its name through the `--trusted-host` flag in the override's `command`, so the declaration lives with the override that introduces the name; the `api` profile declares its own in the `trustedHosts` it already carries in the volume. Declaring a name widens a DNS-rebinding defense, so what still bounds the grant is Traefik's bind address, not the fence.

The override consumes `hybrid_public_network` as `external`, so Compose refuses to start when the owning stack is down. [`docker-compose.infra.yml`](../../../../docker-compose.infra.yml) is a separate Compose project that creates that network and serves a loopback-bound Traefik on it, for a workstation that wants the override without the owning stack. It is mutually exclusive with that stack's own Traefik: both bind host port 80 and hold the same discovery role. Traefik v3.6 or newer is required because releases through v3.5.6 pin Docker API 1.24 and ignore `DOCKER_API_VERSION`, which Docker Engine v29 daemons reject.

### Routing model traffic through a gateway

[`docker-compose.omni.yml`](../../../../docker-compose.omni.yml) runs OmniRoute, an OpenAI-compatible gateway, as its own Compose project, and [`docker-compose.omni-wire.yml`](../../../../docker-compose.omni-wire.yml) joins the three `dsh` services to its network so their model traffic terminates there instead of at the public API. The gateway is a separate project for the reason the infra project is: it outlives any one harness run and serves host-side tools, so `make docker-down` leaves it running. Its data volume is `external` because that volume holds the auto-generated signing secrets every minted key is issued against, and a fresh volume would invalidate all of them.

`DEEPSEEK_BASE_URL` reaches the services through Compose's `environment:` rather than `.env`. `dsh` accepts it only from the launching environment, and the checkout is bind-mounted at `/workspace`, so `./.env` is a file the agent itself can edit; letting it redirect the model endpoint would hand the agent its own network reach. Compose's `environment:` is the launching environment, which satisfies the guard.

The gateway accepts only a key minted from its own dashboard and the public API accepts only a real DeepSeek key, so the key is mode-specific while `.env` is not. `.env` holds `DEEPSEEK_API_KEY` for direct mode and `OMNIROUTE_API_KEY` for the gateway, and the overlay maps the latter onto the former inside the wired services, which holds because Compose resolves `environment:` after `env_file:`. Both gateway variables are `:?`-required, so an absent or empty value fails at `config` time naming the variable rather than at the first model request.

Mode is a property of a Compose file set, so every `make` target that touches a running service runs against the same set. `COMPOSE_FILE` carries it: the base file by default, extended per target for the overlay modes, and exported so the invocations nested inside a target's shell loops inherit it. A target with no mode variant, `make docker-patch-plugins`, takes the set from the environment instead. `make docker-all` composes both overlays at once; they are orthogonal, and Compose unions the `networks` lists rather than replacing them.

### Third-party plugin patches

[`patches/dsh-llm-local-token/`](../../../../patches/dsh-llm-local-token/README.md) holds patched modules for a third-party plugin at a pinned version, applied only by `make docker-patch-plugins`. They are not pnpm `patchedDependencies`: the plugin is installed at runtime into a profile inside the `dsh-home` volume, which no install-time mechanism reaches.

Both fixes concern credential ownership. Upstream reads the current Claude credential shape from the macOS Keychain alone, so on Linux the route registers as absent with no error; and its Codex write-back preserves file mode but not owner, so a root-run refresh leaves a root-owned credential the host CLI can no longer read. Each rewrite preserves the file's owner and mode and keeps sibling fields intact, because the host CLI and the container share one file. The Claude fix stores the true expiry rather than expiry-minus-skew, since the official CLI reads that same field.

A `dsh plugin` install or update replaces the whole package directory and silently drops these modules, taking the affected route with them. `make docker-check-plugins` reports the registered routes so the loss is observable rather than inferred.

## Alternatives considered

**Publish the web port on every interface.** The original arrangement, and the reason this note exists: it made an unauthenticated agent reachable from the local network. The harness itself refuses `--host 0.0.0.0` for the same reason, so honoring that refusal at the CLI while undoing it at the port mapping would be incoherent.

**Bind the `dsh` server to `0.0.0.0` inside the container and drop the sidecars.** This removes two containers and the restart-ordering rule. It also removes the one place the loopback decision is stated, leaves the guard the CLI enforces bypassed by configuration, and makes a future host-network deployment silently routable.

**Reuse the `web` service for programmatic callers.** The `/api` surface is identical, so a second service looks redundant. But the browser composition mounts the frontend dist, the client bundle roster, and every `ui-*` row, and it opens a browser on start; a caller that never renders pays for and exposes all of it. Separate services also let the browser and programmatic surfaces be published, stopped, and scoped independently.

**Add a network API to `headless` instead.** It is the natural home for "run a task programmatically". Its bundle deliberately mounts no Host, HTTP server, or Web runtime, and a test asserts that absence; the profile also runs one task and exits, so a long-lived server contradicts its lifecycle. The repository already exposes stdio JSON-RPC and ACP servers for programmatic callers, which remain the recommended path.

**Mount the credential directories read-only.** This is the safer-looking mount and it works until the token nears expiry, at which point refresh fails and the route dies. Copying the credential into a container-local path fails worse: a refresh there rotates the refresh token against the provider while the host CLI keeps the superseded one, logging the user out of their own CLI.

**Let the Traefik override create `hybrid_public_network` itself.** Declaring the network non-external would start the stack whether or not the owning stack is up. It would also make either project's teardown remove a network the other is using, and would silently produce hostnames that resolve to a Traefik that is not there. Consuming it as `external` fails loudly at start instead, and the standalone infra project owns the network when nothing else does.

**Widen the `/api` fence once, for any Host.** A single permissive setting would spare each deployment from naming itself. The fence exists because `Host` is the one header DNS rebinding cannot forge, so accepting any value removes the defense outright rather than extending it to a known name.

**Vendor a fork of the plugin, or pin it through pnpm.** A fork owns a package the upstream still maintains, and `patchedDependencies` cannot reach a package installed at runtime into a volume. Copying modules over an installed package is the mechanism that matches where the package actually lives, at the cost of being silently reversible by any reinstall.

**Carry the minted gateway key in `DEEPSEEK_API_KEY`.** One variable for "the key the model endpoint accepts" reads simpler, and the application reads only that name. But the two endpoints accept different keys while both modes read one `.env`, so a single name makes the modes mutually destructive: storing the minted key breaks every direct-mode target, and restoring the real one breaks the gateway. Mapping a distinct name onto it in the overlay keeps one `.env` correct for both.

**Let each overlay target pass its own `-f` flags.** This is the smaller arrangement and keeps the file set visible in the recipe. It also leaves every other target — teardown, logs, patching, the checks — running against the base file alone, so a command aimed at a service running in an overlay mode reads a different configuration than the one that started it, and an `up` on a dependency can recreate that service without its overlay.

## Consequences

An evaluator runs `make docker-build && make docker-web` without a local toolchain, and a program drives the agent over HTTP against the `api` service. Profile state, installed plugins, and sessions survive image rebuilds. Nothing is reachable off-host by default; publishing beyond loopback stays a deliberate edit, and the README states what it grants.

Three operational rules must be remembered because nothing enforces them. Restarting a `dsh` service requires recreating its sidecar. The plugin patches must be reapplied after any install or update of that package, which `make docker-check-plugins` makes checkable. And a target acting on a running service must carry that service's Compose file set, or it reads a different configuration than the one that service started with. Both fixes belong upstream, and landing them there retires the patch directory.

The Traefik hostnames resolve only where `/etc/hosts` maps them to loopback, as the other `*.local.raven.com` names are; without that entry the names may resolve publicly and the request leaves the machine. The `api` profile's `trustedHosts` lives in the volume rather than the repository, so it shares the plugin patches' failure mode: recreating the volume drops it, and the route 403s until it is restored.

The `api` profile composition is enumerated by hand, so a future row that the gateway requires appears as a load-time failure naming the missing service rather than as a broken endpoint. That is the loud failure the loader is designed for, but it does mean the composition tracks the gateway's dependencies manually.

Model traffic has a second destination, and nothing in the session log distinguishes them: a request served through the gateway looks like any other. The gateway holds the minted key and terminates every request while its image floats on `:latest`, so the component in that position updates without review. Its dashboard binds loopback and is unauthenticated until first login, and `OMNIROUTE_INITIAL_PASSWORD` sits in the `.env` the agent reads at `/workspace/.env`, on a network the wired services join.
