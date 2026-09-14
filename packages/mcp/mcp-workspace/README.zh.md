# @deepseek-ai/dsh-mcp-workspace

[English](README.md) | 中文

工作区声明的 MCP 服务器：从每个会话的规范 cwd 读取 `.mcp.json`，仅在用户作出决定（为该工作区存储在 `$DSH_HOME/mcp-trust.yaml` 中，或仅针对一个会话给出）之后才连接所声明的服务器，在使用同一工作区服务器的会话之间共享一个受监管连接，并以 [`dsh-mcp-client`](../mcp-client/README.md) 的名称 `mcp__<serverName>__<rawName>` 将该服务器的工具注册到每个符合条件的 agent（智能体）自己的工具层。

## 用法

[基础组合包](../../bundle/base/README.md)挂载一行，因此每个 `dsh` profile 都会读取工作区 `.mcp.json` 文件：

```yaml
- id: mcp-workspace
  name: '@deepseek-ai/dsh-mcp-workspace'
  config:
    trustFile: !!js dshHomePath('mcp-trust.yaml')
```

工作区以 Claude Code 的 `.mcp.json` 格式声明服务器。机密使用 `${NAME}` 凭据引用，绝不使用字面值：

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

## 配置

| 字段 | 必填 | 说明 |
|---|---|---|
| `trustFile` | 是 | 保存各工作区决定的信任文档的绝对路径；不得位于任何工作区之内 |
| `preconnect` | 否 | 激活时连接进程 cwd 与每个已注册 Web 工作区中已保存 `allow` 的服务器（默认 `true`） |
| `preconnectTimeoutMs` | 否 | 激活等待预连接服务器首次连接尝试的最长时间，单位毫秒，最大 2147483647（默认 10000） |
| `toolCallTimeoutMs` | 否 | 每个工作区服务器单次工具调用的超时，单位毫秒，最大 2147483647（默认 60000） |
| `reconnect.enabled` | 否 | 连接丢失后自动重连（默认 `true`） |
| `reconnect.initialDelayMs` | 否 | 首次重连延迟，单位毫秒；每次连续失败后翻倍（默认 500） |
| `reconnect.maxDelayMs` | 否 | 退避上限，单位毫秒；也是尝试预算重置所需的连续运行时间（默认 30000） |
| `reconnect.maxAttempts` | 否 | 每次中断中连接停止前允许的连续失败次数（默认 10） |

无效的 `reconnect` 策略会使插件在加载时失败。文件名 `.mcp.json` 固定不变。

## `.mcp.json` 支持

该文件必须是带有 `mcpServers` 对象的 JSON 对象；否则整个文件会被记录为不可用，其中的服务器一个也不会准入。每个条目独立解析，被拒绝的条目会连同服务器名称与原因写入日志，绝不包含字段值。

| 条目 | 支持情况 |
|---|---|
| stdio：`command`，可选的 `args` 与 `env`，`type` 缺省或为 `"stdio"` | 支持；子进程以规范工作区路径为 cwd，使用清理后的父进程环境加上解析后的 `env` |
| HTTP：`type: "http"`、`url`，可选的 `headers` | 通过 Streamable HTTP 支持 |
| `type: "sse"` | 拒绝 |
| 服务器名称不符合 `[A-Za-z0-9_-]{1,32}`、`command` 或 `url` 不是字符串、`args` 不是字符串数组，或 `env`/`headers` 不是字符串映射 | 拒绝 |

- **占位符**：`${NAME}`（`NAME` 匹配 `[A-Za-z_][A-Za-z0-9_]*`）可以出现在 `command`、`args`、`env` 值、`url` 与 header 值中。任何其他 `${` 序列，包括 `${NAME:-default}`，都会拒绝该服务器。
- **敏感字段**：名称匹配 `KEY`、`PASSWORD`、`SECRET` 或 `TOKEN`（不区分大小写）的 `env` 值，以及名称匹配该模式或为 `Authorization`、`Proxy-Authorization`、`Cookie` 的 header 值，必须包含占位符；字面值会拒绝该服务器。
- **指纹**：每个条目的指纹是对其 JSON（对象键递归排序）计算的 `sha256:<hex>`，在替换之前计算，并包含本解析器忽略的键。更改命令、参数、URL、env 或 header 模板或任何其他键都会改变指纹；轮换凭据值不会。

## 信任决定

