# dsh-llm-local-token 运行时补丁

[English](README.md) | 中文

针对第三方插件 [`dsh-llm-local-token`](https://github.com/tianxia--/dsh-llm-local-token) 两个模块的本地修复。已发布的 **1.3.2** 与 **1.5.1** 附带的这两个模块逐字节相同，因此同一份打过补丁的副本对两个版本都适用。

它们**不是** pnpm 依赖补丁。同级目录下的 `patches/*.patch` 属于 `pnpm-workspace.yaml` 中的 `patchedDependencies`，在安装时应用于工作区依赖。而此处的文件替换的是某个插件的两个模块，该插件在运行时安装进 dsh Profile，位于 `dsh-home` Docker 卷中，而非本仓库的 `node_modules`。没有任何环节会自动应用它们，只有 `make docker-patch-plugins` 会。

## 存在的原因

该插件使用本机 Claude Code 与 Codex CLI 已持有的 OAuth 令牌来服务 LLM 调用，从而让个人订阅成为一条模型路由。两处缺陷会在 Linux 上阻断或危及这一点。

**`claude-keychain.js` —— Claude 路由从未注册。** 当前的 Claude Code 版本在所有平台上都会将 `claudeAiOauth` 负载写入 `~/.claude/.credentials.json`。上游仅从 macOS Keychain 读取该结构，其文件读取器只理解较早的 `tokens[0].accessToken` 布局。在 Linux 上，文件能够解析但取不到令牌，解析流程随即落到一个受 `darwin` 限定的分支并抛出异常。由于 `requireClaude` 默认为 `false`，该失败被吞掉，路由在毫无报错的情况下消失。本补丁让文件存储获得与 Keychain 存储相同的读取、刷新与写回能力。

**`token-store.js` —— 一次刷新可能把宿主机 CLI 锁在门外。** `writeCodexAuth` 以 `0600` 模式替换 `~/.codex/auth.json`，却从不恢复原有属主。当 harness 以 root 身份运行、面对一个由桌面用户拥有的绑定挂载凭据文件时，首次刷新会留下一个 root 拥有的文件，宿主机 `codex` CLI 从此无法读取。本补丁在替换过程中保留原有的 uid/gid。

两处重写都保留文件的权限位与属主，并保持同级字段（`mcpOAuth`、`scopes`、`subscriptionType`、`account_id`、`auth_mode`）不变。Claude 补丁存储的是真实过期时间而非过期时间减去偏移量，因为官方 CLI 读取的正是同一字段，而刷新偏移量属于比较逻辑，不属于存储内容。

## 内容

| 文件 | 作用 |
|---|---|
| `claude-keychain.js` | 已打补丁的模块，覆盖到已安装的同名文件上 |
| `token-store.js` | 已打补丁的模块，覆盖到已安装的同名文件上 |
| `claude-file-oauth.patch` | 相对上游 1.3.2 的 unified diff，供评审或上游提交使用 |
| `codex-writeback-owner.patch` | 相对上游 1.3.2 的 unified diff |

## 应用方式

```sh
make docker-patch-plugins     # copy into every running profile, then restart
```

该目标按 Compose 标签找到正在运行的 `web` 与 `api` 容器，把两个模块复制进各自 Profile 的 `dsh-llm-local-token` 安装目录，重启容器以便运行中的进程加载它们，并重启其 `-proxy` 边车，使边车重新加入被重启替换的网络命名空间。它不读取任何 Compose 文件集合，因此不会重建或重新构建任何内容，可从任意检出或 worktree 运行；当有多个 Compose 项目运行 dsh 镜像时，用 `DSH_STACK_PROJECT` 指定要打补丁的项目。若某个服务对应的 Profile 未安装该插件，则会被报告并跳过。

在复制之前，该目标会对每个已安装模块取哈希——若此前的运行留下了 `.orig` 备份则取该备份，否则取已安装的文件——并与 `docker/plugin-patches.sh` 中记录的上游哈希比对。若某个发布版本改动了其中任一模块，运行会停止并指出该模块与已安装的版本号，且不会向任何服务复制任何文件：基于不同底本制作的补丁副本会静默丢弃该发布版本自身的改动。

在对该包执行任何 `dsh plugin ... add`、更新或重新安装之后都需要重新应用：pnpm 会替换整个包目录，因此打过补丁的模块会被静默覆盖，Claude 路由随之再次消失。可用 `make docker-check-plugins` 验证，它会列出已注册的路由——健康的 `web` 或 `api` 服务会同时报告 `openai-codex` 与 `anthropic`。

## 上游提交

两处修复都应回到上游 <https://github.com/tianxia--/dsh-llm-local-token>。`.patch` 文件适用于发布 tarball 中的 `lib/`；在该仓库源码中做出等价改动即可让本目录退场。
