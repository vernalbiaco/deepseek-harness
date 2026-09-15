# Agent Note: API 请求闸门与密钥认证

Status: implemented

[English](2026-08-26-api-request-gates-and-key-authentication.md) | 中文

## 问题

`/api` 接口不带任何身份认证，拥有它的那几个包自己就是这么写的。[`api-request-trust.ts`](../../../../packages/client/connection/src/api-request-trust.ts) 自述为一道 DNS 重绑定防线，并且「不是认证层」；[`connection`](../../../../packages/client/connection/src/index.ts) 将整个配置平面钉死在回环地址上，「直到存在真正的认证层为止」；[webserver README](../../../../packages/host/webserver/README.zh.md) 则把 TLS 与认证列为范围之外。因此，从另一台机器访问该 agent，就意味着暴露一个不带认证的接口，而它能在工作区内执行代码并消耗该账号的模型配额。

没有任何扩展点能弥合这一点。webserver 只派发一条匹配到的路由，没有中间件、没有 `next()`，重复注册还会抛错，因此插件只能遮蔽 `/api` 并让真正的处理器变得不可达。`/api` 通道上唯一的拦截器席位在所有已发布组合中都被 Typert 网关占据，而且拦截器运行于 RPC 派发内部，`events.mux` 与 `events.host` 这两个 WebSocket 升级请求根本不会进入其中。深度导入 `connection` 的内部实现来包装它，只在本工作区内可行，因为该包发布的是 `lib/` 而非 `src/`。

第二个问题比第一个更持久。`PRIVILEGED_METHODS`——`settings.*` 与 `credentials.*` 操作、`host.openPath`、`host.pickDirectory`、`llm.discoverModels`，以及 `agentPreset` 的编辑类方法 `agentPreset.read`、`agentPreset.copy`、`agentPreset.openDocument` 与 `agentPreset.remove`（`agentPreset.list` 与预设的选取都不在其中）——是通过以空列表调用信任防线来钉死的，其含义即为回环。隧道守护进程或反向代理会中继到回环地址，因此被中继的请求满足该限定。任何终结于 `127.0.0.1` 的远程访问方案，都会在无声中把配置平面交给远程调用方，其中包括读取凭据元数据与写入新凭据。仅仅认证调用方并不能解决此事：该检查无法区分被中继的请求与本地请求，因为在套接字层面已无可区分之物。

## 决策

`dsh-client-connection` 拥有一个有序的请求闸门注册表，另有一个独立的包在其上实现了一个 API 密钥闸门。

### 闸门注册表

注册表位于 [`gates.ts`](../../../../packages/client/connection/src/gates.ts)；插件通过 `ctx.connection.gates.register()` 贡献闸门，该方法返回其 disposer：

```ts
/** One request presented to the gates. */
export interface ApiGateRequest {
  readonly transport: 'http' | 'websocket'
  /** Dotted RPC method or `<namespace>/<method>` interceptor endpoint; absent for an upgrade and for bare `/api`. */
  readonly method?: string
  readonly headers: Headers
}

/** One gate's verdict on one request. */
export type ApiGateDecision =
  | { readonly allow: true; readonly principal: string; readonly privileged: boolean }
  | { readonly allow: false; readonly status: 401 | 403; readonly reason: string }

/** An admission gate contributed by a plugin. */
export interface ApiRequestGate {
  /** Ascending run order; a duplicate order is a registration error. */
  readonly order: number
  authorize(request: ApiGateRequest): Promise<ApiGateDecision>
}

/** The registry's aggregate verdict over every registered gate. */
export type ApiGateVerdict =
  | { readonly admitted: true; readonly principals: readonly string[]; readonly privileged: boolean }
  | { readonly admitted: false; readonly status: 401 | 403; readonly reason: string }
```

闸门按升序运行，第一个拒绝即生效。重复的 `order` 会让 `register()` 抛错，于是贡献第二个闸门的那个插件加载失败。抛出异常的闸门以 `403` 拒绝，其起因既不记录也不上报：注册表自身没有日志通道，而拒绝原因会回传给触发它的调用方，在那里暴露闸门内部实现即等于泄露。

connection 不承载任何策略。它只机械地执行两条规则：拒绝即终止请求；只有当聚合裁决携带 `privileged: true`**并且**该请求以空信任列表通过信任防线时，才可以调用 `PRIVILEGED_METHODS` 成员。特权是每一个放行判定的合取，因此只要有一个闸门不授予特权，特权就彻底不成立，于是新增闸门永远不可能扩大先前闸门已授予的范围。现有的 Host、跨站与 Origin 防线继续照常运行——闸门只增加要求，绝不移除要求。空的注册表以完整特权放行所有请求，这正是未注册任何闸门的组合的行为。

### 闸门在何处被调用