每个已声明的服务器按其规范工作区路径、服务器名称与当前指纹所存储的决定准入。匹配的 `allow` 会连接该服务器，匹配的 `deny` 会跳过且不询问，缺失的条目或对应其他指纹的条目需要重新决定。

不是 subagent 子 agent 的符合条件的 agent 会提出一个问题，列出每个未决定的服务器及其传输方式、命令与参数或 URL（为空或包含空白、双引号或控制字符的值以 JSON 加引号显示），以及每个引用的凭据是 `set` 还是 `missing`。每个工作区路径与未决定服务器名称及指纹的集合只存在一个待定问题；未决定集合相同的会话等待其回答。如果提问的 agent 回答 Allow this session 或被释放，或者提问界面中止了该问题，每个等待中的会话会提出自己的问题。

| 选项 | 效果 |
|---|---|
| Allow for this workspace | 为列出的每个服务器记录 `allow` 并连接它们 |
| Allow this session | 仅为提问的 agent 连接列出的服务器；不记录任何内容，该许可在该 agent 被释放、恢复或进程重启时结束 |
| Deny | 为列出的每个服务器记录 `deny` |

释放提问的 agent 会中止该问题，该工作区中的下一个会话会再次询问。没有可用的提问界面时，未决定的服务器会被跳过，并记录为 `mcp-workspace(<name>): not approved; no question UI is available`。

服务器每次挂接到 agent 时都会重新检查已存储的决定：创建 agent 时检查一次，该 agent 读取 `.mcp.json` 后再检查一次，异步挂接之前立即再检查一次。已存储的 `deny`（即使该 agent 持有 Allow this session 许可）；对没有 Allow this session 许可的 agent 而言，条目缺失或已存储条目的指纹与 `.mcp.json` 条目不再匹配；或信任文件无法读取，都会从该 agent 撤回该服务器并释放插件持有的预连接引用。上述每个挂接点也会读取 `.mcp.json`：文件不再声明的条目，以及文件缺失或无法解析时的所有条目，都会从该 agent 撤回并释放插件持有的预连接引用，因此不再有 agent 持有该连接时它会关闭。无法读取或无效的信任文件不准入任何服务器，包括本会话已允许的服务器。

### 信任文件

基础组合包把决定存储在 `$DSH_HOME/mcp-trust.yaml`，绝不存入工作区，因此项目无法批准自己的服务器。写入会获取跨进程文件锁，并以 `0600` 模式原子替换文件：

```yaml
version: 1
workspaces:
  /home/user/projects/app:
    github:
      decision: allow
      fingerprint: sha256:3f1c…
      decidedAt: '2026-09-14T08:00:00.000Z'
```

撤销决定时，删除该服务器的条目，或删除该工作区的条目以撤销其全部服务器；在有提问界面的地方，该工作区中的下一个会话会再次询问。把 `decision` 设为 `deny` 会跳过该服务器且不询问。

## 凭据

`${NAME}` 占位符通过 `ctx.credentials` 解析，因此适用 [`dsh-credentials-local`](../../credentials/credentials-local/README.md) 的来源顺序：继承的环境、`$DSH_HOME/.credentials.yaml`、调用目录的 `.env`，然后是 `$DSH_HOME/.env`。引用的凭据未设置的服务器会被跳过，记录日志行 `mcp-workspace(<name>): credential <NAME> is not set`，且不会启动连接。每次连接尝试之前都会重新解析，因此重连会使用轮换后的值。解析后的值绝不进入日志、问题或信任文件。

## 会话与使用界面

当 agent 是根 agent（`ctx.agents.roots()`，包含顶层会话与可继续的 subagent 子 agent）且其规范 cwd 等于工作区路径时，它会获得该工作区服务器的工具。一次性的进程内 subagent 子 agent 不会获得任何工具。来源为 subagent 的根 agent 会挂接已保存 `allow` 的服务器，但从不提问。

| 使用界面 | 未决定的服务器 |
|---|---|
| Web | 会话显示决定问题 |
| Headless、ACP、API | 跳过并记录日志；只连接已保存 `allow` 的服务器 |

## 连接

每个规范工作区路径、服务器名称与指纹组合只存在一个受监管连接；使用该服务器的每个 agent 持有一个引用，释放最后一个引用会关闭连接。启用 `preconnect` 时，激活会为 `process.cwd()` 以及 `ctx.workspaceRegistry` 中的每个工作区连接凭据已设置且已保存 `allow` 的服务器，并为每个服务器持有一个插件所有的引用，直到插件被释放或重新检查将其撤销。激活最多等待这些首次尝试 `preconnectTimeoutMs`；更慢的连接在后台继续，任何预连接失败都不会使激活失败。

