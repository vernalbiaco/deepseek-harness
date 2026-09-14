# Agent Note: 以项目信任门控加载工作区声明的 MCP 服务器

Status: proposed

[English](2026-09-14-workspace-mcp-servers.md) | 中文

## 问题

MCP 服务器目前只能以 profile 层或 `--patch` 层中的 `@deepseek-ai/dsh-mcp-client` 行进入 Harness 进程。每一行都作用于整个进程：其工具注册在全局 `ctx.tools` 层，并到达每个工作区的每个会话。因此，一个进程服务多个工作区的 Web 部署无法为某个工作区提供专属服务器；已经带有 Claude Code `.mcp.json` 的项目，也必须先手工转换为 Cordis 行才能被 Harness 使用。

不加门控地加载工作区自带的服务器列表是不可接受的。stdio MCP 服务器是由 MCP SDK 在 agent（智能体）沙箱之外启动的可执行程序，而 HTTP 服务器会接收工作区数据和 bearer 凭据。[配置来源归属决策](../../implemented/architecture/2026-08-04-configuration-source-ownership.md)在不提示的情况下信任启动项目的路由与凭据，并指明会运行代码的已发现项目配置应由“后续的项目信任门控”处理。这样的门控目前并不存在：项目 skill、`AGENTS.md` 和项目 `.env` 值都会无条件加载，而现有插件中也没有任何一个会运行由工作区文件指定的程序。

## 提案

新增挂载在 base bundle 中的插件 `@deepseek-ai/dsh-mcp-workspace`。它读取 `<规范化后的会话 cwd>/.mcp.json`，只有在工作区之外保存的用户决定允许时才接纳每个声明的服务器；同一工作区服务器由使用它的会话共享一个受监管连接，并把发现的工具注册到每个符合条件的 agent 自己的工具层上。

### 对 `@deepseek-ai/dsh-mcp-client` 的修改

`connection.ts` 中的监管器无需挂载插件即可复用。`startConnection` 接收一个带两个成员的选项对象：

```ts
interface ToolSink {
  replace(definitions: ReadonlyMap<string, ToolDefinition>, failure: 'contain' | 'throw'): void
  clear(): void
}

interface ConnectionOptions {
  sink?: ToolSink
  resolveConfig?: () => Promise<Config>
}
```

`syncTools` 拆分为 `fetchToolDefinitions` 和默认注册表 sink：前者读取完 `tools/list` 分页并构建定义，不触碰注册表；后者执行现有的先释放再注册的替换以及回滚。插件的 `apply` 不传入任何选项，行为保持不变。`resolveConfig` 在每次连接尝试之前运行，因此解析凭据占位符的调用方在重连时能拿到轮换后的值。构建一次的定义可服务所有 agent：图片接纳在执行时通过 `ctx.get` 读取 `attachments` 与 `llm`，并通过 `exec.agent` 读取调用路由，而 `ctx.tools.register` 保存定义时不会修改它。`index.ts` 导出 `startConnection`、`resolveReconnectPolicy`、`fetchToolDefinitions`、`publicToolName`、`ToolSink` 和 `ConnectionOptions`；构建入口列表不变。

### 包 `@deepseek-ai/dsh-mcp-workspace`

| 模块 | 职责 |
|---|---|
| `mcp-json.ts` | 把 `.mcp.json` 的 `mcpServers` 解析为 stdio（`command`、`args`、`env`）或 HTTP（`type: "http"`、`url`、`headers`）条目；拒绝无效服务器名、`sse`、`${NAME:-default}` 和字面密钥；在替换之前对每个条目的规范 JSON 计算 SHA-256 指纹 |
| `trust-store.ts` | 读写 `mcp-trust.yaml`：规范化工作区路径 → 服务器名 → `{ decision: allow \| deny, fingerprint, decidedAt }`，在 `withFileLock` 下以 `writeFileAtomic` 按模式 `0600` 写入 |
| `pool.ts` | 每个规范化工作区路径一个条目，保存每个已接纳服务器的一个受监管连接、其当前定义集合及已挂接的 agent；引用计数在最后一次释放后关闭连接 |
| `binder.ts` | `agent/created` 监听器：同步挂接符合条件的 agent，启动异步连接与提问，并在 agent 释放时解除挂接 |
| `index.ts` | 插件装配、`Config` 与激活时的预连接 |
| `invariant.ts` | 包不变量伴随插件检查的连接池数据关系 |

