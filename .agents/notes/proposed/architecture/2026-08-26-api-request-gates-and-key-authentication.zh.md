# Agent Note: API 请求闸门与密钥认证

Status: proposed

[English](2026-08-26-api-request-gates-and-key-authentication.md) | 中文

## Problem

`/api` 接口没有身份认证，拥有它的那几个包自己就是这么写的。[`api-request-trust.ts`](../../../../packages/client/connection/src/api-request-trust.ts) 自述为一道 DNS 重绑定防线，并且「不是认证层」；[`connection`](../../../../packages/client/connection/src/index.ts) 将整个配置平面钉死在回环地址上，「直到存在真正的认证层为止」；[webserver README](../../../../packages/host/webserver/README.md) 则把 TLS 与认证列为范围之外。因此，从另一台机器访问该 agent，就意味着暴露一个不带认证的接口，而它能在工作区内执行代码并消耗该账号的模型配额。

没有任何扩展点能弥合这一点。webserver 只派发一条匹配到的路由，没有中间件、没有 `next()`，重复注册还会抛错，因此插件只能遮蔽 `/api` 并让真正的处理器变得不可达。`/api` 通道上唯一的拦截器席位在所有已发布组合中都被 Typert 网关占据，而且拦截器运行于 RPC 派发内部，`events.mux` 与 `events.host` 这两个 WebSocket 升级请求根本不会进入其中。深度导入 `connection` 的内部实现来包装它，只在本工作区内可行，因为该包发布的是 `lib/` 而非 `src/`。

第二个问题比第一个更持久。`PRIVILEGED_METHODS`——所有 `settings.*` 与 `credentials.*` 操作、`host.openPath`、`host.pickDirectory`、`agentPreset.*`——是通过以空列表调用信任防线来钉死的，其含义即为回环。隧道守护进程或反向代理会中继到回环地址，因此被中继的请求满足该限定。任何终结于 `127.0.0.1` 的远程访问方案，都会在无声中把配置平面交给远程调用方，其中包括读取凭据元数据与写入新凭据。仅仅认证调用方并不能解决此事：该检查无法区分被中继的请求与本地请求，因为在套接字层面已无可区分之物。

## Proposal

为 `dsh-client-connection` 增加一个有序的请求闸门注册表，并新增一个独立的包来实现一个 API 密钥闸门。

### 闸门注册表

`HostConnectionService` 新增一个注册表，在当前已存在的三处入口检查上被调用——`/api` HTTP 路由、特权方法判定，以及两个 WebSocket 升级处理器：

```ts
interface ApiRequestGate {
  /** Ascending run order; a duplicate order is a load error. */
  readonly order: number
  authorize(request: ApiGateRequest): Promise<ApiGateDecision>
}

interface ApiGateRequest {
  transport: 'http' | 'websocket'
  /** RPC method for an `/api/<method>` request; absent for an upgrade. */
  method?: string
  headers: Headers
}

type ApiGateDecision =
  | { allow: true, principal: string, privileged: boolean }
  | { allow: false, status: 401 | 403, reason: string }
```

`register()` 返回其 disposer。闸门按升序运行，第一个拒绝即生效；抛出异常的闸门以 `403` 拒绝并记录起因，因为一个失败即放行的闸门会让它自身失去意义。

connection 不承载任何策略。它只机械地执行两条规则：拒绝即终止请求；只有当每一个放行判定都携带 `privileged: true` 时，请求才可以调用 `PRIVILEGED_METHODS` 成员。因此只要有一个闸门不授予特权，特权即被收回，于是新增闸门永远不可能扩大先前闸门已授予的范围。现有的 Host、跨站与 Origin 防线继续照常运行——闸门只增加要求，绝不移除要求。未注册任何闸门的组合，其行为与今天完全一致。

### 密钥认证包

`@deepseek-ai/dsh-api-key-auth` 注册一个闸门。它读取 `Authorization: Bearer <secret>`，在每个请求上通过 `ctx.credentials` 解析每个已配置的密钥，从而让轮换后的密钥无需重启即可生效，以常数时间比较，并在匹配时返回 `{ allow: true, principal: <name>, privileged: false }`。其 `privileged: false` 是无条件的，且不可配置。

配置只给出密钥名称并引用密文，从不携带密文本身：

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

`name` 是审计标签，必须唯一。`secret` 是一个[凭据引用](../../../../packages/credentials/credentials/README.md)。空的 `keys` 列表会在加载期失败，而不是放行所有调用方；解析不到任何值的引用会拒绝，而不是与一个缺失的密文相匹配。

### 部署

