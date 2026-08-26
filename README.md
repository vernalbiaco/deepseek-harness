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

`DSH_WORKSPACE` selects the directory a service mounts as the agent workspace, and `workspaces/` is a second mount for unrelated checkouts. Profile state — installed plugins, sessions, and settings — lives in the `dsh-home` volume and outlives an image rebuild.

The `api` service serves the same `POST /api/<method>` surface the Web UI calls, composed without a browser client, so a program can create a session, select a model, submit a prompt, and read the transcript over HTTP:

```sh
docker compose up -d api api-proxy                    # API at http://127.0.0.1:3081
```

Every published port binds the host loopback. That surface enforces a `Host`-header reachability fence rather than authentication, so a routable address would let anyone who reaches it run code inside the container.

Mounting the Claude Code and Codex credential directories lets [`dsh-llm-local-token`](https://github.com/tianxia--/dsh-llm-local-token) offer those subscriptions as model routes. The mounts are read-write because the plugin refreshes each token near expiry and writes it back to the file the host CLI reads. [`patches/dsh-llm-local-token/`](patches/dsh-llm-local-token/README.md) carries the fixes that release requires on Linux, and `make docker-patch-plugins` reapplies them after any reinstall.

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