`/api` 的 HTTP 请求在 `createSharedFetchHandler`（[`rpc-host.ts`](../../../../packages/client/connection/src/rpc-host.ts)）内部、**先于拦截器选择**接受闸门审查，因此无论哪个目标认领该请求，通道上的每个请求都恰好被授权一次。若置于拦截器选择之后，拦截器的那些端点就会成为传输层上一个不带认证的席位：[`packages/api/gateway`](../../../../packages/api/gateway/README.zh.md) 经由 [`packages/bundle/base/cordis.patch.yml`](../../../../packages/bundle/base/cordis.patch.yml) 在所有默认 Profile 中占据 `/api` 唯一的拦截器席位，于是被认领的端点将为匿名调用方派发。connection 的兜底处理器拿到的是放行裁决以及交给闸门的同一个 `method` 字符串，因此它的特权方法判定不可能读到与被授权者不同的方法。

两个 WebSocket 升级处理器（[`index.ts`](../../../../packages/client/connection/src/index.ts)）都在信任防线之后调用 `authorizeApiRequest`，未获放行的裁决会以 `rejectWebSocketUpgrade` 写出的那个固定 `403 Forbidden` 响应拒绝该升级，因此以 `401` 拒绝的闸门在升级请求上仍表现为 `403`。

被拒绝的 HTTP 请求以闸门给出的状态码作答，正文为其原因；`401` 还会附带 `WWW-Authenticate: Bearer`。

### 密钥认证包

`@deepseek-ai/dsh-api-key-auth` 注册一个闸门，默认次序为 `100`。它读取 `Authorization: Bearer <secret>`，在每个请求上通过 `ctx.credentials` 解析每个已配置的密钥，从而让轮换后的密钥无需重启即可生效，以 `timingSafeEqual` 比较，并在匹配时返回 `{ allow: true, principal: <name>, privileged: false }`。其 `privileged: false` 是无条件的，且不可配置，因此没有任何配置能让带密钥的调用方获得特权。

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

`name` 是审计标签，必须唯一。`secret` 是一个[凭据引用](../../../../packages/credentials/credentials/README.zh.md)。空的 `keys` 列表、重复的 `name` 以及格式错误的引用，都在加载期失败而非在首个请求时失败；解析不到任何值的引用会被跳过，而不是与一个缺失的密文相匹配，因此密文只与某个解析不到值的引用相对应的调用方，最终收到的是普通的 `401 unrecognized credential`。

### 部署

由组合来决定哪些调用方可以触达配置平面，因为没有任何请求级测试能做到这一点。面向远程的 Profile 挂载该闸门，本地 Profile 不挂载。被中继的请求抵达的是这样一台服务器：每个请求都需要密钥，每个特权方法都被拒绝，因此提权路径是靠构造关闭的，而非靠检测。本地配置操作在未挂载闸门的回环 Profile 上继续照常工作，而那也是 Web UI 唯一能用的 Profile：浏览器无法在 WebSocket 握手上设置 `Authorization` 头，因此挂载了闸门的 Profile 只服务程序化客户端。

## 曾考虑的替代方案

**把 `intercept()` 注册表改成多席位。** 这是对既有机制的更小改动，而且拦截器本就能拒绝。它被否决是因为拦截器运行于 RPC 派发内部，而两条 WebSocket 升级路由根本不会到达那里，于是两条下行通道都将保持无认证状态。它还会让一个原本意为「此处理器认领这些端点」的契约，被强加上一个不相干的含义。

**用新插件基于最长前缀优先来遮蔽 `/api`。** 更具体的路由确实会胜出，因此无需改动核心。但被遮蔽的处理器随之不可达——不存在链式调用——而通过代理到 `http://127.0.0.1:<port>/api` 去触达原处理器，会把 `Host` 改写为回环地址，从而把特权方法防线变成一条提权路径。它同样无法覆盖升级路由。

**用一个包装认证的包替换 `connection` 条目。** 这无需改动任何已发布的包，并且可以深度导入 `isTrustedApiRequest` 与 `bridge`。这些导入经由 `./src/*` 解析，而该包并不发布该路径，因此此方案只在本工作区可行，对已安装的消费者则会失效；它还会复制一份必须永远跟随 connection 的注册逻辑。

**改为检测被中继的请求，而不是按组合拆分。** 检查 `X-Forwarded-For`、比较套接字对端，或要求携带某个中继头，都能让一台服务器同时服务本地与远程调用方。但这类信号全都由中继方提供，任何能访问该端口的人都可伪造，于是这道检查将用一个攻击者可控的头部去保护配置平面。

**在反向代理中终结认证，此处不做改动。** 这是最小的方案，且使用成熟软件。但它让 harness 完全不知道是谁在调用，因而没有审计轨迹、没有按密钥区分的身份，代理一旦配置错误或被绕过也没有任何纵深防御。它同样保留了特权方法提权问题，因为代理仍然中继到回环地址。