由组合来决定哪些调用方可以触达配置平面，因为没有任何请求级测试能做到这一点。面向远程的 Profile 挂载该闸门，本地 Profile 不挂载。被中继的请求抵达的是这样一台服务器：每个请求都需要密钥，每个特权方法都被拒绝，因此提权路径是靠构造关闭的，而非靠检测。本地配置操作在未挂载闸门的回环 Profile 上继续照常工作。

## Alternatives considered

**把 `intercept()` 注册表改成多席位。** 这是对既有机制的更小改动，而且拦截器本就能拒绝。它被否决是因为拦截器运行于 RPC 派发内部，而两条 WebSocket 升级路由根本不会到达那里，于是两条下行通道都将保持无认证状态。它还会让一个原本意为「此处理器认领这些端点」的契约，被强加上一个不相干的含义。

**用新插件基于最长前缀优先来遮蔽 `/api`。** 更具体的路由确实会胜出，因此无需改动核心。但被遮蔽的处理器随之不可达——不存在链式调用——而通过代理到 `http://127.0.0.1:<port>/api` 去触达原处理器，会把 `Host` 改写为回环地址，从而把特权方法防线变成一条提权路径。它同样无法覆盖升级路由。

**用一个包装认证的包替换 `connection` 条目。** 这无需改动任何已发布的包，并且可以深度导入 `isTrustedApiRequest` 与 `bridge`。这些导入经由 `./src/*` 解析，而该包并不发布该路径，因此此方案只在本工作区可行，对已安装的消费者则会失效；它还会复制一份必须永远跟随 connection 的注册逻辑。

**改为检测被中继的请求，而不是按组合拆分。** 检查 `X-Forwarded-For`、比较套接字对端，或要求携带某个中继头，都能让一台服务器同时服务本地与远程调用方。但这类信号全都由中继方提供，任何能访问该端口的人都可伪造，于是这道检查将用一个攻击者可控的头部去保护配置平面。

**在反向代理中终结认证，此处不做改动。** 这是最小的方案，且使用成熟软件。但它让 harness 完全不知道是谁在调用，因而没有审计轨迹、没有按密钥区分的身份，代理一旦配置错误或被绕过也没有任何纵深防御。它同样保留了特权方法提权问题，因为代理仍然中继到回环地址。

**让特权方法策略可配置。** 允许部署方选择带密钥的调用方可触达哪些方法确实更灵活。但配置错误是无声的，且爆炸半径是凭据存储，于是默认值将成为唯一的实际保护；在闸门包内固定为拒绝是更安全的契约。

## Acceptance criteria

不带有效密钥的 `/api` HTTP 请求以 `401` 与 `WWW-Authenticate: Bearer` 被拒绝；带有效密钥时正常派发。不带有效密钥地向 `events.mux` 或 `events.host` 发起 WebSocket 升级，会在套接字层被拒绝。带密钥的调用方调用任何 `PRIVILEGED_METHODS` 成员都会收到 `403`，而同一调用在未挂载闸门的回环 Profile 上仍然成功。

轮换某个密钥的密文会在下一个请求上生效且无需重启。删除某个密钥的条目恰好吊销该密钥。空的 `keys` 列表、重复的 `name` 以及重复的闸门 `order`，都会在加载期失败并在消息中指明出问题的条目。

任何日志行、错误消息、RPC 响应或 `describe()` 结果都不包含密文。每次判定都会记录 principal 名称或 `none`、方法、传输方式与结果。未注册任何闸门的组合，其行为与当前逐字节一致。

两个包均保持每文件 100% 覆盖率。一个真实组合的 webserver 测试证明 HTTP 路由与两条升级路由都会拒绝无密钥请求，并且 `pnpm run test:coverage` 与快照套件通过。

## Risks

闸门位于每一次 `/api` 调用的请求路径上，因此那里的缺陷会让所有调用方失败，而非仅影响某一项功能。缓解之处在于 connection 不承载策略，且抛出异常的闸门是拒绝而非放行，这让故障既响亮又安全。

按请求解析每个已配置的密钥，代价是每请求每密钥一次凭据读取。对少量密钥而言可以接受；若某个部署将来需要大量密钥，则需要另一种存储及其自身的失效机制。

组合拆分是一项真实约束，人是会弄错的：把闸门挂到隧道并未指向的那个 Profile 上，或是把未挂载闸门的 Profile 暴露出去，都会重新打开本方案所关闭的缺口。代码无法检测这类错误，因此必须在记录远程访问方案的每一处都写明这一点。

密钥认证不是授权。每个被接受的密钥都能触达同样的 agent 方法、同样的工作区与同样的模型配额，因此密钥泄露等同于除配置平面之外的完整 agent 沦陷。按密钥划分作用域在此刻属于范围之外，将来实现时会扩展 `ApiGateDecision` 而非替换它。