`Config` 字段：`trustFile`（base bundle 行设置为 `!!js dshHomePath('mcp-trust.yaml')`）、`preconnect`（默认 `true`）、`preconnectTimeoutMs`（默认 `10000`）、`toolCallTimeoutMs`（默认 `60000`）以及 `reconnect`（`mcp-client` 的重连策略）。文件名 `.mcp.json` 属于外部格式，保持固定。

### 工作区标识

工作区键是 `realpath(session.header.cwd)`。会话头不携带工作区 id，`dsh-workspace` 只由 Web bundle 挂载，而 Web 原始 `payload.cwd` 不会被主机规范化。键就是规范化后的 cwd 本身，而不是最近的 `.git` 祖先目录，这与 Claude Code 的项目 `.mcp.json` 和 Web 工作区路径一致。

### 信任决定

每个服务器的决定按规范化路径、服务器名和指纹查找。匹配的 `allow` 会连接；匹配的 `deny` 直接跳过，不再提问；缺少条目或指纹变化时需要决定。指纹不包含解析后的凭据值，因此轮换令牌不会重新提问，而修改命令、参数、URL 或请求头模板会重新提问。每次挂接都会重新检查已保存的决定，包括预连接服务器的同步挂接；`deny`、指纹变化、没有“仅本会话允许”时缺少条目，或信任文件无法读取，都会从该 agent 撤下该服务器并释放插件持有的引用。

决定来自 `ctx.userQuestions.ask`：每个工作区一个问题，列出所有未决定的服务器，包括其传输方式、命令与参数或 URL，以及通过 `ctx.credentials.describe` 报告为已设置或缺失的每个所需凭据；该方法从不返回凭据值。选项为“对此工作区允许”（写入 `allow`）、“仅本会话允许”（只在内存中为该 agent 保存，恢复或重启后失效）和“拒绝”（写入 `deny`）。每个工作区路径与指纹集合同时只存在一个待定问题；该工作区中的其他会话等待其结果。释放提问的 agent 会中止该问题，下一个会话会再次提问。`NO_PROVIDER` 表示当前界面没有提问 UI；未决定的服务器会被跳过并记录日志。因此，headless、ACP 和 API 界面只加载已保存的 `allow` 决定。

信任文件位于 `$DSH_HOME` 下，从不放在工作区中，因此项目无法批准自己的服务器。它不是 `settings.yaml` 的一个分节，因为部署可能禁用 settings 行，但仍需要已保存的决定。信任文件读写失败时，本次操作不接纳任何服务器并记录日志；不会默认允许。

### 凭据

`command`、`args`、`env`、`url` 和请求头值中的 `${NAME}` 占位符，在每次连接尝试之前于 `resolveConfig` 内通过 `ctx.credentials.resolve(credentialRef(NAME))` 解析，遵循进程环境、`$DSH_HOME/.credentials.yaml`、项目 `.env`、`$DSH_HOME/.env` 的凭据来源顺序。名称匹配 `@deepseek-ai/dsh-subprocess` 中 `SENSITIVE_ENV_PATTERN` 的 env 值，以及名称匹配该模式或为 `Authorization`、`Proxy-Authorization`、`Cookie` 的请求头值，必须包含占位符；否则该服务器被拒绝，日志只写服务器名和字段名，不写值。缺失凭据会跳过该服务器，并记录一行指明引用名的日志。解析后的值从不进入日志、问题或信任文件。stdio 子进程接收经过清理的父进程环境加上解析后的 `env`，与现有 `mcp-client` 子进程一致。

