# Agent Note: 以项目信任门控加载工作区声明的 MCP 服务器

Status: implemented

[English](2026-09-14-workspace-mcp-servers.md) | 中文

## 问题

MCP 服务器目前只能以 profile 层或 `--patch` 层中的 `@deepseek-ai/dsh-mcp-client` 行进入 Harness 进程。每一行都作用于整个进程：其工具注册在全局 `ctx.tools` 层，并到达每个工作区的每个会话。因此，一个进程服务多个工作区的 Web 部署无法为某个工作区提供专属服务器；已经带有 Claude Code `.mcp.json` 的项目，也必须先手工转换为 Cordis 行才能被 Harness 使用。

不加门控地加载工作区自带的服务器列表是不可接受的。stdio MCP 服务器是由 MCP SDK 在 agent（智能体）沙箱之外启动的可执行程序，而 HTTP 服务器会接收工作区数据和 bearer 凭据。[配置来源归属决策](2026-08-04-configuration-source-ownership.md)在不提示的情况下信任启动项目的路由与凭据，并指明会运行代码的已发现项目配置应由“后续的项目信任门控”处理。这样的门控目前并不存在：项目 skill、`AGENTS.md` 和项目 `.env` 值都会无条件加载，而现有插件中也没有任何一个会运行由工作区文件指定的程序。

## 决策

`@deepseek-ai/dsh-mcp-workspace` 是挂载在 base bundle 中的插件。它读取 `<规范化后的会话 cwd>/.mcp.json`，只有在工作区之外保存的用户决定允许时才接纳每个声明的服务器；同一工作区服务器由使用它的会话共享一个受监管连接，并把发现的工具注册到每个符合条件的 agent 自己的工具层上。配置、`.mcp.json` 支持表和日志行以[包 README](../../../../packages/mcp/mcp-workspace/README.md) 为准。

### 对 `@deepseek-ai/dsh-mcp-client` 的修改

`connection.ts` 中的监管器无需挂载插件即可复用。`startConnection(ctx, config, policy, options?)` 接收一个带三个成员的选项对象：

```ts
import type { Config, ToolDefinitions } from '@deepseek-ai/dsh-mcp-client'

interface ToolSink {
  replace(definitions: ToolDefinitions, failure: 'contain' | 'throw'): void
  clear(): void
}

interface ConnectionOptions {
  sink?: ToolSink
  resolveConfig?: () => Promise<Config>
  describeError?: (error: unknown) => string
}
```

`describeError` 为 `connection attempt failed` 与 `tool re-sync failed` 日志行渲染捕获的错误，因此替换凭据的调用方可以让凭据不进入日志。`fetchToolDefinitions` 读取完 `tools/list` 分页并构建定义，不触碰注册表；`createRegistrySink` 是默认 sink，执行先释放再注册的替换以及回滚。插件的 `apply` 不传入任何选项，行为保持不变。`resolveConfig` 在每次连接尝试之前运行，因此解析凭据占位符的调用方在重连时能拿到轮换后的值；其拒绝与连接失败一样计入重连预算。构建一次的定义可服务所有 agent：图片接纳在执行时通过 `ctx.get` 读取 `attachments` 与 `llm`，并通过 `exec.agent` 读取调用路由，而 `ctx.tools.register` 保存定义时不会修改它。`index.ts` 导出 `startConnection`、`resolveReconnectPolicy`、`RECONNECT_DEFAULTS`、`fetchToolDefinitions`、`createRegistrySink` 和 `publicToolName`，以及类型 `ConnectionHandle`、`ConnectionOptions`、`ConnectionOutcome`、`ToolSink`、`ToolDefinitions` 和 `ToolBridgeOptions`；构建入口列表不变。

### 包 `@deepseek-ai/dsh-mcp-workspace`

