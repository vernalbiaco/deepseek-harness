# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

### 在 Docker 中运行

仓库提供一套 Compose 编排：从源码检出构建 CLI 与 Web UI，并在容器中运行它们：

```sh
make docker-build                                     # build the image
make docker-web                                       # Web UI at http://127.0.0.1:3080
make docker-headless ARGS='"summarize the README"'    # answer one task, then exit
make docker-down                                      # stop every service
```

`DSH_WORKSPACE` 决定服务将哪个目录挂载为 Agent 工作区，`workspaces/` 则是供其他无关检出使用的第二个挂载点。Profile 状态——已安装插件、会话与设置——保存在 `dsh-home` 卷中，镜像重新构建后依然保留。 把一个具备推送权限的 GitHub 令牌写入 `secrets/github-token`，代理即可从任一已挂载的检出推送：镜像自带 git 而没有 ssh，因此容器经由 [`docker/git/`](docker/git/) 中的凭据助手通过 HTTPS 访问 GitHub，该助手读取的是这个文件，而不是代理命令永远继承不到的环境变量。

`api` 服务提供与 Web UI 所调用相同的 `POST /api/<method>` 接口，其组合不含浏览器客户端。

```sh
docker compose up -d api api-proxy                    # API at http://127.0.0.1:3081
```

所有发布端口均绑定宿主机回环地址。该接口执行的是基于 `Host` 头的可达性策略而非身份认证，因此若绑定到可路由地址，任何能访问它的人都可以在容器内执行代码。[`docker-compose.raven.yml`](docker-compose.raven.yml) 是一个覆盖文件，它额外把这两个服务经 RavenStack 共享的 Traefik 路由为 `harness.local.raven.com` 与 `harness-api.local.raven.com`；该 API 路由的私密程度仅取决于 Traefik 自身的绑定地址。它要求一个由 RavenStack 栈拥有的外部网络 `hybrid_public_network`，而 `make docker-infra` 会在该网络上提供一个绑定回环地址的 Traefik，供不运行 RavenStack 却要使用该覆盖文件的工作站使用。这两个主机名都已向 `/api` 信任策略声明，否则它会拒绝自己不认识的 `Host`。

Web UI 需要浏览器的安全上下文，而纯 HTTP 只会把它授予 `127.0.0.1` 以及以 `.localhost` 结尾的名称；在其他任何主机名上，会话列表都会保持为空，连接则不断重试。因此该覆盖文件还会路由 `harness.localhost` 与 `harness-api.localhost`，并用本地签发的证书以 HTTPS 提供全部名称：先运行一次 `make docker-certs`，再运行 `make docker-certs-trust`，把该 CA 加入当前用户的浏览器信任库。

`harness.ernestojpamajr.com` 面向互联网提供 Web UI。本机上的一条 Cloudflare 隧道把该名称转发到 Traefik 绑定在回环地址的 `web` 入口，而隧道是从主机内部访问它的，因此回环绑定并不限制谁能抵达。Cloudflare 负责终止 TLS，这正是 Web UI 所需的安全上下文；隧道会原样透传 `Host`，因为只要浏览器发送了 `Origin`，`/api` 策略就要求它与 `Host` 相等。该名称上的身份认证由 Cloudflare Access 承担，本仓库既不配置也不检查它：一旦缺少它，该名称对外提供的就是一个无认证的 Agent，任何人都能在容器内执行代码并读取已挂载的凭据。

每个 `/api` 调用与 `/api/remote.mux` WebSocket 都首先需要浏览器会话 cookie；该 cookie 由在浏览器所用的主机名上打开 `dsh web` 启动时打印的 `?token=` URL 签发。[`@deepseek-ai/dsh-api-key-auth`](packages/api/key-auth/README.zh.md) 的闸门只在该检查之后运行，因此只持有 bearer 密钥的程序会被以 `401` 拒绝；而 `api` Profile 不组合 web 应用、不打印令牌 URL，因此不放行任何调用方。

