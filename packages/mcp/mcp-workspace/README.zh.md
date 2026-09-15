---
description: "面向部署方与维护者的 workspace .mcp.json 服务器说明，用于审批、挂载或排查按 workspace 声明、由每个符合条件的 agent 通过自己的 dsh-mcp-client 实例连接的 MCP 服务器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-workspace

[English](README.md) | 中文

## 概述

`dsh-mcp-workspace` 让 workspace 在 Claude Code 格式的 `.mcp.json` 文件中声明 MCP 服务器。已声明的服务器只有在用户作出决定后才会连接：该决定可为整个 workspace 存入 `$DSH_HOME/mcp-trust.yaml`，也可只对一个会话生效。每个符合条件的 agent 为每台获准的服务器挂载自己的 [`dsh-mcp-client`](../mcp-client/README.zh.md) 实例，因此服务器的工具、资源与指令归属该 agent，并随其停止。已保存的决定在 agent 的首次模型请求之前完成挂载；会话中才作出决定的服务器会在后续步骤出现。Headless、ACP 与 API 界面只加载已保存的 `allow` 决定。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[基础组合包](../../bundle/base/README.zh.md)已挂载本插件，因此每个 `dsh` profile 都会读取 workspace 的 `.mcp.json` 文件。只有在不含基础组合包的组合中才需要自行添加配置行。

### 最小配置

```yaml
- id: mcp-workspace
  name: '@deepseek-ai/dsh-mcp-workspace'
  config:
    trustFile: !!js dshHomePath('mcp-trust.yaml')
```

workspace 以 Claude Code 的 `.mcp.json` 格式声明服务器。密钥使用 `${NAME}` 凭据引用，绝不写字面值：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_MCP_TOKEN}" }
    }
  }
}
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `trustFile` | 必填 | 保存各 workspace 决定的信任文档绝对路径；不得位于任何 workspace 内 |
| `admissionTimeoutMs` | `10,000` | 创建 agent 时等待已保存 `allow` 服务器首次连接尝试的最长时间，最大 2147483647 |
| `toolCallTimeoutMs` | `60,000` | 每台 workspace 服务器单次工具调用或资源请求的超时，最大 2147483647 |
| `reconnect.enabled` | `true` | 连接丢失后自动重连 |
| `reconnect.initialDelayMs` | `500` | 首次重连延迟；每次连续失败后翻倍 |
| `reconnect.maxDelayMs` | `30,000` | 退避上限；连接持续超过该时长后重置尝试预算 |
| `reconnect.maxAttempts` | `10` | 每次中断中停止连接前允许的连续失败次数 |

`reconnect` 的默认值与取值范围与 `dsh-mcp-client` 相同；超出范围的策略会让插件在加载时失败。文件名 `.mcp.json` 固定不变。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-workspace)列出全部可接受字段。

### `.mcp.json` 支持

文件必须是包含 `mcpServers` 对象的 JSON 对象；否则整个文件记录为不可用，其中的服务器一律不获准。每个条目独立解析；被拒绝的条目会连同服务器名与原因记录日志，但绝不记录字段值。

| 条目 | 支持情况 |
|---|---|
| stdio：`command`，可选 `args` 与 `env`，`type` 缺省或为 `"stdio"` | 支持；子进程以规范化的 workspace 路径为 cwd，使用清洗后的父进程环境加上解析后的 `env` |
| HTTP：`type: "http"`、`url`，可选 `headers` | 通过 Streamable HTTP 支持 |
| `type: "sse"` | 拒绝 |
| 服务器名不符合 `[A-Za-z0-9_-]{1,32}`，`command` 或 `url` 不是字符串，`args` 不是字符串数组，或 `env`/`headers` 不是字符串映射 | 拒绝 |