| 模块 | 职责 |
|---|---|
| `mcp-json.ts` | 把 `.mcp.json` 的 `mcpServers` 解析为 stdio（`command`、`args`、`env`）或 HTTP（`type: "http"`、`url`、`headers`）条目；拒绝无效服务器名、`sse`、`${NAME:-default}` 和字面密钥；在替换之前对每个条目按键排序后的 JSON 计算 `sha256:` 指纹 |
| `trust-store.ts` | 读写 `mcp-trust.yaml`：规范化工作区路径 → 服务器名 → `{ decision: allow \| deny, fingerprint, decidedAt }`，在 `withFileLock` 下以 `writeFileAtomic` 按模式 `0600` 写入；`lookupAllSync` 以一次读取供同步挂接使用 |
| `pool.ts` | 每个 `(工作区路径, 服务器名, 指纹)` 一个受监管连接，保存其当前定义集合以及通过其租约挂接的 agent 上下文；最后一个租约释放后关闭连接 |
| `binder.ts` | `agent/created` 处理器：同步挂接符合条件的 agent，之后执行 `.mcp.json` 读取、信任查询、凭据检查与提问，并在 agent 释放时释放租约 |
| `index.ts` | 插件装配、`Config` 与激活时的预连接 |
| `active-pools.ts` | 不变量伴随插件读取的进程级映射，从根上下文映射到存活的连接池；它通过 `Symbol.for` 取键，因此分别构建的 `index.js` 与 `invariant.js` 共享同一个映射 |
| `invariant.ts` | 在每个 `request/header` 时检查每个连接池挂接都属于一个存活的 agent，该 agent 规范化后的 cwd 等于挂接的工作区路径，且连接池为其报告的每个工具名都能为该 agent 解析 |
| `types.ts` | 解析后的条目与已声明服务器的类型 |

`Config` 字段：`trustFile`（必填；base bundle 行设置为 `!!js dshHomePath('mcp-trust.yaml')`）、`preconnect`（默认 `true`）、`preconnectTimeoutMs`（默认 `10000`）、`toolCallTimeoutMs`（默认 `60000`）以及 `reconnect`（`mcp-client` 的重连策略，加载时由 `resolveReconnectPolicy` 校验）。文件名 `.mcp.json` 属于外部格式，保持固定。`tsdown.config.ts` 把 `index.js` 与 `invariant.js` 构建为两个独立 bundle，因此发布的包不含共享 chunk。

### 工作区标识

工作区键是 `realpath(session.header.cwd)`。会话头不携带工作区 id，`dsh-workspace` 只由 Web bundle 挂载，而 Web 原始 `payload.cwd` 不会被主机规范化。键就是规范化后的 cwd 本身，而不是最近的 `.git` 祖先目录，这与 Claude Code 的项目 `.mcp.json` 和 Web 工作区路径一致。stdio 子进程以该规范化路径作为其 cwd 运行。

### 信任决定

每个服务器的决定按规范化路径、服务器名和指纹查找。匹配的 `allow` 会连接；匹配的 `deny` 直接跳过，不再提问；缺少条目或指纹变化时需要决定。指纹不包含解析后的凭据值，因此轮换令牌不会重新提问，而修改命令、参数、URL、env 或请求头模板或任何其他键都会重新提问。

每次挂接都会重新检查已保存的决定：`agent/created` 中的同步挂接、该 agent 读取 `.mcp.json` 之后的检查，以及异步挂接之前的即时检查。已保存的 `deny` 会从该 agent 撤下该服务器，并释放插件持有的预连接引用；缺少条目或指纹变化也会如此，除非该 agent 对该服务器持有“仅本会话允许”。`admits()` 只在当前指纹没有已保存决定时才接受会话内允许，因为已保存的 `deny` 是用户最新的决定。信任文件无法读取或无效时，会撤下所有服务器，包括会话内允许的服务器。

决定来自 `ctx.userQuestions.ask`，每个工作区路径与未决定指纹集合一个问题。问题列出所有未决定的服务器，包括其传输方式、命令与参数或 URL，以及通过 `ctx.credentials.describe` 报告为 `set` 或 `missing` 的每个引用凭据；该方法从不返回凭据值。选项为“对此工作区允许”（写入 `allow`）、“仅本会话允许”（只在内存中为提问的 agent 保存，该 agent 被释放或恢复、或进程重启后失效）和“拒绝”（写入 `deny`）。未决定集合相同的会话等待该待定问题；当提问者回答“仅本会话允许”或被释放，或提问提供方以 `ASK_ABORTED` 拒绝时，每个等待的会话各自提问，且不记录失败。缺少 `userQuestions` 服务或收到 `NO_PROVIDER` 拒绝表示当前界面没有提问 UI；未决定的服务器会被跳过，并记录为 `mcp-workspace(<name>): not approved; no question UI is available`。因此，headless、ACP 和 API 界面只加载已保存的 `allow` 决定。会话头带有 `origin: 'subagent'` 的 agent 会挂接已保存 `allow` 的服务器，但从不提问。