挂载 Claude Code 与 Codex 的凭据目录后，[`dsh-llm-local-token`](https://github.com/tianxia--/dsh-llm-local-token) 即可将这些订阅作为模型路由提供。这些挂载为可读写：插件会在令牌临近过期时刷新，并写回宿主机 CLI 读取的同一个文件。[`patches/dsh-llm-local-token/`](patches/dsh-llm-local-token/README.zh.md) 收录了该版本在 Linux 上所需的修复，`make docker-patch-plugins` 可在任何一次重新安装后重新应用它们。

默认情况下，harness 直接访问公开的 DeepSeek API，各服务的 DeepSeek 密钥从 Web 的 Models 页面设置而非注入，因此该卡片保持可写。`make docker-all` 会在 Traefik 之后启动这一默认技术栈。将模型流量经网关转发是可选项。

[`docker-compose.omni.yml`](docker-compose.omni.yml) 以独立的 Compose 项目运行 OpenAI 兼容网关 OmniRoute，而 [`docker-compose.omni-wire.yml`](docker-compose.omni-wire.yml) 会把各 harness 服务接入它的网络，使这些服务的模型流量发往该网关而非公开的 DeepSeek API。该网关之所以独立成项目，是因为它的存续时间长于任何一次 harness 运行，还要同时服务宿主机上的工具，因此 `make docker-down` 会让它继续运行；`make docker-omni-down` 才会在已接入的服务停止后停掉它。

```sh
make docker-all                                          # DEFAULT full stack: Traefik + web + API, DeepSeek direct
make docker-omni                                         # gateway at http://127.0.0.1:20128
make docker-omni-key                                     # how to mint the key it accepts
make docker-omni-web                                     # web + API routed through the gateway
make docker-omni-headless ARGS='"summarize the README"'  # one task through the gateway
make docker-omni-check                                   # confirm the services reach it
make docker-all-omni                                     # full stack with model traffic through the gateway
```

仪表盘绑定宿主机回环地址，且在首次使用 `OMNIROUTE_INITIAL_PASSWORD` 登录之前不设身份认证。在其中签发的密钥以 `OMNIROUTE_API_KEY` 写入 `.env`，覆盖文件会在已接入的服务内部把它映射到 `DEEPSEEK_API_KEY`；直连模式两者都不注入，其 DeepSeek 密钥来自 Web 的 Models 页面或 `.env` 中一个可写的回退值。`make docker-omni-key` 会打印相应步骤，`make docker-omni-check` 则报告运行中的服务能否访问该网关。同一条隧道还把该仪表盘发布为 `omni.ernestojpamajr.com`，由 Traefik 依据网关自身的路由标签对外提供；harness 服务经 `omniroute_network` 访问网关，因此它们的模型流量不会走这个名称。

覆盖文件在启动环境而非 `.env` 中设置 `DEEPSEEK_BASE_URL`，并且只要有 `.env` 文件设置了它，`dsh` 就会拒绝启动：源码检出以绑定挂载置于 `/workspace`，因此项目内的文件不得能够改变 Agent 访问网络的去向。

网关镜像跟随 `:latest` 浮动，因此这个持有已签发密钥并终结全部模型请求的组件，会在无人评审的情况下更新。

每种模式的目标各自携带一套 Compose 文件集合。若要让没有对应模式变体的目标（例如 `make docker-omni-check`）作用于已经运行在网关模式或 Traefik 模式下的服务，就需要通过 `COMPOSE_FILE` 把该集合传入。`make docker-patch-plugins` 与 `make docker-check-plugins` 不使用文件集合：它们按 Compose 标签找到正在运行的容器并直接作用于这些容器。

`make docker-ecr-push` 以 `linux/amd64` 构建该编排的两个镜像，并推送到当前 AWS CLI 身份所属账号与区域的 Amazon ECR，仓库分别为 `terra/dsh` 与 `terra/dsh-web-proxy`，每个镜像都打上短提交哈希与 `latest` 两个标签。工作区存在未提交或未跟踪的文件时它会拒绝执行，因为构建会把整个检出复制进镜像，标签所指的提交就与镜像内容不符；传入 `ALLOW_DIRTY=1` 可跳过该检查。无法读取的仓库会在构建之前中止推送，`make docker-ecr-create` 则会创建这两个仓库并开启推送时扫描。推送以 `--pull --no-cache` 构建，因此每个镜像都基于当前的基础镜像，并携带构建时已发布的 Debian 安全更新。`AWS_REGION`、`ECR_REGISTRY`、`ECR_REPOSITORY_PREFIX` 与 `IMAGE_TAG` 可覆盖默认值。

```sh
make docker-ecr-create                                   # once: create terra/dsh and terra/dsh-web-proxy
make docker-ecr-push                                     # build, then push :<commit> and :latest
```

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