- **占位符**——`${NAME}`（`NAME` 匹配 `[A-Za-z_][A-Za-z0-9_]*`）可出现在 `command`、`args`、`env` 值、`url` 与请求头值中。其他任何 `${` 序列（包括 `${NAME:-default}`）都会拒绝该服务器。
- **敏感字段**——名称匹配 `KEY`、`PASSWORD`、`SECRET` 或 `TOKEN`（不区分大小写）的 `env` 值，以及名称匹配该模式或为 `Authorization`、`Proxy-Authorization`、`Cookie` 的请求头值，必须包含占位符；字面值会拒绝该服务器。
- **指纹**——每个条目的指纹是对其键排序后的 JSON 计算的 `sha256:<hex>`，在替换之前计算，并包含本解析器忽略的键。修改命令、参数、URL、env 或请求头模板或任何其他键都会改变指纹；轮换凭据值不会。

### 信任决定

每台已声明的服务器按其规范化 workspace 路径、服务器名与当前指纹所存的决定获准。匹配的 `allow` 挂载该服务器，匹配的 `deny` 直接跳过且不询问；缺少条目或条目属于其他指纹时需要作出决定。

不是 subagent 来源根 agent 的符合条件 agent 会提出一个问题，列出每台未决定的服务器：传输方式、命令与参数或 URL（为空或含空白、双引号或控制字符时以 JSON 引号括起），以及每个被引用凭据的 `set` 或 `missing` 状态。每个 workspace 路径及未决定服务器名与指纹的集合只挂起一个问题；未决定集合相同的会话等待其答案。若提问 agent 选择 Allow this session 或被销毁，或问题 UI 中止了问题，每个等待中的会话会各自提问。

| 选项 | 效果 |
|---|---|
| Allow for this workspace | 为列出的每台服务器记录 `allow`，并挂载到每个等待中的 agent |
| Allow this session | 只把列出的服务器挂载到提问 agent；不记录任何内容，该许可在该 agent 被销毁、恢复或进程重启时结束 |
| Deny | 为列出的每台服务器记录 `deny` |

没有可用的问题 UI 时，未决定的服务器会被跳过，并记录为 `mcp-workspace(<name>): not approved; no question UI is available`。每次挂载前都会重新读取已存决定：已存的 `deny`（即使该 agent 持有 Allow this session）或无法读取的信任文件都不会挂载任何服务器。无法读取或无效的信任文件不准入任何服务器，包括本会话已允许的服务器。

### 信任文件

基础组合包把决定存入 `$DSH_HOME/mcp-trust.yaml`，绝不写入 workspace，因此项目无法批准自己的服务器。写入时持有跨进程文件锁，并以 `0600` 模式原子替换文件：

```yaml
version: 1
workspaces:
  /home/user/projects/app:
    github:
      decision: allow
      fingerprint: sha256:3f1c…
      decidedAt: '2026-09-15T08:00:00.000Z'
```

要撤销决定，删除该服务器的条目，或删除该 workspace 的条目以撤销其全部服务器；在有问题 UI 的界面上，该 workspace 的下一个会话会再次询问。设置 `decision: deny` 会不经询问直接跳过该服务器。

### 凭据

`${NAME}` 占位符在服务器挂载时通过 `ctx.credentials` 解析，因此适用 [`dsh-credentials-local`](../../credentials/credentials-local/README.zh.md) 的来源顺序：继承的环境变量、`$DSH_HOME/.credentials.yaml`、调用目录的 `.env`，然后是 `$DSH_HOME/.env`。被引用凭据未设置的服务器会被跳过，并记录日志 `mcp-workspace(<name>): credential <NAME> is not set`，不挂载任何内容。解析后的值绝不进入问题或信任文件，本包自己的日志行会把它们替换为 `${NAME}` 占位符。

### 会话与界面

agent 符合条件的前提是：它是根 agent（`ctx.agents.roots()`，即创建时没有存活父 agent 的 agent），且其会话头带有 cwd。其规范化 cwd 即 workspace 路径。以父 agent 创建的子 agent 不会获得自己的服务器。subagent 来源的根 agent 挂载已保存的 `allow` 服务器，但从不提问。