信任文件位于 `$DSH_HOME` 下，从不放在工作区中，因此项目无法批准自己的服务器。它不是 `settings.yaml` 的一个分节，因为部署可能禁用 settings 行，但仍需要已保存的决定。信任文件读写失败时，本次操作不接纳任何服务器并记录日志；不会默认允许。

### 凭据

`command`、`args`、`env`、`url` 和请求头值中的 `${NAME}` 占位符，在每次连接尝试之前通过 `ctx.credentials.resolve(credentialRef(NAME))` 解析，遵循进程环境、`$DSH_HOME/.credentials.yaml`、项目 `.env`、`$DSH_HOME/.env` 的凭据来源顺序。名称匹配 `@deepseek-ai/dsh-subprocess` 中 `SENSITIVE_ENV_PATTERN` 的 env 值，以及名称匹配该模式或为 `Authorization`、`Proxy-Authorization`、`Cookie` 的请求头值，必须包含占位符；否则该服务器被拒绝，日志只写服务器名和字段名，不写值。凭据未设置时跳过该服务器，记录 `mcp-workspace(<name>): credential <NAME> is not set`，且不启动连接。解析后的值从不进入问题、信任文件或日志：连接池传入 `describeError`，把它为该服务器解析过的每个值替换为对应的 `${NAME}` 占位符。stdio 子进程接收经过清理的父进程环境加上解析后的 `env`，与 `mcp-client` 子进程一致。

### 注册与 agent 资格

当 `ctx.agents.roots().includes(agent)` 且 agent 规范化后的 cwd 等于连接的工作区路径时，该 agent 获得工作区服务器的工具。该集合包含顶层会话和可继续的 subagent 子会话，不包含通过父 agent 上下文创建的一次性进程内子 agent。“仅本会话允许”只作用于提问的 agent。

在 `agent/created` 内的挂接是同步的：对于 binder 为该 agent 路径提供的、已发布工具、经 `readMcpJsonSync` 读取的该路径 `.mcp.json` 仍声明、且已保存决定（对所有此类连接通过一次 `lookupAllSync` 读取）仍为 `allow` 的每个连接，binder 获取一个租约并把它挂接到 agent 上下文；挂接位于 `agent.ctx.effect` 中，其清理会释放该 agent 拥有的所有租约。没有提供连接的路径两个文件都不读取。文件已不再声明的已提供连接会被撤销；文件缺失或无法读取、解析时，所有已提供连接都会被撤销。该 agent 的异步流程随后再次读取 `.mcp.json`，记录无法读取或解析的文件并将其视为未声明任何条目，并对文件已不再声明的条目撤下挂接、撤销已提供的连接。连接、提问和凭据解析在监听器返回后运行，其结果在后续步骤注册。当连接在 `tools/list_changed` 或重连后替换其定义集合时，连接池的 sink 会在每个已挂接 agent 上替换注册；某个 agent 上的注册失败会让该 agent 不保留该服务器的任何工具，并记录日志。挂接前，binder 用不带作用域的 `ctx.tools.get(name)` 检查是否存在同名全局工具，例如同一服务器名的 profile 级 `mcp-client` 行，并对每个路径与服务器记录一次警告；按注册表规定，agent 作用域工具会遮蔽全局工具。

不新增会话事件。工具定义只通过请求到达模型，而 agent loop（智能体循环）已经依据[可重建请求](2026-07-05-reconstructable-requests.md)，在 `request/header` 中以 `initial`、`resume` 或 `change` 原因记录可见工具集合。被跳过和被拒绝的服务器只报告到主机日志，从不进入提示词。

### 启动与首步可见性

agent loop 在 `publish` 内同步宣告 `agent/created`，而首次 `systemPrompt.assemble` 只在驱动器领取提示时运行。因此，在监听器内同步注册的工具会出现在首个请求中；在异步连接后注册的工具会在后续步骤出现，并产生原因为 `change` 的 `request/header`。