**让特权方法策略可配置。** 允许部署方选择带密钥的调用方可触达哪些方法确实更灵活。但配置错误是无声的，且爆炸半径是凭据存储，于是默认值将成为唯一的实际保护；在闸门包内固定为拒绝是更安全的契约。

## 测试

注册表语义被直接钉住：空注册表以完整特权放行；principal 按升序累积；特权以 AND 折叠；第一个拒绝上报它自己的状态码；抛出异常的闸门以 `403` 拒绝且不泄露起因；重复的 order 在注册期被拒；disposer 会释放其 order 供后续闸门使用。

各处调用点上的执行效果也被钉住。未获放行的 `/api` 请求以闸门的状态码作答，`401` 带 `Bearer` 挑战而 `403` 不带；已放行但无特权的调用方被拒绝调用 `PRIVILEGED_METHODS` 成员；被拦截器认领的端点在其处理器被触达之前即遭拒绝；无论拦截器是否认领，闸门对每个请求恰好运行一次，而裸 `/api` 路径以不带方法的形式抵达闸门。两条升级路由都会在套接字层拒绝未获放行的升级。

密钥闸门自身的测试覆盖了加载期失败（空列表、重名、格式错误的引用，且都不回显出问题的取值）、缺少凭据与凭据不被识别时的 `401`、以密钥名放行且从不授予特权、解析不到任何值的引用、轮换在下一个请求上生效、删除某个条目恰好吊销该密钥而其同伴仍然放行、配置的次序与默认次序、fiber 拆除时的注销，以及每次判定都会记录 principal 名称或 `none`、传输方式、方法与结果。

一个真实组合测试经由 vendored Loader 把两份 cordis.yml 组合启动到监听中的回环套接字上，并以真实 HTTP 客户端与真实 `ws` 客户端穿越它们；两份组合只差一行，即闸门。它证明：无密钥的 `/api` 调用、无密钥地调用被 Gateway 认领的端点，以及无密钥地升级到任一下行通道，全部被拒绝，而带密钥的那一支成功；并且带密钥的调用方被拒绝调用 `credentials.describe`。未挂载闸门的那一支正是让最后这个 `403` 成为结论而非假象的东西：同一调用在那里成功并触达真实的凭据接缝，从而把「闸门收回了特权」与「信任防线拒绝了请求」区分开来。`RemoteFixture`（Gateway 所认领的测试用 Remote）上的一个调用计数器证明，对被认领端点的拒绝发生在拦截器运行之前，而不是之后。

## 后果

闸门审查位于 `/api` 通道上拦截器选择之前，因此拦截器不再可能成为跳过认证的地方。代价是拦截器再也看不到被闸门拒绝的请求，而且今后任何拦截器都会继承这一闸门要求，无论其作者是否知道该注册表的存在。

这一放置位置对建立在伪造 `webServer` 之上的单元测试是不可见的：这类测试注册路由并调用它捕获到的处理器，检验的只是它本就相信的那个接缝。只有一个跨越真实套接字、进入被真实拦截器认领的端点的请求，才能观察到两者中谁先作答。因此 `/api` 传输层的覆盖至少需要一支经 Loader 组装、跑在监听端口上的用例；一套伪造传输层的、覆盖率满格的测试，并不构成关于派发次序的证据。

裁定中的 `privileged` 字段只有一个执行点：connection 的 `/api` 兜底处理器。拦截器路径在放行请求后直接派发，并不读取该字段；两个集合目前不可能重叠，因为拦截器认领的是两段式 `<namespace>/<method>` 端点，而 `PRIVILEGED_METHODS` 中的每一项都是点号形式的名字。因此，将来若有 Remote 暴露 settings 或 credentials 操作，必须在该路径上自行做特权检查，它不会自动继承。

闸门位于每一次 `/api` 调用的请求路径上，因此那里的缺陷会让所有调用方失败，而非仅影响某一项功能。connection 不承载策略，且抛出异常的闸门是拒绝而非放行，这让此类故障既响亮又安全。

按请求解析每个已配置的密钥，代价是每请求每密钥一次凭据读取。对少量密钥而言可以接受；若某个部署将来需要大量密钥，则需要另一种存储及其自身的失效机制。

组合拆分是一项真实约束，人是会弄错的：把闸门挂到隧道并未指向的那个 Profile 上，或是把未挂载闸门的 Profile 暴露出去，都会重新打开本方案所关闭的缺口。代码无法检测这类错误，因此必须在记录远程访问方案的每一处都写明这一点。

密钥认证不是授权。每个被接受的密钥都能触达同样的 agent 方法、同样的工作区与同样的模型配额，因此密钥泄露等同于除配置平面之外的完整 agent 沦陷。按密钥划分作用域属于范围之外，将来实现时会扩展 `ApiGateDecision` 而非替换它。
