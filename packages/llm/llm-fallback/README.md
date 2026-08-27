# `@deepseek-ai/dsh-llm-fallback`

English | [中文](README.zh.md)

Function plugin that fails a session over to an ordered list of backup provider/model routes when the current route's request fails with a configured code. It owns no route of its own: the primary is whatever route the session already resolves through model selection, so a deployment default and a user pick both stay authoritative, and the plugin only moves the cursor forward from there. The cursor is not sticky: it returns to the primary at the start of the next user turn, unconditionally re-probing the primary even while it is still failing, regardless of the step, the request, or elapsed time; mid-turn steering does not trigger this reset, so a failover cascade within one open turn is unaffected.

```yaml
- name: '@deepseek-ai/dsh-llm-retry'
- name: '@deepseek-ai/dsh-llm-fallback'
  config:
    backups:
      - { provider: deepseek, model: deepseek-v3 }
      - { provider: anthropic, model: claude-opus-5 }
    failoverCodes: [RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, EMPTY_RESPONSE, AUTH, QUOTA, INVALID_CREDENTIAL, MISSING_CREDENTIAL, NO_ADAPTER]
```

`backups` is required and must list at least one route with no duplicates. `failoverCodes` is optional and, when present, must be non-empty; omitting it uses the ten codes in `src/config.ts`. The schema rejects an entry with no `backups` key, and any field whose value has the wrong type, naming the field. Four further misconfigurations fail at plugin load: an empty `backups` list, a duplicate backup route, an empty `failoverCodes` list when the key is present, and any config key outside `backups` and `failoverCodes` — schemastery passes unknown keys through rather than rejecting them, so a typo such as `backup:` would otherwise load cleanly under the silently unaffected defaults.

`dsh-llm-fallback` always delegates to the rest of the `agent/request-error` waterfall before acting, so under normal retry mode it composes correctly regardless of mount order relative to `dsh-llm-retry`: the same route exhausts its retry budget first, and the cursor only moves once that budget delegates. Always mode needs the order shown above: `dsh-llm-retry` mounted first registers as the outer listener, delegates into `dsh-llm-fallback` before applying its own unbounded same-route retry, and lets the chain cascade on the first eligible failure; mounted the other way round, always mode's unbounded retry never yields and the chain never advances. `dsh-compaction-basic` owns `CONTEXT_WINDOW_EXCEEDED`, which is outside `failoverCodes` by default, so it composes with either mode in any order.

## Model Experience

### Model-request failover

#### What the model sees

No `llm/fallback` event, route change, or failed output is model-visible. The retry turn reconstructs the request from durable surface history against the newly selected route.

#### Token effect

Each move to a backup is a new provider request and repeats input-token billing.

#### KV Cache effect

A switch abandons the prior provider's prefix cache; the first request on a backup bills full input tokens.

## Known Limitations and Deferred Work

- **Semantic interchangeability is asserted, not verified.** The plugin cannot prove a backup supports the session's tools or reasoning options; a deployment that lists a weaker model owns that choice. Context-window differences are already safe because compaction re-resolves capacity from the durable route on every check.
- **The per-turn reset to the primary costs one wasted request per turn while the primary is still failing.** Every new user turn re-probes the primary unconditionally; a primary still past its rate limit or still holding a rejected credential fails that request again, and only then does the cursor re-advance to a working backup, so the failed request and the cache invalidation it triggers repeat every turn for as long as the primary stays down. This is distinct from the one-time cache cost described in `#### KV Cache effect` above, which happens once per switch rather than every turn; a cooldown timer was considered and rejected because it makes behavior depend on a clock that snapshot fixtures would then need to normalize.
- **A quiet failover changes which model answered.** The durable event and the header change make it visible, but a client that surfaces neither will show no explanation for a change in model behavior. Visibility is also asymmetric: a move to a backup produces both `llm/fallback` and a `request/header` change, while the per-turn return to the primary produces only the header change, so a client that tracks `llm/fallback` to explain model changes sees the session leave the primary but never sees it come back.
- **Overlapping recovery budgets add.** Retry, compaction, and failover each hold their own limits, so a pathological turn can consume retries times chain length requests before ending.
- **Always-mode retry never yields**, so a deployment combining it with failover must accept the documented mount order or failover is unreachable.