| 界面 | 未决定的服务器 |
|---|---|
| Web | 会话显示决定问题 |
| Headless、ACP、API | 跳过并记录日志；只挂载已保存的 `allow` 决定 |

### 启动、挂载与销毁

`agent/created` 是 serial 事件，agent 创建会在 agent 首个步骤之前等待其完成。本插件的监听器读取 `.mcp.json`，查询每条已存决定，挂载每台已保存 `allow` 的服务器，并最多等待 `admissionTimeoutMs` 让它们完成首次连接尝试；较慢的服务器会继续连接，其工具会在后续步骤随原因为 `change` 的 `request/header` 出现。workspace 服务器绝不会让 agent 创建失败。未决定服务器的问题在监听器返回之后进行。

每次挂载是 agent 上下文中的一个 `dsh-mcp-client` 实例：`serverName` 设为 `.mcp.json` 中的名称，`failOnStartupError: false`，并使用所配置的超时与重连策略。因此每台获准的服务器在该 agent 下各有一个 stdio 子进程或 HTTP 连接；销毁 agent 会停止它们，销毁本插件会卸载它挂载的所有服务器。同一 agent 上已挂载的同名服务器（例如同名的 ACP `mcpServers` 条目）会让 workspace 挂载失败，并记录为 `mcp-workspace(<name>): failed to mount: …`。agent 的准入流程结束时（包括没有准入任何服务器时），插件发出内存事件 `mcp-workspace/binding-settled`，载荷为 `{ agent }`；它绝不进入模型或会话日志。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计理念

- **agent 拥有自己的服务器。** workspace 服务器是 agent 上下文的子插件，因此其工具、资源、指令与传输共享 agent 的作用域与生命周期，无需单独的引用计数。
- **决定存放在 workspace 之外。** 只有用户的回答会写入信任文件，而每次挂载都会重新读取它，因此项目本身或过期的内存答案都无法准入服务器。
- **创建过程中不等待人工操作。** 已保存的决定在 `agent/created` 内生效；问题只在 agent 发布之后才等待回答。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、重连校验、`agent/created` 接线、`binding-settled` 事件声明 |
| [`src/binder.ts`](src/binder.ts) | 按 agent 准入：读取 `.mcp.json`、查询决定、共享问题、解析凭据、挂载 `mcp-client` |
| [`src/mcp-json.ts`](src/mcp-json.ts) | `.mcp.json` 解析、拒绝规则、指纹与占位符替换 |
| [`src/trust-store.ts`](src/trust-store.ts) | `mcp-trust.yaml` 读取与加锁原子写入 |
| [`src/types.ts`](src/types.ts) | 解析后条目与已声明服务器的类型 |
| — | 不发布运行时 invariant 伴随插件：每台已挂载的服务器都是其 agent 上下文的子插件，因此在 Cordis fiber 树之外不存在可独立观测的 workspace 与 agent 关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Workspace MCP 服务器 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-15-workspace-mcp-servers-per-agent.zh.md)——按 agent 挂载的决定及考虑过的替代方案。
- [`dsh-mcp-client` README](../mcp-client/README.zh.md)——每台已挂载服务器的工具命名、重连、资源与服务器指令。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-workspace)——每个可接受的配置字段及其源码声明。

-----

<a id="model-experience"></a>
## 模型体验

### Workspace MCP 工具

#### 模型看到什么

符合条件的 agent 会把挂载在它上面的每台服务器的每个工具视为原生工具，名称为 `mcp__<serverName>__<rawName>`（或其确定性规范化形式），并带有服务器提供的描述与输入 schema。在 `admissionTimeoutMs` 内完成连接的已保存 `allow` 服务器，其工具出现在首次请求中；之后才获准或连接的服务器，其工具会在后续步骤随原因为 `change` 的 `request/header` 出现。问题、被跳过的服务器与被拒绝的条目绝不会进入模型。

#### Token 影响

工具注册期间，每次请求都要支付与数据相关的 schema 成本。重新同步会替换而非累积 schema，服务器限定名称会为每个工具定义与调用增加 token。