在其工作区服务器已发布工具之后创建的 agent，会在第一次模型请求之前获得这些工具。会话期间准入的服务器，或在 agent 创建之后才完成连接的服务器，会在后续步骤注册其工具。传输丢失时，最后一组工具保持注册，调用会失败，并按 `reconnect` 策略重连；尝试预算耗尽时，工具会从每个已挂接的 agent 移除，下一个挂接的会话会启动新连接。注册之前，如果存在同名全局工具，每个工作区与服务器只记录一次警告。

## 使用的服务

| 服务 | 用途 |
|---|---|
| `ctx.agents` | 观察 `agent/created` 并读取根 agent 集合 |
| `ctx.tools` | 在每个符合条件的 agent 的工具层注册工具，并检测同名全局工具 |
| `ctx.credentials` | 解析 `${NAME}` 引用，并报告每个引用是否已设置 |
| `ctx.userQuestions` | 可选；就未决定的服务器请求决定 |
| `ctx.workspaceRegistry` | 可选；列出需要预连接的 Web 工作区 |

## 模型体验

### 工作区 MCP 工具

#### 模型看到的内容

符合条件的 agent 会把其工作区中每个已准入服务器的每个工具视为名为 `mcp__<serverName>__<rawName>`（或其确定性规范化形式）的原生工具，并携带服务器提供的描述和输入 schema。agent 创建之前已连接的服务器的工具出现在第一次请求中；之后准入或连接的服务器的工具出现在后续步骤中，并伴随原因为 `change` 的 `request/header`。重新同步会替换该服务器的工具；下一次挂接时撤回的决定、耗尽的重连预算，或 agent 与插件被释放，都会移除这些工具。问题、被跳过的服务器与拒绝信息绝不会进入模型。

#### Token 影响

工具注册期间，每次请求都会承担数据相关的 schema 成本。重新同步会替换而非累积 schema，服务器限定名称也会为每个工具定义和调用增加 token。

#### KV Cache 影响

只要 agent 的工作区工具集合及其 schema 不变，前缀就保持稳定。会话期间加入或离开的服务器，或增加、移除、重命名、更改工具的重新同步，会替换工具定义，并可能使从第一个变化的 schema token 起的复用失效；恢复了未变列表的重连会生成完全相同的定义，前缀保持稳定。

### 工具调用历史与结果

#### 模型看到的内容

调用与结果的呈现与 [`dsh-mcp-client`](../mcp-client/README.md#tool-call-history-and-results) 工具完全相同，因为本包注册的正是 `dsh-mcp-client` 构建的工具定义。

#### Token 影响

与 `dsh-mcp-client` 工具调用相同：参数、映射后的文本和持久图片引用会保留到压缩（compaction）发生时。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与暂缓事项

- **撤销的决定不会作用于运行中的 agent**：重新检查发生在服务器挂接到 agent 时，因此在决定被删除或改为 `deny` 之前创建的 agent 会保留该服务器的工具，直到它被释放。
- **决定按规范路径存储**：同一个检出挂载在两个路径时，例如 Web 工作区与容器挂载，每个路径都需要单独的决定。
- **不监视 `.mcp.json`**：编辑在该工作区中创建下一个 agent 时生效，指纹改变时会再次询问。运行中的 agent 会保留已移除或已更改条目的工具，其连接保持打开，直到这些 agent 被释放。在文件缺失或无法解析时（例如编辑进行到一半）创建的 agent，会撤回该工作区的所有服务器，并关闭没有其他 agent 持有的每个连接。
- **已批准的 stdio 服务器在沙箱之外运行**：该决定授权的是一个不受沙箱约束、带有清理后父进程环境的程序。
- **不支持 `sse`**：`type: "sse"` 的条目会被拒绝；只有 stdio 与 Streamable HTTP 服务器会连接。
- **故障的已批准服务器只在宿主日志中报告**：凭据缺失或服务器不可达只会产生日志行，任何用户界面中都没有提示。
- **agent 作用域工具会遮蔽同名全局行**：同时挂载了同一服务器名称 `dsh-mcp-client` 行的 profile 会打开两个连接，agent 调用的是工作区服务器的工具。
