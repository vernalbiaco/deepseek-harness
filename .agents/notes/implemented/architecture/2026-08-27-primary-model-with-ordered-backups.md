# Agent Note: Primary model with ordered backup models

Status: implemented

English | [中文](2026-08-27-primary-model-with-ordered-backups.zh.md)

## Problem

A session runs one explicit provider/model route. When that route is rate-limited past its retry window, out of quota, holding a rejected credential, or unregistered, the turn fails terminally even though the deployment holds credentials for other routes that could serve the same request.

`dsh-llm-retry` recovers transient failures of the *same* route and by construction re-requests the same model, so it cannot help where a different model would succeed immediately: `AUTH`, `QUOTA`, `INVALID_CREDENTIAL`, `MISSING_CREDENTIAL`, and `NO_ADAPTER` are outside its default retryable set precisely because repeating them is futile, and an exhausted `RATE_LIMIT` budget ends the same way.

The [bounded LLM request recovery](../../implemented/architecture/2026-06-21-bounded-llm-request-recovery.md) note deferred failover because "no current consumer requires automatic fallback"; a deployment configured with several interchangeable models is that consumer. That note also assigns the obligation for overlapping recovery classifiers to "the plugins that introduce them", which this package discharges.

## Decision

The product package `@deepseek-ai/dsh-llm-fallback` at `packages/llm/llm-fallback/`, sibling to `dsh-llm-retry`, holds an ordered list of backup routes and moves to the next one when the current route fails. It contributes only through documented extension points and changes no existing package.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
- name: '@deepseek-ai/dsh-llm-fallback'
  config:
    backups:
      - { provider: deepseek, model: deepseek-v3 }
      - { provider: anthropic, model: claude-opus-5 }