#### KV Cache 影响

当 agent 的 workspace 工具集合与 schema 不变时前缀保持稳定。会话中加入的服务器，或新增、移除、重命名、修改工具的重新同步，会替换工具定义，并可能从第一个变化的 schema token 起使复用失效。

### 工具调用历史、结果与服务器指令

#### 模型看到什么

调用、结果与服务器指令的呈现方式与 [`dsh-mcp-client`](../mcp-client/README.zh.md#model-experience) 服务器完全相同，因为每台 workspace 服务器都是作用于该 agent 的 `dsh-mcp-client` 实例。

#### Token 影响

与 `dsh-mcp-client` 相同：参数、映射后的文本与持久图片引用会保留到压缩为止，服务器指令在每次请求中增加提示词文本。

#### KV Cache 影响

工具调用与结果只追加。重连时发生变化的服务器指令会改变下一次组装的系统消息及其可复用前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每个 agent 的每台服务器各一个连接**——workspace 中每个符合条件的会话都会为每台获准服务器启动自己的 stdio 子进程或 HTTP 连接，因此 N 个会话会运行 N 份 stdio 服务器。
- **凭据在每次挂载时解析一次**——轮换后的凭据只会到达轮换之后创建的 agent 中的服务器；重连沿用挂载时解析的值。
- **`dsh-mcp-client` 的失败日志不做脱敏**——`dsh-mcp-client` 记录的连接与重新同步失败行包含错误文本，其中可能含有被替换进 URL、参数或请求头的已解析凭据值；只有本包自己的日志行会替换已解析的值。
- **撤销的决定不会影响运行中的 agent**——决定在每次挂载前读取，因此已挂载某服务器的 agent 会保留它直到被销毁。
- **决定以规范化路径为键**——同一份检出挂载在两个路径（例如 Web workspace 与容器挂载）时，每个路径都需要单独的决定。
- **不监视 `.mcp.json`**——修改在该 workspace 创建下一个 agent 时生效，指纹变化会再次询问；运行中的 agent 保留已挂载的服务器。
- **获准的 stdio 服务器在沙箱之外运行**——该决定授权的是一个带清洗后父进程环境、未经沙箱隔离的程序。
- **不支持 `sse`**——`type: "sse"` 的条目会被拒绝；只有 stdio 与 Streamable HTTP 服务器会连接。
- **获准但损坏的服务器只在宿主日志中报告**——缺少凭据或无法访问的服务器只产生一行日志，不会在任何用户界面中提示。
- **agent 作用域工具会遮蔽同名全局配置行**——若 profile 还挂载了同一服务器名的 `dsh-mcp-client` 配置行，会打开两个连接，agent 调用的是 workspace 服务器的工具。
- **批准覆盖的是 `.mcp.json` 条目，而非条目实际运行的内容**——指纹只覆盖条目文本，因此修改后的 workspace 脚本（如 `./mcp/server.js`）、修改后的 `package.json` 脚本，或 `npx -y` 解析到的新包版本，都会在原有批准下运行而不再询问。
- **agent 创建可能等待缓慢的已保存服务器**——从不响应的已保存 `allow` 服务器会让该 workspace 中每个新 agent 最多延迟 `admissionTimeoutMs`。
- **Allow for this workspace 之后问题可能立即重复**——在另一会话记录 Allow for this workspace 之前刚查询完已存决定的会话会再次提出同一问题；回答它会记录相同的决定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

本开发备注是面向维护者的工作上下文：尚未决定的设计问题与方向。它明确不具权威性——已发布的行为、限制与已接受的理由以上文各节、包代码及所链接的 Agent Note 为准。

- 在多个 agent 之间为每台 workspace 服务器共享一个连接，需要 `dsh-mcp-client` 的监管器接受外部工具接收端与逐次尝试的配置；这一改动还将恢复每次重连时解析凭据以及脱敏的失败日志。
- 决定变化后从运行中的 agent 撤回服务器，需要监视信任文件，并为受影响的会话定义提示方式。

</details>
