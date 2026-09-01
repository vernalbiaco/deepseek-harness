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

`DSH_WORKSPACE` 决定服务将哪个目录挂载为 Agent 工作区，`workspaces/` 则是供其他无关检出使用的第二个挂载点。Profile 状态——已安装插件、会话与设置——保存在 `dsh-home` 卷中，镜像重新构建后依然保留。

`api` 服务提供与 Web UI 所调用相同的 `POST /api/<method>` 接口，其组合不含浏览器客户端，因此程序可以通过 HTTP 创建会话、选择模型、提交提示词并读取记录：

```sh
docker compose up -d api api-proxy                    # API at http://127.0.0.1:3081
```

所有发布端口均绑定宿主机回环地址。该接口执行的是基于 `Host` 头的可达性策略而非身份认证，因此若绑定到可路由地址，任何能访问它的人都可以在容器内执行代码。[`docker-compose.raven.yml`](docker-compose.raven.yml) 是一个覆盖文件，它额外把这两个服务经 RavenStack 共享的 Traefik 路由为 `harness.local.raven.com` 与 `harness-api.local.raven.com`；该 API 路由的私密程度仅取决于 Traefik 自身的绑定地址。它要求一个由 RavenStack 栈拥有的外部网络 `hybrid_public_network`，而 `make docker-infra` 会在该网络上提供一个绑定回环地址的 Traefik，供不运行 RavenStack 却要使用该覆盖文件的工作站使用。这两个主机名都已向 `/api` 信任策略声明，否则它会拒绝自己不认识的 `Host`。

Web UI 需要浏览器的安全上下文，而纯 HTTP 只会把它授予 `127.0.0.1` 以及以 `.localhost` 结尾的名称；在其他任何主机名上，会话列表都会保持为空，连接则不断重试。因此该覆盖文件还会路由 `harness.localhost` 与 `harness-api.localhost`，并用本地签发的证书以 HTTPS 提供全部名称：先运行一次 `make docker-certs`，再运行 `make docker-certs-trust`，把该 CA 加入当前用户的浏览器信任库。

若要从别处访问该接口，就需要在面向远程的那个服务所运行的 Profile 上挂载 [`@deepseek-ai/dsh-api-key-auth`](packages/api/key-auth/README.md)——即 `api` 服务的 Profile，而非 Web UI 的——这样每个 `/api` 调用与每条事件 WebSocket 都必须出示 bearer 密钥，且任何带密钥的调用方都触达不到 settings 与 credentials 方法。Web UI 完全无法通过它完成认证，因为浏览器无法在 WebSocket 握手上设置 `Authorization` 头，因此挂载了闸门的 Profile 只服务程序化客户端。把该插件挂到错误的 Profile 上，或是把未挂载闸门的那个暴露出去，都会在无声中把配置平面重新开放给任何能访问该端口的人，而代码无法检测到这一点。

挂载 Claude Code 与 Codex 的凭据目录后，[`dsh-llm-local-token`](https://github.com/tianxia--/dsh-llm-local-token) 即可将这些订阅作为模型路由提供。这些挂载为可读写：插件会在令牌临近过期时刷新，并写回宿主机 CLI 读取的同一个文件。[`patches/dsh-llm-local-token/`](patches/dsh-llm-local-token/README.md) 收录了该版本在 Linux 上所需的修复，`make docker-patch-plugins` 可在任何一次重新安装后重新应用它们。

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
