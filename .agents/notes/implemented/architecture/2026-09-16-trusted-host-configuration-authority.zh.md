# Agent Note：受信任主机的配置 authority

Status: implemented

[English](2026-09-16-trusted-host-configuration-authority.md) | 中文

## 问题

经由受信任且已认证的名称访问的部署，会把每一次 Settings 编辑都留在页面内存中。Web Client 按页面依据 `ctx.remote.$host.isLoopback` 选择 Host 持久化，因此在任何非 loopback authority 上，settings mirror 都以 `unavailable` 起步：Models 页面报告 "settings are unavailable in this browser"，主题与引导选择在刷新后重置，保存的提供方密钥也从未到达 Host。

服务端并不要求这样。[浏览器启动令牌认证](2026-08-24-browser-token-authentication.zh.md)已用"每个 `/api` 方法一个浏览器会话"取代了按方法区分的 loopback 层级，因此受信任 authority 上持有 cookie 的页面本就能访问 `settings/describe` 与所有写入。在受信任的非 loopback `Host` 下带会话 cookie 通过 HTTP 调用时，`settings/describe` 返回 `ok` 与 `writable: true`；不带 cookie 时返回 401。loopback 限制只作为 Client 的持久化选择残留下来。

## 决定

`@deepseek-ai/dsh-client-connection` 接受 `configurationAuthority: 'loopback' | 'trusted-host'`，默认 `loopback`。`trusted-host` 搭配空的 `trustedHosts` 列表会让插件加载失败。Host 将该值作为 `__DSH_CONFIGURATION_AUTHORITY__` 注入每个下发的页面，与其已注入的恢复时序并列；Client 在提供 Connection 之前用同一个 schema 校验它。

`ctx.connection` 新增 `configurable`：在 loopback 页面上或 `trusted-host` 下为 true，API Gateway 将其转发为 `ctx.remote.$host.configurable`。Client 无需再次将页面与 `trustedHosts` 比对：`/api` 会拒绝既非 loopback 也不受信任的 `Host`，因此本 Host 下发且放行的非 loopback 页面必然受信任。`dsh-ui-settings` 依据 `configurable` 选择 Host 持久化。`isLoopback` 保持原义，因此在 Host 本机桌面上打开编辑器的**打开配置文件**在两种取值下都仅限 loopback。

`dsh web --configuration-authority <loopback|trusted-host>` 经由 `ctx.webStartup` 提供给 Connection 行，并在没有 `--trusted-host` 时拒绝 `trusted-host`。

## 验证

Connection 测试覆盖两种取值下注入的全局变量、两种加载拒绝，以及 Client handle 在 loopback 页面、不受信任的非 loopback 页面、`trusted-host` 页面和畸形全局变量下的表现。Gateway 测试独立于 `isLoopback` 转发 `configurable`。`dsh-ui-settings` 插件测试从 configurable 的非 loopback 页面读取 Host，并让非 configurable 页面留在内存中、不发起线路读取。web-app 启动测试覆盖该 flag、其默认值与两种用法错误。

## 考虑过的替代方案

**恢复 rebase 之前的实现。** 它在服务端把配置方法与桌面方法拆开，通过已移除的 `dsh-host-apiproxy` 转发 authority，并让非 loopback 页面在握手完成前保持 pending。上游此后已移除服务端层级与该转发，只剩 Client 的选择需要改动。把该值注入页面使其在 `apply` 中同步可得，因此无需 pending 状态，也无需处理欢迎声明的闪现。

**不设开关，直接把所有受信任 authority 视为 configurable。** 这会改变所有声明了 LAN 或入口 authority 的部署的上游默认行为。显式取值让 `loopback` 保持默认，并记录部署作出了不同选择。

**在 `trusted-host` 下放宽 `isLoopback`。** 对 Settings 而言一个字段就够了，但它也会为远程页面启用 Host 桌面上的原生编辑器操作。

## 影响

在 `trusted-host` 下，任何在受信任 authority 上持有浏览器会话的人都能修改 Settings 并替换已存储的凭据。持有 cookie 的人本就能在 Host 中运行工具，因此这并未增加服务端能力，但该模式依赖每个受信任 authority 前面的登录层，例如公开名称上的身份感知代理。

该值只在页面加载时到达页面，因此以不同 authority 重启 Host 后，要到下一次页面加载才生效。已放行的 gate 裁决上的 `privileged` 标志仍未被使用；本变更不读取它。

携带本变更的 pull request 按 `record-browser-gif` 规则还需附上受信任非 loopback authority 上 Models 页面的 GIF。
