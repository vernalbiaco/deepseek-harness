# Agent Note：按 agent 挂载的 Workspace MCP 服务器

Status: implemented

[English](2026-09-15-workspace-mcp-servers-per-agent.md) | 中文

## 问题

MCP 服务器只能以 profile、`--patch` 层或 ACP `mcpServers` 请求中的 `@deepseek-ai/dsh-mcp-client` 配置行进入 Harness 进程。profile 配置行作用于整个进程，因此服务多个 workspace 的 Web 部署无法为某个 workspace 提供专属服务器，已随附 Claude Code `.mcp.json` 的项目也必须手动转换为 Cordis 配置行。不经把关就加载 workspace 的服务器列表是不可接受的：stdio 服务器是在 agent 沙箱之外启动的可执行程序，HTTP 服务器会收到 workspace 数据与 bearer 凭据。

## 决定

`@deepseek-ai/dsh-mcp-workspace` 挂载在基础组合包中。对每个带会话 cwd 的根 agent，它读取 `<规范化 cwd>/.mcp.json`，只通过存入 `$DSH_HOME/mcp-trust.yaml` 或仅对一个会话生效的用户决定准入每台已声明的服务器，并在该 agent 的上下文中为每台获准服务器挂载一个 `dsh-mcp-client` 实例。[包 README](../../../../packages/mcp/mcp-workspace/README.zh.md) 负责配置、`.mcp.json` 支持、问题与日志约定。

- **挂载。** `agent/created` 是 serial 事件，会在 agent 首个步骤之前被等待。监听器挂载已保存 `allow` 的服务器，并最多等待 `admissionTimeoutMs` 让其完成首次连接尝试后返回；未决定服务器的问题在此之后进行，并在后续步骤挂载。`dsh-mcp-client` 按注册作用域保留 `serverName`，因此同一 workspace 中的 agent 可以各自挂载同名服务器，ACP 的按会话挂载也遵循同一模型。
- **信任。** 决定以规范化路径、服务器名，以及占位符替换之前条目的指纹为键。每次挂载都会重新读取已存决定；已存的 `deny` 优先于 Allow this session。
- **凭据。** `${NAME}` 占位符在每次挂载时通过 `ctx.credentials` 解析一次。敏感的 env 与请求头字段必须使用占位符。
- **生命周期。** 已挂载的服务器是 agent 上下文的子插件，随 agent 停止；插件销毁时卸载它挂载的所有服务器。
- **Invariant 伴随插件。** 不发布：agent 与服务器的关系就是 Cordis fiber 树本身，不存在可独立观测的第二份记录。

## 考虑过的替代方案

**每台 workspace 服务器共享一个连接。** 最初的实现保留在本地 `master-backup` 分支上，它为每个 `(workspace, server, fingerprint)` 汇集一个受监管的连接，并把其工具发布给每个已接入的 agent。它需要 `dsh-mcp-client` 的监管器支持可插拔的工具接收端、逐次尝试的配置解析、错误脱敏与停止信号。上游 `dsh-mcp-client` 随后为该监管器加入了资源与服务器指令，变基该分叉时反复冲突。共享连接可以节省子进程，并在每次重连时解析凭据，但并非把服务器限定在 workspace 范围所必需，而且重复了 agent 上下文已经提供的生命周期跟踪。

**通过 `AgentSetup` 挂载。** ACP 在 `ctx.agents.create` 的 `setup` 回调中挂载服务器。该回调属于创建 agent 的调用方，因此基础组合包中的插件无法借此为 Web、headless 或 subagent 调用方创建的 agent 提供服务器。

**在 `agent/created` 中提问。** 在 serial 监听器运行期间等待用户回答，会让会话创建阻塞在一个客户端尚无法显示其会话的问题上。

## 影响

- 同一 workspace 中的 N 个会话会运行每台 stdio 服务器的 N 份副本。
- 轮换后的凭据只会到达之后创建的 agent，且 `dsh-mcp-client` 的失败日志行不做脱敏。
- workspace 服务器提供资源与服务器指令的方式与 profile 配置行完全相同。
- 同一 agent 上同名的 ACP `mcpServers` 条目与 workspace 服务器会冲突；workspace 挂载记录为失败，ACP 服务器保留。