启用 `preconnect` 时，激活过程读取 `process.cwd()` 的 `.mcp.json`，并为每个带已保存 `allow` 且凭据已设置的服务器获取一个插件自有租约。`apply` 最多等待这些租约的首次连接尝试 `preconnectTimeoutMs`；更慢的连接在后台继续，任何预连接失败都不会使激活失败。激活还通过 `ctx.inject(['workspaceRegistry'], …)` 预连接注册表列出的每个工作区，包括在激活之后才挂载的注册表，但启动这些连接时不等待。只有进程 cwd 的服务器会在第一步之前被等待，最多 `preconnectTimeoutMs`。cwd 为已注册工作区的会话，在该连接已发布工具后，从第一步起可见预连接的工具；如果 ACP 客户端的 `session/new` cwd 既不是进程 cwd，也不是已连接的已注册工作区，其服务器通过该 agent 的异步接纳到达，可能在后续步骤才首次出现。插件自有租约一直持有，直到插件被释放或重新检查将其撤销。

### 主机就绪

只有当主机在 Loader 树稳定之后才回应其就绪请求时，启动期连接才有意义。ACP `initialize` 在协商之前等待 `ctx.get('loader')?.await()`，与 sdk/server `initialize`、headless `run` 和 web-app 就绪宣告一致，因此对进程 cwd 带已保存 `allow` 的工作区服务器在 ACP 上从第一步起可见。树加载失败时 `initialize` 被拒绝；没有 Loader 的上下文立即回应。

`acp-demo` 与 `jsonrpc-demo` 应用 bin 在 `boot` 的 `prepare` 回调中、在任何树条目挂载之前注册 stdin EOF 处理器（`jsonrpc-demo` 还注册 `SIGTERM` 与 `SIGINT`），因此启动期间的退出事件不会丢失；`acp-demo` 只在快照模式下注册 EOF 处理。第一个事件立即释放根上下文，而进程只在 `boot` 完成之后退出：事件中断启动时以该事件的退出码退出；真正的启动失败会使 `boot` 拒绝，并以非零码退出且输出其诊断信息。

### 失败处理

传输断开时保留最后一次定义集合的注册，此期间调用失败，并按配置的策略重连。重连预算耗尽时，sink 清除所有已挂接 agent 的注册，下一次获取该键时启动一次全新连接并保留现有挂接。`.mcp.json` 在会话挂接时和预连接时读取；插件不监视它，因此编辑会对该工作区的下一个会话生效，指纹变化会再次提问。agent 的流程会撤下其自身对文件已不再声明的条目的挂接，停止向后续 agent 提供这些连接，并释放这些连接上插件持有的预连接租约，因此不再有 agent 持有时每个连接都会关闭。插件释放时，释放所有租约，并通过监管器的有界关闭并行关闭所有连接。

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

## 后果

- 项目现有的 Claude Code `.mcp.json` 无需转换即可使用，一个 Web 进程也能为每个工作区提供各自的服务器。同一工作区中的会话为每个服务器共享一个子进程或 HTTP 连接，进程 cwd 已保存的服务器在所有界面上都出现在首个请求中。
- 首步可见性依赖 `agent/created` 在首次提示组装之前宣告。若 loop 修改为更早组装，工作区工具会推迟到第二步，而不会导致任何无关测试失败。
- 预连接在 `apply` 内运行，而 Cordis 只在 `apply` 返回后运行释放器。因此，当已批准的服务器始终不响应时，启动期间请求的关闭最多要等待 `preconnectTimeoutMs`。
- 已注册的 Web 工作区在预连接时不被等待，因此只有当连接在会话 agent 创建之前已发布工具时，这些工具才出现在首个请求中。
- ACP `initialize` 等待整个 Loader 树，因此始终无法稳定的条目也会阻塞 `initialize`。
- 批准后 stdio 服务器在沙箱之外启动；该决定授权的是一个未沙箱化的程序。
- 凭据缺失或端点不可达的已批准服务器只在主机日志中可见；没有任何用户界面显示提示。
- 决定按规范化路径保存，因此同一检出目录挂载在不同路径时需要分别决定，例如 Web 使用 `/workspaces/<name>`，容器运行使用 `/workspace`。
- 重新检查只在服务器挂接时运行，因此决定被删除或改为 `deny` 之后，运行中的 agent 会保留该服务器的工具，直到该 agent 被释放。
- 持有“仅本会话允许”的 agent 仍在连接某服务器时写入的 `deny`，会在挂接之前撤下该服务器；已经挂接该服务器的 agent 与其他运行中的 agent 一样，会保留其工具直到被释放。
- 运行中的 agent 会保留 `.mcp.json` 中被移除或修改的条目的工具，其连接保持打开，直到这些 agent 被释放。
- 在 `.mcp.json` 缺失或无法解析时（例如编辑进行到一半）创建的 agent，会撤销该工作区的所有已提供连接，因此除非另有 agent 持有，这些连接都会关闭；之后某个 agent 的接纳会重新连接它们，但不再带有预连接引用。
- agent 作用域工具会遮蔽同名全局工具，因此保留同一服务器 profile 级行的部署会打开两个连接，并只能依赖所记录的警告。
- 在 ACP 快照场景中，信任文件位于生成的工作区内，因为快照 harness 把 `DSH_HOME` 设置在那里；真实部署把它保存在所有工作区之外的 `$DSH_HOME` 中。
- `workspace-mcp-unapproved` 的 stderr 断言没有异步接纳流程的完成信号：harness 在 `prompt` 完成后关闭 stdin，该断言依赖跳过警告在此之前已经写出。

