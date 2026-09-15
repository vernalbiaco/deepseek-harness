---
description: "/api 传输层的 API 密钥准入闸门：放行同时出示已配置 bearer 密钥的浏览器会话。"
kind: "package-reference"
---
# API Key Auth

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-key-auth` 在 [`dsh-client-connection`](../../client/connection/README.zh.md) 的闸门注册表（[`gates.ts`](../../client/connection/src/gates.ts)）上注册一个准入闸门。该闸门放行 `Authorization` 头携带 `Bearer <secret>` 且与某个已配置密钥解析出的凭据匹配的请求，其余请求一律以 `401` 拒绝。connection 只在其 Host/Origin 栅栏与浏览器会话 cookie 检查之后才运行闸门，因此被放行的请求必须同时具备浏览器会话与密钥。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在同时挂载 `dsh-client-connection` 与凭据提供方的 Profile 中挂载本插件。密钥比较使用 `timingSafeEqual`。匹配成功时闸门返回 `{ allow: true, principal: <key name>, privileged: false }`；`privileged` 恒为 `false`，当前的 connection 中没有任何方法读取它。在 HTTP 路径上，未携带 bearer 凭据的请求与携带无法识别凭据的请求都应答 `401` 并附带 `www-authenticate: Bearer` 质询；被拒绝的 `/api/remote.mux` 升级应答闸门给出的状态码。

connection 会在任何闸门运行之前拒绝没有有效浏览器会话 cookie 的请求，因此只持有密钥的程序收到的是 connection 的 `401`，而非本闸门的裁定。

```yaml
- id: api-key-auth
  name: '@deepseek-ai/dsh-api-key-auth'
  config:
    keys:
      - name: laptop
        secret: DSH_KEY_LAPTOP
      - name: ci
        secret: DSH_KEY_CI
```

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `keys[].name` | — | 一个被接受密钥的审计标签；在列表内唯一，绝不是机密。放行时作为 principal 记录；每次拒绝在该位置记录 `none`。 |
| `keys[].secret` | — | 解析为该密钥机密值的凭据引用，为裸 POSIX shell 标识符，例如 `DSH_KEY_CI`，每次请求都经 `ctx.credentials` 解析，因此轮换机密无需重启。 |
| `order` | `100` | 本闸门在所有已注册闸门中的运行次序；闸门之间次序重复属于注册错误。 |

空的 `keys` 列表、重复的 `keys[].name` 与格式错误的 `keys[].secret` 引用都是加载错误。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-key-auth)是可接受字段及其 JSDoc 的完整来源。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只放行或拒绝传输请求，不向模型请求贡献任何内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **只持密钥的客户端无法到达 `/api`** — connection 的浏览器会话检查先于所有闸门，因此本包无法放行没有浏览器 cookie 的程序。
- **挂载闸门的 Profile 会拒绝 Web UI 的流** — 浏览器无法在 WebSocket 握手上设置 `Authorization`，因此把本闸门挂到浏览器 Profile 上会拒绝其 `/api/remote.mux` 升级。
- **只做认证，不做授权** — 每个被接受的密钥都能触达相同的 agent 方法、工作区与模型配额。
- **每次请求对每个已配置密钥读取一次凭据** — 密钥很多的部署需要另一种存储及其自身的失效机制。
- **匹配位置可通过时序观测** — 每次比较是常量时间的，但循环在首次匹配时返回；密钥列表是部署配置，不是机密。
- **不隐藏机密长度** — 长度不等时在常量时间比较之前即作答，这是 `timingSafeEqual` 的要求。
- **没有限流或锁定** — 抵御暴力破解属于部署前端的职责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本闸门是为一个放行无 cookie 的回环与受信主机请求的 connection 设计的；[准入闸门 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-26-api-request-gates-and-key-authentication.zh.md) 记录了该设计。

</details>

**运行时不变式：** 不发布伴生入口。本包不拥有事件流或可变运行时数据；其校验后的密钥列表与闸门注册只存在于一次 `apply` 调用的闭包中。
