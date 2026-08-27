import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ProviderRequestId } from '@deepseek-ai/dsh-llm'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as FallbackInvariant from '@deepseek-ai/dsh-llm-fallback/invariant'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(FallbackInvariant)
  return ctx
}

/** Open turn 1/step 1 with a durable header naming `primary/m`. */
function openStep(ctx: Context, id: string, turn = 1, step = 1) {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  session.append('request/header', {
    header: { config: { provider: 'primary', model: 'm' } },
    reason: 'initial',
  })
  return session
}

const failure = { message: 'limited', code: 'RATE_LIMIT', status: 429 }
const move = {
  turn: 1,
  step: 1,
  from: { provider: 'primary', model: 'm' },
  to: { provider: 'b1', model: 'm1' },
  cursor: 1,
  failure,
}

describe('llm-fallback invariants', () => {
  it('accepts a well-formed record and its retried request header', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'fallback-invariant-valid')

    expect(() => {
      session.append('llm/fallback', move)
      session.append('request/header', {
        header: { config: { provider: 'b1', model: 'm1' } },
        reason: 'change',
      })
    }).not.toThrow()
  })

  it('accepts a mid-step cascade through several backups with an advancing cursor', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'fallback-invariant-cascade')

    expect(() => {
      session.append('llm/fallback', move)
      session.append('request/header', {
        header: { config: { provider: 'b1', model: 'm1' } },
        reason: 'change',
      })
      session.append('llm/fallback', {
        ...move,
        from: { provider: 'b1', model: 'm1' },
        to: { provider: 'b2', model: 'm2' },
        cursor: 2,
      })
      session.append('request/header', {
        header: { config: { provider: 'b2', model: 'm2' } },
        reason: 'change',
      })
    }).not.toThrow()
  })

  it('accepts an unrelated request header change with no preceding failover', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'fallback-invariant-unrelated-header')

    expect(() => {
      session.append('request/header', {
        header: { config: { provider: 'other', model: 'm2' } },
        reason: 'change',
      })
    }).not.toThrow()
  })

  it('validates the complete durable failure payload', async () => {
    const ctx = await setup()
    const complete = openStep(ctx, 'fallback-invariant-complete-failure')
    expect(() => {
      complete.append('llm/fallback', {
        ...move,
        failure: {
          message: 'limited',
          code: 'RATE_LIMIT',
          status: 429,
          providerRetryAfterMs: 25,
          requestId: ProviderRequestId('request-1'),
        },
      })
    }).not.toThrow()

    const invalidFailures: readonly [string, unknown, RegExp][] = [
      ['null', null, /failure must be an object/],
      ['message-type', { message: 1, code: 'RATE_LIMIT' }, /failure\.message/],
      ['message-empty', { message: '', code: 'RATE_LIMIT' }, /failure\.message/],
      ['code-type', { message: 'failed', code: 1 }, /failure\.code/],
      ['code-empty', { message: 'failed', code: '' }, /failure\.code/],
      ['status-type', { message: 'failed', code: 'RATE_LIMIT', status: 429.5 }, /failure\.status/],
      ['status-low', { message: 'failed', code: 'RATE_LIMIT', status: 99 }, /failure\.status/],
      ['status-high', { message: 'failed', code: 'RATE_LIMIT', status: 600 }, /failure\.status/],
      [
        'retry-after-type',
        { message: 'failed', code: 'RATE_LIMIT', providerRetryAfterMs: '25' },
        /failure\.providerRetryAfterMs/,
      ],
      [
        'retry-after-zero',
        { message: 'failed', code: 'RATE_LIMIT', providerRetryAfterMs: 0 },
        /failure\.providerRetryAfterMs/,
      ],
      ['request-id-type', { message: 'failed', code: 'RATE_LIMIT', requestId: 1 }, /failure\.requestId/],
      ['request-id-empty', { message: 'failed', code: 'RATE_LIMIT', requestId: '' }, /failure\.requestId/],
    ]
    for (const [name, invalidFailure, message] of invalidFailures) {
      const session = openStep(ctx, `fallback-invariant-failure-${name}`)
      expect(() => {
        session.append('llm/fallback', { ...move, failure: invalidFailure } as never)
      }).toThrow(message)
    }
  })

  it('rejects records outside the currently open turn and step', async () => {
    const ctx = await setup()
    const absent = ctx.sessions.create(SessionId('fallback-invariant-no-turn'))
    expect(() => {
      absent.append('llm/fallback', move)
    }).toThrow(/inside an open turn/)

    const wrongTurn = openStep(ctx, 'fallback-invariant-wrong-turn')
    expect(() => {
      wrongTurn.append('llm/fallback', { ...move, turn: 2 })
    }).toThrow(/open turn is 1/)

    const closedStep = openStep(ctx, 'fallback-invariant-closed-step')
    closedStep.append('step/end', { turn: 1, step: 1 })
    expect(() => {
      closedStep.append('llm/fallback', move)
    }).toThrow(/inside an open step/)

    const noStep = ctx.sessions.create(SessionId('fallback-invariant-no-step'))
    noStep.append('turn/start', { turn: 1 })
    expect(() => {
      noStep.append('llm/fallback', move)
    }).toThrow(/inside an open step/)

    const wrongStep = openStep(ctx, 'fallback-invariant-wrong-step')
    expect(() => {
      wrongStep.append('llm/fallback', { ...move, step: 2 })
    }).toThrow(/open step is 1\/1/)

    const closedTurn = openStep(ctx, 'fallback-invariant-closed-turn')
    closedTurn.append('step/end', { turn: 1, step: 1 })
    closedTurn.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(() => {
      closedTurn.append('llm/fallback', move)
    }).toThrow(/inside an open turn/)
  })

  it('rejects a record with no durable request header in force', async () => {
    const ctx = await setup()
    // Unlike openStep(), this never logs a `request/header`: `routeInForce()`
    // has nothing to find, matching a corrupted or hand-built session log —
    // the real plugin always logs a header before it can ever observe a
    // failure (packages/core/agent-loop/src/agent.ts:483-488).
    const session = ctx.sessions.create(SessionId('fallback-invariant-no-header'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => {
      session.append('llm/fallback', move)
    }).toThrow(/must be appended after a durable request header/)
  })

  it('rejects a from route that does not match the durable header in force', async () => {
    const ctx = await setup()
    const wrongProvider = openStep(ctx, 'fallback-invariant-from-provider-mismatch')
    expect(() => {
      wrongProvider.append('llm/fallback', { ...move, from: { provider: 'other', model: 'm' } })
    }).toThrow(/does not match the failed request route primary\/m/)

    const wrongModel = openStep(ctx, 'fallback-invariant-from-model-mismatch')
    expect(() => {
      wrongModel.append('llm/fallback', { ...move, from: { provider: 'primary', model: 'other' } })
    }).toThrow(/does not match the failed request route primary\/m/)
  })

  it('rejects a malformed to route with no later request header to lean on', async () => {
    const emptyProvider = await setup()
    const emptyProviderSession = openStep(emptyProvider, 'fallback-invariant-to-provider-empty')
    expect(() => {
      emptyProviderSession.append('llm/fallback', { ...move, to: { provider: '', model: 'm1' } })
    }).toThrow(/to\.provider must be a non-empty string/)

    const wrongModelType = await setup()
    const wrongModelTypeSession = openStep(wrongModelType, 'fallback-invariant-to-model-type')
    expect(() => {
      wrongModelTypeSession.append('llm/fallback', {
        ...move, to: { provider: 'b1', model: null },
      } as never)
    }).toThrow(/to\.model must be a non-empty string/)
  })

  it('accepts successive cursors and rejects a skipped or repeated cursor', async () => {
    const ctx = await setup()
    const skip = openStep(ctx, 'fallback-invariant-cursor-skip')
    skip.append('llm/fallback', move)
    skip.append('request/header', {
      header: { config: { provider: 'b1', model: 'm1' } },
      reason: 'change',
    })
    expect(() => {
      skip.append('llm/fallback', {
        ...move, from: { provider: 'b1', model: 'm1' }, to: { provider: 'b2', model: 'm2' }, cursor: 3,
      })
    }).toThrow(/cursor 3 must equal 2/)

    const repeat = openStep(ctx, 'fallback-invariant-cursor-repeat')
    repeat.append('llm/fallback', move)
    repeat.append('request/header', {
      header: { config: { provider: 'b1', model: 'm1' } },
      reason: 'change',
    })
    expect(() => {
      repeat.append('llm/fallback', {
        ...move, from: { provider: 'b1', model: 'm1' }, to: { provider: 'b2', model: 'm2' }, cursor: 1,
      })
    }).toThrow(/cursor 1 must equal 2/)
  })

  it('rejects a non-positive or fractional cursor', async () => {
    const zero = await setup()
    const zeroSession = openStep(zero, 'fallback-invariant-cursor-zero')
    expect(() => {
      zeroSession.append('llm/fallback', { ...move, cursor: 0 })
    }).toThrow(/positive safe integer/)

    const fraction = await setup()
    const fractionSession = openStep(fraction, 'fallback-invariant-cursor-fraction')
    expect(() => {
      fractionSession.append('llm/fallback', { ...move, cursor: 1.5 })
    }).toThrow(/positive safe integer/)
  })

  it('starts a fresh cursor sequence for a new turn number without re-checking a header an earlier failover already matched', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'fallback-invariant-turn-reset')
    session.append('llm/fallback', move)
    session.append('request/header', {
      header: { config: { provider: 'b1', model: 'm1' } },
      reason: 'change',
    })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('request/header', {
      header: { config: { provider: 'primary', model: 'm' } },
      reason: 'change',
    })
    expect(() => {
      session.append('llm/fallback', { ...move, turn: 2, step: 1, cursor: 1 })
    }).not.toThrow()
  })

  it('restarts the cursor sequence at a later step within the same turn without re-checking a header an earlier failover already matched', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'fallback-invariant-step-reset')
    session.append('llm/fallback', move)
    session.append('request/header', {
      header: { config: { provider: 'b1', model: 'm1' } },
      reason: 'change',
    })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    // A route promoted by an unrelated `agent/request` participant between
    // assemblies (`promotePending` in ./state.ts) restarts the chain from a
    // new primary; the cursor legitimately restarts at `1` in this step even
    // though step 1 already reached `1` in the same turn.
    session.append('request/header', {
      header: { config: { provider: 'primary2', model: 'm2' } },
      reason: 'change',
    })
    expect(() => {
      session.append('llm/fallback', {
        ...move,
        step: 2,
        from: { provider: 'primary2', model: 'm2' },
        to: { provider: 'b1', model: 'm1' },
        cursor: 1,
      })
    }).not.toThrow()
  })

  it('rejects a retried request header naming a route other than the pending target', async () => {
    const ctx = await setup()
    const bothWrong = openStep(ctx, 'fallback-invariant-header-mismatch')
    bothWrong.append('llm/fallback', move)
    expect(() => {
      bothWrong.append('request/header', {
        header: { config: { provider: 'wrong', model: 'm9' } },
        reason: 'change',
      })
    }).toThrow(/request\/header route wrong\/m9 must match the pending llm\/fallback target b1\/m1/)

    const wrongModel = openStep(ctx, 'fallback-invariant-header-model-mismatch')
    wrongModel.append('llm/fallback', move)
    expect(() => {
      wrongModel.append('request/header', {
        header: { config: { provider: 'b1', model: 'm9' } },
        reason: 'change',
      })
    }).toThrow(/request\/header route b1\/m9 must match the pending llm\/fallback target b1\/m1/)

    const wrongProvider = openStep(ctx, 'fallback-invariant-header-provider-mismatch')
    wrongProvider.append('llm/fallback', move)
    expect(() => {
      wrongProvider.append('request/header', {
        header: { config: { provider: 'wrong', model: 'm1' } },
        reason: 'change',
      })
    }).toThrow(/request\/header route wrong\/m1 must match the pending llm\/fallback target b1\/m1/)
  })

  it('retires a pending target when the step that owns the record closes', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'fallback-invariant-unconfirmed-target')
    // A backup naming the route already in force appends no `request/header`
    // of its own, so this record's `to` is never confirmed. The header a later
    // turn appends belongs to that turn's own route selection, not to this
    // record's retry.
    session.append('llm/fallback', { ...move, to: { provider: 'primary', model: 'm' } })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })

    expect(() => {
      session.append('request/header', {
        header: { config: { provider: 'other', model: 'm9' } },
        reason: 'change',
      })
    }).not.toThrow()
  })

  it('retires a pending target when a later step opens without the owning step closing', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'fallback-invariant-unclosed-step')
    // A log truncated between the record and its retry keeps no `step/end`.
    // The header a resumed session appends for its own first request belongs
    // to that request's route, not to this record's retry.
    session.append('llm/fallback', move)
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })

    expect(() => {
      session.append('request/header', {
        header: { config: { provider: 'other', model: 'm9' } },
        reason: 'resume',
      })
    }).not.toThrow()
  })

  it('validates existing session histories on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('fallback-invariant-late'))
    session.append('step/start', { turn: 1, step: 1 })
    session.append('llm/fallback', move)
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(FallbackInvariant)).rejects.toThrow(/inside an open turn/)
  })

  it('accepts a valid session history and a correct retried header on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = openStep(ctx, 'fallback-invariant-late-valid')
    session.append('llm/fallback', move)
    session.append('request/header', {
      header: { config: { provider: 'b1', model: 'm1' } },
      reason: 'change',
    })
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(FallbackInvariant)).resolves.toBeDefined()
  })

  it('rejects a record whose turn disagrees with the open step\'s own turn', async () => {
    const ctx = await setup()
    // `turn/start` and `step/start` disagree, so the turn check against the
    // open turn passes and only the open step's turn catches the record.
    const session = ctx.sessions.create(SessionId('fallback-invariant-step-turn-mismatch'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('request/header', {
      header: { config: { provider: 'primary', model: 'm' } },
      reason: 'initial',
    })
    expect(() => {
      session.append('llm/fallback', move)
    }).toThrow(/open step is 2\/1/)
  })

  it('validates a stored request header against its pending failover on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = openStep(ctx, 'fallback-invariant-late-header')
    session.append('llm/fallback', move)
    session.append('request/header', {
      header: { config: { provider: 'wrong', model: 'm9' } },
      reason: 'change',
    })
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(FallbackInvariant))
      .rejects.toThrow(/request\/header route wrong\/m9 must match the pending llm\/fallback target b1\/m1/)
  })

  it('validates a session restored through the persistence seed path', async () => {
    // `dsh-session-persistence` restores a stored log through
    // `sessions.prepare(id, { seed, meta, seedSource: 'persistence' })` and
    // then enters and announces it
    // (packages/session/session-persistence/src/coordinator.ts:905), so
    // `session/created` carries the whole restored history. Nothing appends,
    // so that announcement is the only validation a resumed session takes.
    const stored = new Context()
    await stored.plugin(SessionStore)
    const origin = openStep(stored, 'fallback-invariant-restored')
    origin.append('llm/fallback', { ...move, from: { provider: 'other', model: 'm' } })
    const seed = structuredClone(origin.events) as SessionEvent[]
    const meta = structuredClone(origin.header)

    const ctx = await setup()
    expect(() => {
      const restored = ctx.sessions.prepare(SessionId('fallback-invariant-restored'), {
        seed,
        meta,
        seedSource: 'persistence',
      })
      ctx.sessions.enter(restored)
      ctx.sessions.announce(restored)
    }).toThrow(/does not match the failed request route primary\/m/)
  })

  it('validates newly created sessions the same way as pre-existing ones', async () => {
    const ctx = await setup()
    expect(() => {
      const session: Session = ctx.sessions.create(SessionId('fallback-invariant-created'))
      session.append('llm/fallback', move)
    }).toThrow(/inside an open turn/)
  })
})
