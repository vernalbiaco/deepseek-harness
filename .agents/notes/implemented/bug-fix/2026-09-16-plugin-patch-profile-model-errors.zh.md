# Agent Note：为运行时插件补上 `modelErrors` 的补丁

Status: implemented

[English](2026-09-16-plugin-patch-profile-model-errors.md) | 中文

## 问题

第三方插件 `dsh-llm-local-token` 在 `profileOf` 中直接构建其 pi-ai Provider Profile，而不经过配置解析，因此 `ResolvedPiAiProviderProfile` 的每个必填成员都由它自己负责。`packages/llm/llm-pi-ai/src/config.ts` 中的 `ResolvedPiAiProviderProfile` 要求带有 `modelErrors`，而截至 1.5.1 的各发布版本都没有该字段。

`PiAiAdapter.modelOf` 会读取 `profile.modelErrors.get(model)`，于是 `resolveModelInfo` 会为该插件所服务的每条路由上的每个模型抛出 `Cannot read properties of undefined (reading 'get')`。`buildModelCatalog` 按 Provider 隔离抛出的异常，因此模型选择器把该插件的每条路由逐条列为加载失败的分组，而其余 Provider 一切照常。该插件的 `/llm-local-token/usage` 路由不读取任何 Profile，因此在选择器已损坏期间，配额徽标照常报告两个 Provider，路由层面的检查也始终为绿。

## 决定

`docker/plugin-patches.sh` 向每个打补丁 Profile 中已安装的 `lib/index.js` 插入 `modelErrors: new Map(),`，锚定在相邻的 `configuredMaxTokens: new Map(),` 一行上。当文件已经声明该字段时，该编辑是空操作；当锚点缺失或重复出现时，运行会就此停止，而不去猜测该字段应放在哪里。

`check` 会在其列出的路由旁一并报告该字段是否存在，因为仅凭健康的路由列表无法区分模型选择器是正常还是已损坏。

## 考虑过的替代方案

**在适配器中以防御方式读取该字段。** `profile.modelErrors?.get(model)` 能消除崩溃，但该 Profile 经由类型化的同进程回调传入，而"信任 TypeScript"规则把这类位置交给静态接口。缺失必填成员属于插件缺陷，静默容忍它只会掩盖下一个缺陷。

**把打过补丁的 `index.js` 与另外两个模块并列存放。** 那两个模块在 1.3.2 与 1.5.1 中逐字节相同，因此一份副本对两个版本都适用。`index.js` 并非如此：`web` 运行 1.5.1，`api` 运行 1.3.2，且 1.5.1 新增了图像策略与 GLM 条目。存副本需要为每个发布版本各存一个文件与一个记录的哈希，并且会丢弃其他发布版本对该文件自身的改动。

## 影响

这套补丁包含两类修复：以记录的上游哈希为门禁的整文件替换，以及锚定式的就地编辑。该编辑不记录哈希，因为锚点就是它的前置条件——若某个发布版本移动或重复了 `configuredMaxTokens: new Map(),`，运行会就此停止，而不是产出一个无人检视的文件。

若某个发布版本自己声明了 `modelErrors`，此处无需改动。该编辑会报告 `already present`，两个被替换的模块也依旧受哈希门禁保护。
