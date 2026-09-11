# Agent Note：基于 api 服务的 Discord 桥接

状态：已实现

[English](2026-09-10-discord-bridge-over-the-api-service.md) | 中文

## 问题

用户希望在 Discord 中与代理对话：从频道发起任务、观察其运行、审批其工具调用并回答其提问，而无需打开 Web UI。仓库此前没有任何聊天平台集成，而三个程序化接口所能承载的内容各不相同。stdio SDK 拥有一个私有运行时，其会话 Web UI 永远看不到，其线路也没有审批流程；ACP 服务器按机器策略回答审批，且是为子代理设计的；只有 `api` 服务暴露了 Web UI 自己所回答的审批与提问服务端请求。

## 决策

交付 `apps/discord-bot`，一个作为 `api` 服务普通客户端的私有应用。它通过 `POST /api/<method>` 调用 `session.create`、`session.prompt` 和 `session.cancel`，通过 WebSocket 消费 `/api/events.mux`，并通过 `/api/respond` 回答 `approval/requested` 和 `question/requested` 帧。因此它创建的会话会出现在 Web UI 中，并共享部署的默认模型、预设和工具。这些会话归入同一个工作区：已存在标题为 `Discord` 的工作区时按标题直接采用，因为用户可能已在 Web UI 中用自己的目录创建了它；否则，由于工作区即一个规范目录，机器人会以该标题注册一个配置的目录（默认 `/workspaces/Discord`，缺失时通过 `host.createDirectory` 创建）。每个会话都以该 `workspaceId` 创建。

与 Discord 无关的核心（`bridge.ts`）把线程 id 映射到会话 id，把 mux 流过滤到它创建的会话，并通过 `Poster` 接口与聊天平台对话；`discord.ts` 用 discord.js 实现该接口。一个线程即一个会话：在服务器频道中提及会打开一个线程，DM 频道本身就是一个线程。只有允许列表中的 Discord 用户 id 可以提示、审批或回答；其他用户都会被忽略并记录日志。线程映射以 JSON 形式持久化在 `dsh-home` 卷上，因此重启后旧线程仍然有效；mux 以指数退避重新打开，并按服务端请求 id 对宿主重放的待处理提示去重。

compose 服务共享 api 服务的网络命名空间（`network_mode: "service:api"`），与代理 sidecar 一样，因此机器人通过该命名空间的回环地址访问 API，无需新增受信主机即可通过 `/api` 的 Host 栅栏。它位于 `discord` compose profile 之后，因此没有 bot 令牌的栈仍能启动。bot 令牌是 `secrets/` 下的一个文件，与 GitHub 令牌一致；允许列表是 `.env` 中的普通配置。该应用放在 `apps/` 而非 `packages/`，因为它是一个没有可复用契约的组装件，而逐文件覆盖率门禁只作用于 `packages/*/*/src`。

## 考虑过的替代方案

**Host 内的 `dsh-discord` 插件。** 这是符合惯例的长期形态：它会直接驱动 `ctx.agents` 并在进程内回答 `approval/request`，如同 ACP 桥接。但它也会把第三方网关库绑进 Host 进程，并从第一次提交起就承担所有包门禁。先用现有网关的客户端验证消息映射和审批交互，提升为插件的路径仍然保留。

**通过 SDK 驱动 harness。** 客户端代码最简单，但每个机器人都会拥有一个 Web UI 看不到的运行时，而且 SDK 线路既没有审批流程也没有回合中取消，因此机器人只能使用 `never` 审批策略。

**通过 compose 网络按服务名访问 API。** 这会发送 `Host: api:8081`，除非 api profile 的 `trustedHosts` 声明它，否则栅栏会拒绝，而该 profile 是卷中的部署状态。共享命名空间让栅栏保持原样。

**把助手文本以消息编辑的方式流式输出。** 最接近 Web UI，但 Discord 会限制编辑频率，长回合会让机器人停滞。每条助手消息发一整条消息能让机器人保持在限制之内。

## 后果

允许列表上的任何人都能在 api 容器中运行代码，并借助挂载在那里的 GitHub 令牌以其账户推送。由于 WebSocket 载体不支持 `since`，重连路径会丢失流断开期间发出的事件；等待中的审批和提问是例外。Bash 调用依赖容器内可用的沙箱后端；在没有沙箱的地方，api 服务的 `workspace-write` 策略会让每次调用封闭失败，线程中会显示该失败。
