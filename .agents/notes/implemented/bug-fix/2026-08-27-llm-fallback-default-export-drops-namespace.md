# Agent Note: llm-fallback's default export discarded its plugin namespace

Status: implemented

English | [中文](2026-08-27-llm-fallback-default-export-drops-namespace.zh.md)

## Problem

`@deepseek-ai/dsh-llm-fallback` shipped `export default apply` alongside its namespace exports. The cordis Loader normalizes an imported module through `unwrapExports` ([vendor/loader/src/index.ts](../../../../vendor/loader/src/index.ts)), which prefers `.default`, so mounting the package from a `cordis.yml` handed cordis the bare `apply` function. `Registry.plugin` then read `Config` and `inject` off that function and found neither: config validation never ran on the path a user mounts from, and `inject: ['agents']` did not gate `apply()`.

This is root cause #1 of [post-mortem 0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md) reintroduced in a new package, and [packages/AGENTS.md](../../../../packages/AGENTS.md) already states the rule it breaks. Nothing in the repository mechanically enforces that rule, so the defect reached a branch that was otherwise at 100% coverage with a keyless real-Loader suite.

Three measured consequences, all on the shipped path:

- A `backups` value that is not a list reached `resolveConfig` unvalidated and died with `llm-fallback: duplicate backup route "undefined/undefined"`.
- Mounting with no `config:` block failed with `Cannot convert undefined or null to object`, naming nothing, against the repository rule that misconfiguration fails loud naming its referent.
- With `dsh-agent` absent, `apply()` ran to completion instead of waiting for the `agents` service.

## Decision

`src/index.ts` has no default export. The package is a function plugin and named-exports `name`, `inject`, `Config`, and `apply`, matching `dsh-llm-retry` and every other function plugin in the repository.

Making the schema live exposed a second defect the dead schema had hidden. Schemastery fills an omitted array with `[]`, so `failoverCodes` arrived as an empty list whenever a composition omitted it, and `resolveConfig`'s empty-list guard rejected the load. Every composition without an explicit `failoverCodes` was affected, including [examples/headless-agent/fallback.cordis.snapshot.yml](../../../../examples/headless-agent/fallback.cordis.snapshot.yml). `Config` now declares `failoverCodes: z.array(z.string()).default(undefined as unknown as string[])`, so an omitted list reaches `resolveConfig` still absent.

That keeps three distinct entry states distinguishable, which is what `resolveConfig` documents and tests: omitted takes `DEFAULT_FAILOVER_CODES`, an explicitly empty list is rejected as a chain that can never move, and a supplied list replaces the defaults.

## Testing

`tests/loader-composition.spec.ts` covers the schema and injection layers that `resolveConfig`'s own guards never reached: a non-list `backups` rejected by type, a missing `config:` block rejected by name, and a composition without `dsh-agent` leaving the entry's fiber `PENDING`. All three fail if the default export returns.

That suite's `unloaded` check reads `entry.fiber === undefined`, which a fiber left `PENDING` on an unsatisfied `inject` does not match, so the mounted composition also asserts `FiberState.ACTIVE` directly.

`tests/config.spec.ts` pins the schema/`resolveConfig` round trip in both directions, since each side passes alone while the composition of the two was what failed.

The keyless `provider-fallback` snapshot passes with and without the default export: its composition provides `agents` before the fallback entry and supplies a config the dead schema and the live one normalize alike. It is evidence that the fix does not regress the shipped path, not a guard against the defect.

## Alternatives considered

**Give `failoverCodes` a schema-level default of `DEFAULT_FAILOVER_CODES`.** This is an idiom the repository already uses (`dsh-agent-instructions`), and it resolves the empty-array collision. It loses on ownership: `resolveConfig` is the single place this package decides a default, and a schema-level default moves that decision somewhere else, against the rule that defaulting is an explicit step in the owning implementation. Applied and measured, it fails one test — `leaves an omitted failoverCodes absent so resolveConfig still defaults it`. `resolveConfig`'s `?? DEFAULT_FAILOVER_CODES` stays reachable, because `tests/config.spec.ts` calls `resolveConfig` directly with raw entries that never pass through the schema.

**Treat an empty `failoverCodes` as "not configured".** One line in `resolveConfig`, and it needs no schema change. It deletes a deliberate misconfiguration guard: a user writing `failoverCodes: []` to mean "never fail over" would silently receive all ten default codes.

**Drop `failoverCodes` from the schema, following `dsh-llm-retry`'s `z.object({})`.** Schemastery passes undeclared keys through, so absence would survive. It costs discoverability — the schema is what config catalogs and tooling read, and a documented field would vanish from it.

**Keep the default export and hand-mount the plugin everywhere.** Rejected in post-mortem 0001 for the same reason it fails here: a hand-built `ctx.plugin({ name, inject, apply })` supplies `inject` itself and can never exercise `unwrapExports`.

## Consequences

`inject: ['agents']` is live, so the plugin now waits for the `agents` service instead of applying without it. A composition that mounts `dsh-llm-fallback` without an agent registry gets a pending entry rather than a plugin that ran with no services — correct, and a load-order change for anyone relying on the old behavior.

Config validation is live, so a composition that the dead schema accepted may now be rejected at load. That is the point, and the `failoverCodes` collision above shows the class of breakage it can surface: a normalization that only ever ran in unit tests meets entries that only ever ran through the Loader.

The plugin-export rule remains prose in [packages/AGENTS.md](../../../../packages/AGENTS.md) and post-mortem 0001, enforced by neither a gate nor a shared test. It is mechanically checkable — a function plugin exporting `apply` must not also export a default — and it has now cost two packages. A `verify-plugin-exports` gate is the obvious next step and is not part of this change.
