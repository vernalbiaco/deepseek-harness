# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

### Run in Docker

A Compose stack builds the CLI and the Web UI from a checkout and runs them in containers:

```sh
make docker-build                                     # build the image
make docker-web                                       # Web UI at http://127.0.0.1:3080
make docker-headless ARGS='"summarize the README"'    # answer one task, then exit
make docker-down                                      # stop every service
```

`DSH_WORKSPACE` selects the directory a service mounts as the agent workspace, and `workspaces/` is a second mount for unrelated checkouts. Profile state — installed plugins, sessions, and settings — lives in the `dsh-home` volume and outlives an image rebuild. Write a GitHub token with push access to `secrets/github-token` and the agent can push from any mounted checkout: the image ships git without ssh, so the containers reach GitHub over HTTPS through the credential helper in [`docker/git/`](docker/git/), which reads that file rather than an environment variable the agent's commands would never inherit.

The `api` service serves the same `POST /api/<method>` surface the Web UI calls, composed without a browser client, so a program can create a session, select a model, submit a prompt, and read the transcript over HTTP.

```sh
docker compose up -d api api-proxy                    # API at http://127.0.0.1:3081
```

Every published port binds the host loopback. That surface enforces a `Host`-header reachability fence rather than authentication, so a routable address would let anyone who reaches it run code inside the container. [`docker-compose.raven.yml`](docker-compose.raven.yml) is an override that additionally routes the two services through RavenStack's shared Traefik as `harness.local.raven.com` and `harness-api.local.raven.com`; the API route is only as private as Traefik's own bind address. It expects an external `hybrid_public_network` that the RavenStack stack owns, and `make docker-infra` serves a loopback-bound Traefik on that network for a workstation running the override without RavenStack. Both hostnames are declared to the `/api` trust fence, which otherwise refuses a `Host` it does not know.

The Web UI needs a browser secure context, which plain HTTP grants only to `127.0.0.1` and names ending in `.localhost`; on any other hostname the session list stays empty while the connection retries. The override therefore also routes `harness.localhost` and `harness-api.localhost`, and serves every name over HTTPS from a locally minted certificate: run `make docker-certs` once, then `make docker-certs-trust` to trust the CA in this user's browser store.

`harness.ernestojpamajr.com` serves the Web UI from the internet. A Cloudflare tunnel on this host forwards the name to Traefik's `web` entrypoint on the loopback, which it reaches from inside the host, so the loopback bind does not limit who arrives. Cloudflare terminates TLS, which is the secure context the Web UI needs, and the tunnel passes `Host` through unrewritten because the `/api` fence requires `Origin` to equal `Host` whenever a browser sends one. Authentication on that name is Cloudflare Access, which this repository neither configures nor checks: without it the name serves an unauthenticated agent that can run code in the container and read the mounted credentials. The override also passes `--configuration-authority trusted-host`, so a browser on any of its trusted names reaches Settings, credentials, and preset management, which dsh otherwise pins to a loopback browser; that widening is only as safe as the login in front of the name.

Reaching that surface from elsewhere means mounting [`@deepseek-ai/dsh-api-key-auth`](packages/api/key-auth/README.md) on the profile the remote-facing service runs — the `api` service's, not the Web UI's — so every `/api` call and every event WebSocket must present a bearer key, and no keyed caller reaches the settings or credential methods. The Web UI cannot authenticate through it at all, because a browser cannot set an `Authorization` header on a WebSocket handshake, so a gated profile serves programmatic clients only. Mounting the plugin on the wrong profile, or exposing the ungated one, silently reopens the configuration plane to whoever can reach the port, and nothing in the code detects that.

Mounting the Claude Code and Codex credential directories lets [`dsh-llm-local-token`](https://github.com/tianxia--/dsh-llm-local-token) offer those subscriptions as model routes. The mounts are read-write because the plugin refreshes each token near expiry and writes it back to the file the host CLI reads. [`patches/dsh-llm-local-token/`](patches/dsh-llm-local-token/README.md) carries the fixes that release requires on Linux, and `make docker-patch-plugins` reapplies them after any reinstall.

By default the harness reaches DeepSeek directly at the public API, and each service's DeepSeek key is set from the web Models page rather than injected, so the card stays writable. `make docker-all` brings up that default stack behind Traefik. Routing model traffic through a gateway is opt-in.

[`docker-compose.omni.yml`](docker-compose.omni.yml) runs OmniRoute, an OpenAI-compatible gateway, as its own Compose project, and [`docker-compose.omni-wire.yml`](docker-compose.omni-wire.yml) joins the harness services to its network so their model traffic reaches the gateway instead of the public DeepSeek API. The gateway is a separate project because it outlives any one harness run and serves host-side tools too, so `make docker-down` leaves it running; `make docker-omni-down` stops it once the wired services are down.

```sh
make docker-all                                          # DEFAULT full stack: Traefik + web + API, DeepSeek direct
make docker-omni                                         # gateway at http://127.0.0.1:20128
make docker-omni-key                                     # how to mint the key it accepts
make docker-omni-web                                     # web + API routed through the gateway
make docker-omni-headless ARGS='"summarize the README"'  # one task through the gateway
make docker-omni-check                                   # confirm the services reach it
make docker-all-omni                                     # full stack with model traffic through the gateway
```

The dashboard binds the host loopback and is unauthenticated until the first login with `OMNIROUTE_INITIAL_PASSWORD`. A key minted there goes in `.env` as `OMNIROUTE_API_KEY`, which the overlay maps onto `DEEPSEEK_API_KEY` inside the wired services; direct mode injects neither, so its DeepSeek key comes from the web Models page or a writable `.env` fallback. `make docker-omni-key` prints the steps, and `make docker-omni-check` reports whether the running services reach the gateway. The same tunnel publishes the dashboard as `omni.ernestojpamajr.com`, which Traefik serves from the gateway's own router labels; the harness services reach the gateway over `omniroute_network`, so their model traffic never uses that name.

The overlay sets `DEEPSEEK_BASE_URL` in the launching environment rather than in `.env`, and `dsh` refuses to boot when a `.env` file sets it: the checkout is bind-mounted at `/workspace`, so a project-local file must not be able to redirect where the agent reaches the network.

The gateway image floats on `:latest`, so the component that holds the minted key and terminates every model request updates without review.

Each mode's targets carry their own Compose file set. Pointing a target that has no mode variant — `make docker-patch-plugins`, say — at services already running in gateway or Traefik mode means passing that set in as `COMPOSE_FILE`.

`make docker-ecr-push` builds the stack's two images for `linux/amd64` and pushes them to Amazon ECR as `terra/dsh` and `terra/dsh-web-proxy`, each tagged with the short commit and `latest`, in the account and region of the current AWS CLI identity. It refuses a working tree with uncommitted or untracked files, because the build copies the checkout into the image and the tag would name a commit the image does not match; `ALLOW_DIRTY=1` overrides. A repository that cannot be read stops the push before the build, and `make docker-ecr-create` creates both repositories with scan on push. The push builds with `--pull --no-cache`, so each image starts from the current base image and carries the Debian security updates published when it was built. `AWS_REGION`, `ECR_REGISTRY`, `ECR_REPOSITORY_PREFIX`, and `IMAGE_TAG` override the defaults.

```sh
make docker-ecr-create                                   # once: create terra/dsh and terra/dsh-web-proxy
make docker-ecr-push                                     # build, then push :<commit> and :latest
```

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