```

`backups` is a required non-empty list of `{ provider, model }` pairs; duplicate pairs fail plugin load. The primary is deliberately absent: it is whatever route the session already resolves through `dsh-agent-default-model` or a user selection, so the plugin never duplicates that fact and never fights the model picker.

`failoverCodes` is an optional validated list defaulting to `[RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE, AUTH, QUOTA, INVALID_CREDENTIAL, MISSING_CREDENTIAL, NO_ADAPTER]`. `code` is an open string taxonomy, so any code outside the list — including `CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST`, `ABORTED`, and adapter-specific codes such as `HTTP_503` — delegates and stays terminal.

Misconfiguration fails at plugin load: an empty `backups` list, a duplicate backup route, an empty `failoverCodes` list when the key is present, and any key outside `backups` and `failoverCodes`. The unknown-key guard exists because schemastery passes unknown keys through instead of rejecting them; without it a typo such as `backup:` or `failOverCodes:` would load cleanly under silently defaulted configuration the operator believes they set, matching the same guard in `dsh-llm-retry`.

### Registration and per-agent state

All four listeners register on the root context at plugin load, keyed by the agent in a `WeakMap`. The three `agent/*` events carry `payload.agent`; `system-prompt/assemble` does not, and reaches its agent through `context.agent`, the field `dsh-agent` merges into `AssembleContext` and sets alongside `scope` in `assembleContextFor`. Root registration is required for correctness, not a convenience: `AgentLoop.setupAndPublish` awaits agent setup before publishing, and ApiProxy installs its own `agent/request` override during that setup, so a listener installed at `agent/created` would register later, be pushed later, and be overridden on the unwind. Cordis waterfalls run outermost-first and append on register, so the earliest registration wins.

Per-agent state is the cursor (`0` = primary, `n` = `backups[n - 1]`), the captured primary selection, the route the plugin last asserted, the route staged by an external change, and the last turn that reset the cursor.

### Cursor reset

`agent/inbox/claimed` resets the cursor to `0` when `payload.turn` differs from the last reset turn. The turn guard is required because that event also fires for mid-turn steering, which must not re-probe a route that just failed inside the open turn. Retry turns claim no message, so a failover cascade within one turn is unaffected.

### Request routing

The plugin states `provider` and `model` as prompt variables at `system-prompt/assemble` and computes the request route freshly at `agent/request`. It cannot snapshot the assembly's target and reuse it: `AgentLoop.step()` receives one assembly per step and a `{ kind: 'retry' }` action re-enters its request loop without reassembling (`packages/core/agent-loop/src/agent.ts:333-390`), so a snapshot would send a failover retry back to the route that just failed. It also cannot reuse `installModelSelection`, whose override is unconditional, because a cursor at `0` is not inert after a failover has occurred.

At cursor `0` with no failover yet in the session, the plugin returns the delegated config untouched. Once a failover has occurred, cursor `0` must actively re-assert the captured primary, because the ApiProxy selection reads back through `session.requestHeader()`, which by then records the backup; leaving the request untouched would silently convert the per-turn reset into sticky-for-session behavior.

Assertion needs an adopt-external-change rule so it cannot overwrite a deliberate choice made between turns. The plugin compares the delegated route against the route it last asserted: an equal route is the log echoing the plugin's own write, so the cursor's route stands. A different route means a user selection or settings change moved it, so the plugin stages that route and the next assembly promotes it to primary, restarting the chain from it.

Surface agreement is therefore conditional rather than absolute. The plugin never initiates a split: a route it chooses to change is staged and promoted at the next assembly, so the prompt and the request always name the same model. A split occurs only where the loop's own retry semantics force one — a failover discovered mid-step reroutes the retry while that step's system prompt is already rendered — and it heals at the next assembly. The prompt-variables Agent Note anticipates exactly this case.

Switching to a backup drops any inherited `reasoningEffort`, whose vocabulary is provider-owned and need not exist on the target; re-asserting the primary restores the effort captured with it.

### Failure handling and composition order

The `agent/request-error` listener delegates first and acts only on `undefined`. A downstream `{ kind: 'retry' }` is returned unchanged, so under normal-mode retry the same route always exhausts before failover and the transient-versus-route-permanent distinction needs no second code list: `dsh-llm-retry` short-circuits a code inside its budget, and delegates both an exhausted budget and a code it does not own, which is exactly when failover should act.

Delegating first also keeps the plugin correct when it is mounted before `dsh-llm-retry` under normal mode. Always mode is the exception and fixes the recommended order: it delegates before applying its own unbounded retry, so it must be the outer listener — `dsh-llm-retry` first, `dsh-llm-fallback` second — or failover never fires. It also inverts the precedence it establishes: consulting downstream first means the chain cascades on the very first failure with no same-route retry, and only once the chain is exhausted does always mode retry without limit, against the final backup rather than the primary. `dsh-compaction-basic` owns `CONTEXT_WINDOW_EXCEEDED`, which is outside `failoverCodes`, so the three compose in any order for that code.

The payload carries `provider` but no `model`, so the pre-failover route is captured from `session.requestHeader()?.config` before the first move. A cursor already at the last backup returns `undefined` and the failure stays terminal; the chain never wraps.

`NO_ADAPTER` reaches this listener: `buildRequest` tolerates it from `prepareCall()` because `llm/stream` middleware may serve an unregistered route, and `LlmRuntime` then normalizes final-adapter selection failure into a terminal `finish` per [terminal LLM stream failures](../../implemented/architecture/2026-07-29-terminal-llm-stream-failures.md).

### Durable event

One non-surface `SessionEventMap` member, `llm/fallback`, carries the turn, step, the `from` and `to` routes, the new cursor, and the `LlmFailure`. It is required-on-read, matching `llm/retry`: `Session.append()` accepts only a `SurfaceIntent` argument, so no writer path sets the envelope's `ignorable` marker, and the default over-refuses an unknown type rather than resuming a session whose route history it cannot read. The route change itself is already durable: the loop appends `request/header` with reason `change` and `request/context` whenever the resolved route differs, which is what makes the switch reconstructable and what lets the model picker report the live backup without new wiring.

A separately published `./invariant` companion checks that every `llm/fallback` names the current open turn and latest closed step, that its `from` route matches the failed request's durable header, that its `to` route matches the next `request/header`, and that the cursor advances by exactly one and never exceeds the configured chain length.

## Alternatives considered

- **Reuse `installModelSelection` per agent at `agent/created`** — rejected on two counts: it registers after ApiProxy's setup-time install and is therefore overridden, and its unconditional override cannot express the cursor-`0` re-assertion that the log read-through requires.
- **Keep the helper and force placement with `prepend: true`** — rejected because it fixes only the ordering half; the unconditional override still leaves the per-turn reset broken in the default ApiProxy composition.
- **Extend `installModelSelection` to accept a resolver** — deferred rather than rejected. It would give both consumers one code path, and the pre-release stance permits the core edit, but it widens a surface two entry points depend on for a conditional that is so far specific to this plugin. Revisit if a third consumer appears.
- **Wrap `ctx.llm.stream()` and re-issue against another model inside one call** — rejected because a raw stream cannot durably separate already-emitted chunks, and the switch would produce no `request/header` event, breaking the model-visible-implies-logged invariant.
- **Configure the full chain including the primary** — rejected because the plugin is outermost and would override a user's manual model selection on every request, not only after a failure.
- **Return to the primary on a cooldown timer** — rejected for now because it makes behavior depend on a clock, which snapshot fixtures must then normalize. The per-turn reset re-probes often enough, at a cost of one failed request per turn while a limit is still active.
- **Put `failover` on `LlmFailure`** — already rejected by the bounded-recovery note: adapters report facts and deployment policy decides action.

## Consequences

A deployment configured with several interchangeable routes now survives a route-permanent failure — expired credential, exhausted quota, or an unregistered adapter — without operator intervention, and a transient failure still exhausts `dsh-llm-retry`'s budget on the same route before the cursor moves. The durable `llm/fallback` event and the `request/header` change it accompanies make every move reconstructable and let a client report the live route without new wiring.

What it costs: semantic interchangeability across the chain is asserted by configuration, not verified by the plugin — a backup lacking a tool or reasoning option the session needs fails for a different reason once selected. A switch always abandons the failing provider's prefix cache, so the first request on a backup bills full input tokens regardless of why the move happened. Retry, compaction, and failover each hold independent budgets that add rather than share, so a pathological turn can reach retries times chain length requests before ending. Always mode composes only in the documented mount order — `dsh-llm-retry` before `dsh-llm-fallback` — because its unbounded same-route retry never yields to a later listener; the reverse order leaves the chain unreachable.

## Testing

`packages/llm/llm-fallback/tests/config.spec.ts` covers `resolveConfig()`: the default and configured `failoverCodes`, and rejection of an empty chain, a duplicate route, an empty configured code list, and an unknown key. `tests/state.spec.ts` covers the pure cursor logic — `targetFor()`, `adoptIfChanged()`, `advance()`, `resetForTurn()`, and `promotePending()` — including the captured-primary detach, the external-change staging path, and the turn guard against mid-turn re-probing. `tests/fallback.spec.ts` drives the assembled plugin against a mock LLM route: failover to the first backup after a rate limit, first-failure failover on `AUTH` with no intervening retry, delegating a code the plugin does not own, walking the whole chain to a terminal failure, returning to the primary on the next user turn but not on mid-turn steering, preferring a downstream retry over failover, disposal stopping further failover, and an externally replaced route deferring to the following turn. `tests/invariant.spec.ts` exercises the `./invariant` companion against constructed session histories: well-formed records, a mid-step cascade through several backups, an unrelated request-header change, the complete failure payload, out-of-turn or out-of-step records, a `from`/`to` mismatch against the durable header, cursor sequencing (including a skipped, repeated, non-positive, or fractional cursor), a fresh sequence per turn and per step, and validation on both late plugin registration and new-session creation. `tests/loader-composition.spec.ts` mounts `dsh-llm-retry` and `dsh-llm-fallback` together through the real Cordis loader and proves the composed chain activates and that a malformed entry — empty `backups`, a duplicate route, or an unknown key — fails load. `tests/scaffold.spec.ts` and `tests/types.spec.ts` pin the plugin name and the browser-safe payload's identity with the session event.