### 注册与 agent 资格

当 `ctx.agents.roots().includes(agent)` 且 agent 规范化后的 cwd 等于连接池条目路径时，该 agent 获得工作区服务器的工具。该集合包含顶层会话和可继续的 subagent 子会话，不包含通过父 agent 上下文创建的一次性进程内子 agent。只有会话头中没有 `origin: 'subagent'` 的 agent 会被询问决定。“仅本会话允许”只作用于提问的 agent。

在 `agent/created` 内的挂接是同步的：对于每个拥有当前定义集合的服务器，binder 在 `agent.ctx.effect` 中为每个定义调用 `agent.ctx.tools.register`，该 effect 的清理也会释放连接池引用。连接、提问和凭据解析在监听器返回后运行，其结果在后续步骤注册。当连接在 `tools/list_changed` 或重连后替换其定义集合时，连接池的 sink 会在每个已挂接 agent 上替换注册；某个 agent 上的失败会让该 agent 不保留该服务器的任何工具，并记录日志。注册前，binder 用不带作用域的 `ctx.tools.get(name)` 检查是否存在同名全局工具，例如同一服务器名的 profile 级 `mcp-client` 行，并对每个路径与服务器记录一次警告；按注册表规定，agent 作用域工具会遮蔽全局工具。

不新增会话事件。工具定义只通过请求到达模型，而 agent loop（智能体循环）已经依据[可重建请求](../../implemented/architecture/2026-07-05-reconstructable-requests.md)，在 `request/header` 中以 `initial`、`resume` 或 `change` 原因记录可见工具集合。被跳过和被拒绝的服务器只报告到主机日志，从不进入提示词。

### 启动与首步可见性

agent loop 在 `publish` 内同步宣告 `agent/created`，而首次 `systemPrompt.assemble` 只在驱动器领取提示时运行。因此，在监听器内同步注册的工具会出现在首个请求中；在异步连接后注册的工具会在后续步骤出现，并产生原因为 `change` 的 `request/header`。启用 `preconnect` 时，激活过程会为 `process.cwd()` 以及通过 `ctx.inject(['workspaceRegistry'], …)` 获得的每个已注册 Web 工作区，连接所有带已保存 `allow` 的服务器，并在插件生命周期内为每个条目持有一个插件自有引用。激活最多等待这些连接 `preconnectTimeoutMs`；更慢的连接在后台继续，任何预连接失败都不会使激活失败。因此，预连接的服务器在所有界面上从第一步起可见，只有在会话中途被接纳的服务器会稍后加入。

第一个 binder 测试必须证明：在预连接之后创建的 agent，其原因为 `initial` 的 `request/header` 已列出 `mcp__fixture__*`。如果该顺序不成立，本提案退化为每个会话一个连接，并且必须先修订本注记再继续实现。

### 失败处理

传输断开时保留最后一次定义集合的注册，此期间调用失败，并按配置的策略重连。重连预算耗尽时，sink 清除所有已挂接 agent 的注册，下一个挂接的会话会启动一次全新连接。`.mcp.json` 在会话挂接时和预连接时读取；插件不监视它，因此编辑会对该工作区的下一个会话生效；指纹变化会再次提问，而旧连接会保留到其最后一个引用被释放。插件释放时，通过监管器的有界关闭并行关闭所有连接。

### 覆盖与文档

单元测试为新包和被修改的 `mcp-client` 模块满足逐文件覆盖率门禁。无需密钥的端到端测试复用现有 stdio `fixture-server.ts`，证明同一工作区中的两个 agent 共享一个子进程、该进程在最后一次释放后退出，并证明 `${TOKEN}` 到达子进程环境。`examples/acp-agent` 新增一个场景：其提交的 `workspace/.mcp.json` 指向夹具服务器，并由 `prepareWorkspace` 写入 `allow`，以证明工具在第一步可见；另一个没有决定的场景中，工具 schema 不包含该工具。`apps/web/tests/snapshots` 新增一个场景：问题列出服务器及其凭据状态，“对此工作区允许”写入信任文件，并在下一步调用该工具。文档更新新包 README、`mcp-client` README 中的库用法小节、CLI 参考中“默认不启用 MCP 服务器”的说明以及 base bundle README，并同步各自的中文对侧。

