# @deepseek-ai/dsh-api-key-auth

[English](README.md) | 中文

`/api` 传输层的 API 密钥准入门（admission gate）。它在 [`dsh-client-connection`](../../client/connection/README.md) 的 `ApiGateRegistry`（[gates](../../client/connection/src/gates.ts)）上注册一个门：放行携带已配置 bearer 密钥的调用方，拒绝其余所有调用方；它绝不会授予特权方法平面。

当请求的 `Authorization` 头携带 `Bearer <secret>`，且 `<secret>` 与某个已配置密钥解析出的凭据匹配（以 `timingSafeEqual` 比较）时，该请求获得放行。匹配成功时该门返回 `{ allow: true, principal: <key name>, privileged: false }`;`privileged` 是无条件的、不可配置的,因此没有任何配置能让持密钥调用方获得特权。未携带 bearer 凭据的请求与携带无法识别凭据的请求,两者都应答 `401`。持密钥调用方若调用 `PRIVILEGED_METHODS` 中的成员(设置、凭据、预设编辑等配置平面方法;参见 [gates.ts](../../client/connection/src/gates.ts) 与 `dsh-client-connection` 的 `index.ts`),应答 `403`,因为特权只能来自 loopback-same-origin 信任栅栏,而这个门永远无法满足该栅栏。由组合决定——即哪个 profile 挂载了本插件,以及该 profile 是否同时放宽了信任栅栏——谁能够到达配置平面;没有任何基于单次请求的检测能区分一个被转发的请求和一个本地请求。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `keys[].name` | — | 一个已接受密钥的审计标签;在列表中唯一,绝不是密钥本身。在放行、以及无凭据或无法识别凭据的拒绝时都会被记录。 |
| `keys[].secret` | — | 解析出该密钥所用密钥值的凭据引用,格式与 [`dsh-credentials`](../../credentials/README.md) 在别处读取的格式相同。每个已配置密钥在每次请求中解析一次,因此轮换密钥无需重启。 |
| `order` | `100` | 该门在所有已注册门([`ApiGateRegistry`](../../client/connection/src/gates.ts))中的运行顺序,为必须更早运行的门留出空间。多个门使用相同顺序是注册错误。 |

至少需要一个密钥;`keys` 列表为空是加载错误,`keys[].name` 重复也是加载错误。`keys[].secret` 引用格式不正确同样会以这种方式失败——在加载时,而不是在第一次请求时。

```yaml
- id: api-key-auth
  name: '@deepseek-ai/dsh-api-key-auth'
  config:
    keys:
      - name: ci
        secret: env:API_KEY_CI
```

## 模型体验

无,因为本包只放行或拒绝传输层请求,不为模型请求贡献任何内容。

#### KV Cache 影响

无;本包既不组装也不发送 provider 请求。

## 已知限制与暂缓事项

- **一个已配置的门控 profile 只能被程序化客户端访问** — 浏览器无法在 WebSocket 握手上设置 `Authorization` 头([`WebApiClient`](../../client/connection/src/client/web-api-client.ts) 用裸 `new WebSocket(url)` 打开两条下行链路),因此 Web UI 必须留在一个不设门控的 loopback profile 上。
- **是身份认证,不是授权** — 每个被接受的密钥都能到达相同的 agent 方法、工作区和模型配额,因此密钥泄露即是一次完整的 agent 沦陷,只是到不了配置平面;按密钥划分作用域会扩展 `ApiGateDecision`,而不是取代它。
- **每次请求对每个已配置密钥读取一次凭据** — 解析按请求进行,因此轮换密钥无需重启;密钥数量很多的部署需要不同的存储方式及其自身的失效机制。
- **匹配位置可通过计时被观察到** — 每次密钥比较都是常数时间的,但循环在第一次匹配时就返回,因此耗时会泄露某个密钥在列表中的位置。该列表是部署配置,不是密钥本身。
- **密钥长度未被隐藏** — 长度不相等时会在常数时间比较之前就给出应答,这是 `timingSafeEqual` 的要求。
- **没有速率限制或锁定机制** — 该门会应答每一个请求;抵御暴力破解属于部署前置设施的职责。
