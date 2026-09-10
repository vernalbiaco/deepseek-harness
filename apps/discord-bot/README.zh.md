# @deepseek-ai/dsh-discord-bot

[English](README.md) | 中文

面向 dsh `api` 服务的 Discord 桥接。在频道中提及机器人会打开一个 Discord 线程和一个 harness 会话；此后该线程中的每条消息都会继续这个会话，而代理的工具调用、回答、审批请求和提问都会回帖到线程中。机器人是 `POST /api/<method>` 与 `/api/events.mux` WebSocket 的客户端，与 Web UI 使用同一套接口，因此它的会话也会出现在 Web UI 中。

## 运行

机器人需要一个带有 bot 用户的 Discord 应用，启用 **Message Content** intent，并以 View Channels、Send Messages、Send Messages in Threads、Create Public Threads 和 Read Message History 权限（权限整数 `309237713920`）邀请进服务器。

1. 把 bot 令牌写入与 `secrets/github-token` 同级的 `secrets/discord-token`（该文件已被 gitignore，并以只读方式绑定挂载）。
2. 在 `.env` 中把 `DISCORD_ALLOWED_USER_IDS` 设为允许驱动代理的 Discord 用户 id，以逗号分隔。
3. 在 api 服务旁启动它：`docker compose --profile discord up -d discord-bot`。

该服务共享 api 服务的网络命名空间，并通过该命名空间的回环地址访问 API，因此无需为它声明受信主机。当令牌文件或允许列表缺失，或对 api 服务的 `host.describe` 失败时，它会在启动时退出。

## 配置

| 变量 | 默认值 | 含义 |
|---|---|---|
| `DISCORD_TOKEN_FILE` | `/etc/dsh/secrets/discord-token` | 存放 bot 令牌的文件 |
| `DISCORD_ALLOWED_USER_IDS` | 必填 | 允许提示、审批和回答的 Discord 用户 id，以逗号分隔 |
| `DSH_API_URL` | `http://127.0.0.1:3081` | api 服务的基础 URL |
| `DSH_DISCORD_STATE_FILE` | `$DSH_HOME/discord-bot/threads.json` | 线程到会话的映射，重启后保留 |
| `DSH_SESSION_CWD` | api 服务的 cwd | 机器人创建的每个会话的工作目录 |

## 对话规则

- 在服务器频道中提及机器人会创建一个以该消息命名的线程和一个新会话；提及文本就是第一条提示。机器人拥有的线程中的消息会继续其会话。DM 频道本身就是一个线程。
- 来自允许列表之外用户的消息、按钮点击和菜单选择会被忽略并记录日志；点击的陌生人会收到一条仅自己可见的拒绝。
- 每条消息作为一条提示排队。`!cancel` 会中止正在运行的回合。
- 每次工具调用回帖一行，包含工具名和宿主的展示标题，或压缩后的参数摘要。失败的工具结果回帖其第一行。每条带文本的助手消息以文本回帖，按 2000 字符拆分。回合若因完成以外的任何原因结束，会回帖原因。
- 审批请求会回帖 Allow once 和 Reject 按钮；点击通过 `/api/respond` 作答，宿主确认后消息会被编辑以显示结果。每个 `ask_user_question` 选项列表都变成一个选择菜单；没有选项的问题由线程中的下一条消息回答；所有问题都有答案后才会发送。
- 流重新打开时仍在等待的审批和提问会由宿主重放，并且只回帖一次。

## 已知限制与待办

- **重连间隙会丢失事件** —— WebSocket 载体不支持 `since`，因此流断开期间宿主发出的内容不会重放，等待中的审批和提问除外。
- **仅支持文本提示** —— Discord 附件不会作为图片提示转发。
- **每个提问最多五个选项列表** —— Discord 每条消息最多允许五个组件行；更多的问题会显示出来，但无法通过菜单回答。
- **无关会话不可见** —— 只有机器人创建的会话会被投射；Web UI 的会话不会出现在 Discord 中。
- **Bash 需要容器内可用的沙箱** —— api 服务运行基础 bundle 的 `workspace-write` 策略，机器人只转达宿主的请求；在没有可用沙箱后端的地方，每次 bash 调用都会封闭失败并回帖该失败。