## 测试

- **单元测试：** `packages/mcp/mcp-client/tests/connection-options.spec.ts` 覆盖 `fetchToolDefinitions`、`createRegistrySink` 回滚、自定义 sink、每次尝试的 `resolveConfig`、`resolveConfig` 期间的释放以及 `stopped()`；现有 `mcp-client.spec.ts` 覆盖插件路径。在 `packages/mcp/mcp-workspace/tests` 中，`mcp-json.spec.ts` 覆盖解析、拒绝、占位符、指纹与两种读取；`trust-store.spec.ts` 覆盖往返读写、模式 `0600`、无效文档、并发记录与 `lookupAllSync`；`pool.spec.ts` 覆盖共享、挂接与解除挂接、凭据、重连预算耗尽与释放；`binder.spec.ts` 覆盖首步可见性、资格、决定与共享问题、失败、已保存决定的重新检查与释放；`invariant.spec.ts` 覆盖不变量伴随插件。
- **首步可见性：** `binder.spec.ts` 中的 "lists a preconnected server tool in the initial request header of an agent created afterwards" 断言原因为 `initial` 的 `request/header` 列出夹具工具。
- **就绪前释放：** `pool.spec.ts` 中的 "dispose settles during a connection first attempt" 与 "dispose settles after the child started and before the first attempt settles"，以及 `plugin.spec.ts` 中的 "settles fiber disposal requested while activation awaits a connecting server" 与 "…a silent server within preconnectTimeoutMs"。
- **组合：** `composition.spec.ts` 通过 Loader 启动 `tests/fixtures/composition.cordis.yml`，断言已保存 `allow` 的服务器工具出现在首个请求中，且其调用结果被记录。
- **端到端：** `mcp-workspace.e2e.ts` 证明两个根会话共享一个 stdio 子进程，`${MCP_FIXTURE_TOKEN}` 占位符从 `$DSH_HOME/.env` 解析并进入子进程环境，且两个会话都释放后子进程退出。
- **ACP 就绪：** `packages/acp/acp/tests/bridge.spec.ts` 中的 "answers initialize only after the Loader tree settles" 与 "rejects initialize when the Loader tree fails to settle"。
- **ACP 快照：** `examples/acp-agent` 的 `workspace-mcp` 场景为一个指向 `tests/fixtures/mcp-echo-server.mjs` 的生成 `.mcp.json` 写入已保存的 `allow`，并固定首步中带有 `mcp__fixture__echo` 的请求头与工具 schema。`workspace-mcp-unapproved` 场景没有决定；其请求头等于默认类别的固定值，`acp.snapshot.ts` 断言 stderr 行 `mcp-workspace(fixture): not approved; no question UI is available`。仅用于快照的 `tests/fixtures/stderr-log-exporter.ts` 行负责输出该行，因为未设置 `levels` 的 Cordis 导出器会丢弃 `warn`。
- **Web 快照：** `apps/web/tests/workspace-mcp-approval.e2e.ts` 断言问题输入区显示带有 `credentials: MCP_FIXTURE_TOKEN missing` 的服务器行，并将其固定在 `snapshots/workspace-mcp-approval/ui.expected.md` 中；随后设置凭据，选择“对此工作区允许”并提交，断言 `mcp-trust.yaml` 以模式 `0600` 记录 `allow`，并断言下一步调用 `mcp__fixture__echo` 且渲染其工具行。