## 曾考虑的替代方案

**每个会话一个连接。** 每个 agent 各自启动监管器，无需连接池或 sink 拆分。每个会话都会错过第一步，工具到达时付出一次提示词缓存未命中，并为每个会话启动一个 stdio 子进程；headless 任务始终在没有这些工具的情况下开始。

**在 `dsh-mcp-client` 内增加工作区模式。** 这样一个插件将同时承担两种信任与生命周期规则不同的角色：由配置接纳的运维人员指定行，以及由用户决定接纳的工作区发现服务器。

**自动信任工作区文件。** 这与项目 skill 和 `AGENTS.md` 一致，但它们只是提示词文本。克隆仓库中的 stdio 条目会在该处打开会话时立即运行未沙箱化的程序。

**自动接纳 HTTP，仅对 stdio 提问。** HTTP 服务器不运行本地代码，但仍会接收工作区数据和凭据。

**只通过设置页面做决定。** 会话中不再提问，但每个新工作区都需要先单独访问设置页面，其服务器才能工作。

**把决定保存在 `settings.yaml` 或 `storageDomain` 中。** 部署可以禁用 settings 行，而 `storageDomain` 只由 Web bundle 挂载，因此 headless 运行看不到在 Web UI 中做出的决定。

**接受 `.mcp.json` 中的字面令牌。** 现有文件无需修改即可工作，但提交到仓库的密钥会变成受支持的配置。

**使用 `.dsh/mcp/` 目录中的 YAML 条目。** 它能暴露每个 `mcp-client` 选项，但 Claude Code 不会读取，项目需要维护两份服务器列表。

**按工作区使用 `--patch` 层。** 在每个工作区一个进程时可行，例如 headless 运行；但服务多个工作区的 Web 进程会把每个 patch 行应用到所有会话。

## 验收标准

- 在带有未决定 `.mcp.json` 服务器的工作区中，Web 会话显示一个列出服务器及其凭据状态的问题；“对此工作区允许”写入 `mcp-trust.yaml`，该服务器的工具在下一步可调用。
- 在带有已保存 `allow` 的工作区中，预连接后创建的 agent 在其原因为 `initial` 的 `request/header` 中包含该服务器的工具。
- 同一工作区中的两个根 agent 共享一个 stdio 子进程，两者都释放后该进程退出。
- 一次性进程内子 agent 不获得工作区工具；同一工作区中的可继续子会话获得这些工具。
- headless 与 ACP 会话加载已保存的 `allow` 决定，跳过未决定的服务器并记录日志，不会提问。
- 敏感 env 或请求头字段中的字面密钥会导致该服务器被拒绝，指纹变化会再次提问。
- 全局 `mcp-client` 插件行为不变；其现有测试无需修改即可通过。
- 限定到两个包的 `pnpm run test:coverage`、`typecheck`、`lint`、`duplication`、`hygiene`、`doc-sync` 以及新的快照场景全部通过。

## 风险

- 首步可见性依赖 `agent/created` 在首次提示组装之前宣告。未来若 loop 修改为更早组装，工作区工具会在无提示的情况下推迟到第二步。
- 批准后 stdio 服务器仍在沙箱之外启动；该决定授权的是一个未沙箱化的程序。
- 凭据缺失或端点不可达的已批准服务器只在主机日志中可见；Web UI 没有对应提示。
- 决定按规范化路径保存，因此同一检出目录挂载在不同路径时需要分别决定，例如 Web 使用 `/workspaces/<name>`，容器运行使用 `/workspace`。
- agent 作用域工具会遮蔽同名全局工具，因此保留同一服务器 profile 级行的部署会打开两个连接，并只能依赖所记录的警告。
