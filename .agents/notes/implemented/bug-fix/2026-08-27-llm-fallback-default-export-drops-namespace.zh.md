# Agent Note: llm-fallback 的默认导出丢弃了插件命名空间

Status: implemented

[English](2026-08-27-llm-fallback-default-export-drops-namespace.md) | 中文

## 问题

`@deepseek-ai/dsh-llm-fallback` 在命名空间导出之外还交付了 `export default apply`。cordis Loader 通过 `unwrapExports`（[vendor/loader/src/index.ts](../../../../vendor/loader/src/index.ts)）规范化导入的模块，而它优先取 `.default`，因此从 `cordis.yml` 挂载该包时，交给 cordis 的是裸 `apply` 函数。`Registry.plugin` 随后从该函数上读取 `Config` 与 `inject`，两者都不存在：用户实际挂载所走的那条路径从未执行过配置校验，`inject: ['agents']` 也没有约束 `apply()` 的执行。

这是[事故复盘（postmortem）0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md) 的根因 #1 在一个新包中重现，而 [packages/AGENTS.md](../../../../packages/AGENTS.md) 早已写明了它违反的那条规则。仓库中没有任何机制强制执行该规则，因此这个缺陷进入了一个在其他方面已达 100% 覆盖率、并配有无密钥真实 Loader 套件的分支。

三项已实测的后果，全部位于交付路径上：

- 非列表的 `backups` 值未经校验就到达 `resolveConfig`，并以 `llm-fallback: duplicate backup route "undefined/undefined"` 告终。
- 不带 `config:` 块挂载时，失败信息是 `Cannot convert undefined or null to object`，没有点名任何对象，违反仓库中「错误配置必须显式失败并点名其所指」的规则。
- 缺少 `dsh-agent` 时，`apply()` 会一路执行完毕，而不是等待 `agents` 服务。

## 决策

`src/index.ts` 没有默认导出。该包是一个函数插件，以命名导出提供 `name`、`inject`、`Config` 和 `apply`，与 `dsh-llm-retry` 以及仓库中其他所有函数插件保持一致。

让 schema 真正生效之后，又暴露出第二个此前被未生效 schema 掩盖的缺陷。Schemastery 会把省略的数组填成 `[]`，因此只要某个组合省略 `failoverCodes`，它到达时就是一个空列表，而 `resolveConfig` 的空列表守卫会拒绝这次加载。所有没有显式写出 `failoverCodes` 的组合都受影响，包括 [examples/headless-agent/fallback.cordis.snapshot.yml](../../../../examples/headless-agent/fallback.cordis.snapshot.yml)。现在 `Config` 声明为 `failoverCodes: z.array(z.string()).default(undefined as unknown as string[])`，因此被省略的列表到达 `resolveConfig` 时依然是缺失的。

这样就保住了三种彼此可区分的配置项状态，也正是 `resolveConfig` 所记录并测试的行为：省略时取 `DEFAULT_FAILOVER_CODES`，显式的空列表会作为一条永远无法推进的链被拒绝，而给出的列表则替换默认值。

## 测试

`tests/loader-composition.spec.ts` 覆盖 `resolveConfig` 自身守卫从未触及的 schema 层与注入层：非列表的 `backups` 按类型被拒，缺失的 `config:` 块被点名拒绝，不含 `dsh-agent` 的组合则让该配置项的 fiber 停在 `PENDING`。默认导出一旦回归，这三项都会失败。

该套件的 `unloaded` 检查读取 `entry.fiber === undefined`，而因 `inject` 未满足停在 `PENDING` 的 fiber 并不符合这一条件，因此已挂载的组合还会直接断言 `FiberState.ACTIVE`。

`tests/config.spec.ts` 双向钉住 schema 与 `resolveConfig` 的往返：两侧各自单独运行都能通过，真正失败的是两者的组合。

无密钥的 `provider-fallback` 快照在有无默认导出时都会通过：它的组合在 fallback 配置项之前提供了 `agents`，并给出了一份未生效 schema 与生效 schema 归一化结果相同的配置。它是「这次修复没有导致交付路径回归」的证据，而不是针对该缺陷的守卫。

## 考虑过的替代方案

**在 schema 层为 `failoverCodes` 设默认值 `DEFAULT_FAILOVER_CODES`**。这是仓库已经在用的写法（`dsh-agent-instructions`），也能解决空数组冲突。它输在归属上：`resolveConfig` 是本包决定默认值的唯一位置，而 schema 层默认值会把这个决定挪到别处，违反「默认值必须是所属实现中的显式步骤」这条规则。实际应用并实测后，它会让一个测试失败——`leaves an omitted failoverCodes absent so resolveConfig still defaults it`。`resolveConfig` 的 `?? DEFAULT_FAILOVER_CODES` 仍然可达，因为 `tests/config.spec.ts` 会用从不经过 schema 的原始配置项直接调用 `resolveConfig`。

**把空的 `failoverCodes` 当作「未配置」**。只需在 `resolveConfig` 中改一行，也不需要改动 schema。但它删掉了一个刻意设置的错误配置守卫：用户写下 `failoverCodes: []` 来表达「永不故障转移」时，会静默地拿到全部十个默认 code。

**仿照 `dsh-llm-retry` 的 `z.object({})`，把 `failoverCodes` 从 schema 中去掉**。Schemastery 会透传未声明的键，因此缺省状态得以保留。代价是可发现性：配置目录与工具读取的正是 schema，一个已记录在案的字段会从中消失。

**保留默认导出，改为在所有地方手工挂载该插件**。事故复盘 0001 已因同样的理由否决它，这个理由在这里同样成立：手工构建的 `ctx.plugin({ name, inject, apply })` 自己提供了 `inject`，永远无法走到 `unwrapExports`。

## 后果

`inject: ['agents']` 已经生效，因此插件现在会等待 `agents` 服务，而不是在缺少它的情况下直接应用。挂载 `dsh-llm-fallback` 却没有 agent（智能体）注册表的组合，得到的是一个处于待定状态的配置项，而不是一个在没有任何服务的情况下就已经运行起来的插件——这是正确行为，对依赖旧行为的人则是一次加载顺序变更。

配置校验已经生效，因此未生效 schema 曾经接受的组合，现在可能在加载时被拒绝。这正是目的所在，而上文的 `failoverCodes` 冲突展示了它可能暴露的那类破坏：一段只在单元测试中运行过的归一化逻辑，遇上了只经由 Loader 运行过的配置项。

插件导出规则至今仍停留在 [packages/AGENTS.md](../../../../packages/AGENTS.md) 与事故复盘 0001 的文字说明中，既没有门禁也没有共享测试强制执行它。它是可机械校验的——导出 `apply` 的函数插件不得同时提供默认导出——而它已经让两个包付出了代价。`verify-plugin-exports` 门禁是显而易见的下一步，但不属于这次变更。
