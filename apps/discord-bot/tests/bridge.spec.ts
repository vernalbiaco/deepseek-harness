import { describe, expect, it } from 'vitest'
import type { ClientResponse, MuxFrame, RpcId, RpcRequest, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import { Bridge, type ApprovalPrompt, type BridgeApi, type Logger, type Poster, type QuestionPrompt } from '../src/bridge.ts'
import { memoryThreadStore } from '../src/state.ts'

const USER = '111111111'
const STRANGER = '222222222'
const SID = 'session-1' as SessionId
const WID = 'ws-1' as WorkspaceId
let seq = 0

function workspaceView(title: string): WorkspaceView {
  return { workspaceId: WID, path: '/workspaces/discord', title, sessionIds: [], createdAt: 't', updatedAt: 't' }
}

function event(type: string, data: unknown): SessionEvent {
  return { type, seq: seq++, time: 1, data } as unknown as SessionEvent
}

function frame(payload: MuxFrame, rpcId = `rpc-${seq++}`): RpcRequest<MuxFrame> {
  return { rpcId: rpcId as RpcId, payload }
}

function sessionEvent(type: string, data: unknown, view?: MuxFrame & { type: 'session/event' } extends infer F ? (F extends { view?: infer V } ? V : never) : never): RpcRequest<MuxFrame> {
  return frame({ type: 'session/event', sessionId: SID, event: event(type, data), ...(view === undefined ? {} : { view }) })
}

class FakeApi implements BridgeApi {
  readonly created: unknown[] = []
  readonly prompts: unknown[] = []
  readonly cancels: unknown[] = []
  readonly responses: ClientResponse[] = []
  acceptResponses = true
  failPrompt = false
  failCreate = false
  muxOpens = 0
  muxFrames: RpcRequest<MuxFrame>[][] = []
  readonly workspaceCalls: string[] = []
  /** Directory state for workspace.create: missing until host.createDirectory runs. */
  directoryExists = true
  existingTitle = 'discord'
  failRename = false
  /** Workspaces the host already lists. */
  listed: WorkspaceView[] = []

  readonly workspace: BridgeApi['workspace'] = {
    list: () => {
      this.workspaceCalls.push('list')
      return Promise.resolve({ rpcId: 'x' as RpcId, result: { ok: true as const, value: { items: this.listed, archivedSessionIds: [] } } })
    },
    create: (payload) => {
      this.workspaceCalls.push(`create:${payload.path}`)
      if (!this.directoryExists) {
        return Promise.resolve({ rpcId: 'x' as RpcId, result: { ok: false as const, error: { code: 'workspace-invalid-path' as const, message: 'missing', details: { path: payload.path } } } })
      }
      return Promise.resolve({ rpcId: 'x' as RpcId, result: { ok: true as const, value: { workspace: workspaceView(this.existingTitle), created: false } } })
    },
    rename: (payload) => {
      this.workspaceCalls.push(`rename:${payload.title}`)
      if (this.failRename) return Promise.resolve({ rpcId: 'x' as RpcId, result: { ok: false as const, error: { code: 'workspace-not-found' as const, message: 'gone', details: { workspaceId: payload.workspaceId } } } })
      return Promise.resolve({ rpcId: 'x' as RpcId, result: { ok: true as const, value: { workspace: workspaceView(payload.title) } } })
    },
  }

  readonly host: BridgeApi['host'] = {
    createDirectory: (payload) => {
      this.workspaceCalls.push(`mkdir:${payload.path}/${payload.name}`)
      this.directoryExists = true
      return Promise.resolve({ rpcId: 'x' as RpcId, result: { ok: true as const, value: { path: `${payload.path}/${payload.name}` } } })
    },
  }

  readonly sessions: BridgeApi['sessions'] = {
    create: (payload) => {
      this.created.push(payload)
      if (this.failCreate) return Promise.resolve({ rpcId: 'x' as RpcId, result: { ok: false as const, error: { code: 'internal' as const, message: 'no host', details: {} } } })
      return Promise.resolve({ rpcId: 'x' as RpcId, result: { ok: true as const, value: { sessionId: SID } } })
    },
    prompt: (payload) => {
      this.prompts.push(payload)
      if (this.failPrompt) {
        return Promise.resolve({ rpcId: 'x' as RpcId, result: { ok: false as const, error: { code: 'model-unavailable' as const, message: 'no route', details: { provider: 'p', model: 'm' } } } })
      }
      return Promise.resolve({ rpcId: 'x' as RpcId, result: { ok: true as const, value: { accepted: true as const } } })
    },
    cancel: (payload) => {
      this.cancels.push(payload)
      return Promise.resolve({ rpcId: 'x' as RpcId, result: { ok: true as const, value: { accepted: true as const } } })
    },
  }

  readonly events: BridgeApi['events'] = {
    mux: (_payload, _signal, onOpen) => {
      const batch = this.muxFrames.shift() ?? []
      this.muxOpens += 1
      const opens = this.muxOpens
      async function* generate(this: FakeApi): AsyncGenerator<RpcRequest<MuxFrame>> {
        onOpen?.()
        for (const item of batch) yield item
        if (opens === 2) throw new Error('socket dropped')
      }
      return generate.call(this)
    },
  }

  respond = (message: ClientResponse): Promise<{ accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' }> => {
    this.responses.push(message)
    return Promise.resolve(this.acceptResponses ? { accepted: true } : { accepted: false, reason: 'not-pending' })
  }
}

class FakePoster implements Poster {
  readonly calls: string[] = []
  readonly approvals: ApprovalPrompt[] = []
  readonly questions: QuestionPrompt[] = []
  throwOnLine = false
  postText(threadId: string, text: string): Promise<void> {
    this.calls.push(`text:${threadId}:${text}`)
    return Promise.resolve()
  }
  postLine(threadId: string, line: string): Promise<void> {
    if (this.throwOnLine) return Promise.reject(new Error('discord down'))
    this.calls.push(`line:${threadId}:${line}`)
    return Promise.resolve()
  }
  postApproval(threadId: string, prompt: ApprovalPrompt): Promise<void> {
    this.approvals.push(prompt)
    this.calls.push(`approval:${threadId}:${prompt.toolName}`)
    return Promise.resolve()
  }
  resolveApproval(threadId: string, rpcId: RpcId, outcome: string): Promise<void> {
    this.calls.push(`approved:${threadId}:${rpcId}:${outcome}`)
    return Promise.resolve()
  }
  postQuestion(threadId: string, prompt: QuestionPrompt): Promise<void> {
    this.questions.push(prompt)
    this.calls.push(`question:${threadId}:${prompt.questions.length}`)
    return Promise.resolve()
  }
  resolveQuestion(threadId: string, rpcId: RpcId, outcome: string): Promise<void> {
    this.calls.push(`questioned:${threadId}:${rpcId}:${outcome}`)
    return Promise.resolve()
  }
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} }

function harness(options: { threads?: [string, string][]; workspace?: boolean; log?: Logger } = {}) {
  const api = new FakeApi()
  const poster = new FakePoster()
  const store = memoryThreadStore(options.threads ?? [])
  const bridge = new Bridge({
    api,
    poster,
    store,
    allowedUserIds: new Set([USER]),
    ...(options.workspace === true ? { workspace: { path: '/workspaces/discord', title: 'Discord' } } : {}),
    log: options.log ?? silent,
    reconnect: { initialDelayMs: 1, maxDelayMs: 2 },
  })
  return { api, poster, store, bridge }
}

describe('Bridge messages', () => {
  it('creates a session on the first message, binds the thread, and queues the prompt', async () => {
    const { api, store, bridge } = harness()
    expect(await bridge.onUserMessage('t1', USER, '  hello  ')).toBe('prompted')
    expect(api.created).toEqual([{}])
    expect(api.prompts).toEqual([{ sessionId: SID, mode: 'queue', content: [{ type: 'text', text: 'hello' }] }])
    expect(store.get('t1')).toBe(SID)
    expect(bridge.knowsThread('t1')).toBe(true)
    expect(await bridge.onUserMessage('t1', USER, 'again')).toBe('prompted')
    expect(api.created).toHaveLength(1)
  })

  it('ignores strangers and empty text', async () => {
    const warned: string[] = []
    const { api, bridge } = harness({ log: { ...silent, warn: m => warned.push(m) } })
    expect(await bridge.onUserMessage('t1', STRANGER, 'hi')).toBe('ignored')
    expect(await bridge.onUserMessage('t1', USER, '   ')).toBe('ignored')
    expect(api.created).toHaveLength(0)
    expect(warned[0]).toContain('not allowlisted')
    expect(bridge.isAllowed(STRANGER)).toBe(false)
  })

  it('reports a refused prompt and a failed session start in the thread', async () => {
    const { api, poster, bridge } = harness()
    api.failPrompt = true
    expect(await bridge.onUserMessage('t1', USER, 'hi')).toBe('failed')
    expect(poster.calls).toEqual(['line:t1:⚠️ The harness refused the prompt (model-unavailable): no route'])
    const second = harness()
    second.api.failCreate = true
    expect(await second.bridge.onUserMessage('t2', USER, 'hi')).toBe('failed')
    expect(second.poster.calls).toEqual(['line:t2:⚠️ Could not start a session: internal: no host'])
  })

  it('cancels the bound session and explains when there is none', async () => {
    const { api, poster, bridge } = harness({ threads: [['t1', SID]] })
    expect(await bridge.onUserMessage('t1', USER, '!cancel')).toBe('cancelled')
    expect(api.cancels).toEqual([{ sessionId: SID }])
    expect(await bridge.onUserMessage('t9', USER, '!cancel')).toBe('ignored')
    expect(poster.calls).toEqual(['line:t9:Nothing to cancel here yet.'])
  })
})

describe('Bridge workspace', () => {
  it('registers the directory, titles it, and files sessions under it', async () => {
    const { api, bridge } = harness({ workspace: true })
    api.directoryExists = false
    await bridge.ensureWorkspace()
    expect(api.workspaceCalls).toEqual(['list', 'create:/workspaces/discord', 'mkdir:/workspaces/discord', 'create:/workspaces/discord', 'rename:Discord'])
    await bridge.onUserMessage('t1', USER, 'hi')
    expect(api.created).toEqual([{ workspaceId: WID }])
  })

  it('adopts an existing workspace by title, whatever its directory', async () => {
    const { api, bridge } = harness({ workspace: true })
    api.listed = [{ ...workspaceView('Discord'), workspaceId: 'ws-user' as WorkspaceId, path: '/workspaces/Elsewhere' }]
    await bridge.ensureWorkspace()
    expect(api.workspaceCalls).toEqual(['list'])
    await bridge.onUserMessage('t1', USER, 'hi')
    expect(api.created).toEqual([{ workspaceId: 'ws-user' }])
  })

  it('leaves a correctly titled registration alone and is a no-op without one', async () => {
    const { api, bridge } = harness({ workspace: true })
    api.existingTitle = 'Discord'
    await bridge.ensureWorkspace()
    expect(api.workspaceCalls).toEqual(['list', 'create:/workspaces/discord'])
    const plain = harness()
    await plain.bridge.ensureWorkspace()
    expect(plain.api.workspaceCalls).toEqual([])
  })

  it('fails loudly when the host refuses the title', async () => {
    const { api, bridge } = harness({ workspace: true })
    api.failRename = true
    await expect(bridge.ensureWorkspace()).rejects.toThrow('cannot title workspace /workspaces/discord: gone')
  })
})

describe('Bridge frames', () => {
  it('projects tool calls, failures, assistant text, and turn outcomes into the thread', async () => {
    const { poster, bridge } = harness({ threads: [['t1', SID]] })
    await bridge.handleFrame(sessionEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"pwd"}' }, { for: 'call', view: { card: 'terminal', title: 'pwd' } }))
    await bridge.handleFrame(sessionEvent('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'Error: no sandbox' }] }] }, error: { name: 'E', code: 'SANDBOX_UNAVAILABLE' } }))
    await bridge.handleFrame(sessionEvent('tool/call', { turn: 1, step: 2, callId: 'c2', name: 'read_file', arguments: '{}' }))
    await bridge.handleFrame(sessionEvent('tool/result', { turn: 1, step: 2, message: { content: [{ type: 'tool-result', toolCallId: 'c2', content: [] }] } }))
    await bridge.handleFrame(sessionEvent('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'done' }] } }))
    await bridge.handleFrame(sessionEvent('assistant/message', { turn: 1, step: 3, message: { content: [] } }))
    await bridge.handleFrame(sessionEvent('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'X' } } }))
    await bridge.handleFrame(sessionEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    await bridge.handleFrame(sessionEvent('step/start', { turn: 1, step: 1 }))
    expect(poster.calls).toEqual([
      'line:t1:🔧 **bash** pwd',
      'line:t1:❌ **bash** failed (SANDBOX_UNAVAILABLE): Error: no sandbox',
      'line:t1:🔧 **read_file** {}',
      'text:t1:done',
      'line:t1:⚠️ Turn failed: boom',
    ])
  })

  it('ignores sessions it did not create and survives a posting failure', async () => {
    const errors: string[] = []
    const { poster, bridge } = harness({ threads: [['t1', SID]], log: { ...silent, error: m => errors.push(m) } })
    await bridge.handleFrame(frame({ type: 'session/event', sessionId: 'other' as SessionId, event: event('assistant/message', { message: { content: [{ type: 'text', text: 'x' }] } }) }))
    await bridge.handleFrame(frame({ type: 'session/queue', sessionId: SID, items: [] }))
    await bridge.handleFrame(frame({ type: 'stream/error', error: { code: 'internal', message: 'bad', details: {} } }))
    poster.throwOnLine = true
    await bridge.handleFrame(sessionEvent('tool/call', { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{}' }))
    expect(poster.calls).toEqual([])
    expect(errors).toEqual(['event stream error: bad', 'posting to thread t1 failed: discord down'])
  })
})

describe('Bridge approvals', () => {
  const approvalId = 'ap-1' as ApprovalRequestId

  it('posts once per request, answers through respond, and marks the resolution', async () => {
    const { api, poster, bridge } = harness({ threads: [['t1', SID]] })
    const requested = frame({ type: 'approval/requested', sessionId: SID, approvalId, toolName: 'bash', reason: 'escalate' }, 'rpc-a')
    await bridge.handleFrame(requested)
    await bridge.handleFrame(requested)
    expect(poster.approvals).toEqual([{ rpcId: 'rpc-a', toolName: 'bash', reason: 'escalate' }])
    expect(await bridge.onApprovalDecision(STRANGER, 'rpc-a' as RpcId, 'allowed-once')).toBe('ignored')
    expect(await bridge.onApprovalDecision(USER, 'rpc-zzz' as RpcId, 'allowed-once')).toBe('stale')
    expect(await bridge.onApprovalDecision(USER, 'rpc-a' as RpcId, 'allowed-once')).toBe('accepted')
    expect(api.responses).toEqual([{ type: 'client-response', rpcId: 'rpc-a', result: { ok: true, value: { sessionId: SID, approvalId, outcome: 'allowed-once' } } }])
    await bridge.handleFrame(frame({ type: 'approval/resolved', sessionId: SID, approvalId, outcome: 'allowed-once' }))
    await bridge.handleFrame(frame({ type: 'approval/resolved', sessionId: SID, approvalId: 'unknown' as ApprovalRequestId, outcome: 'rejected' }))
    expect(poster.calls.at(-1)).toBe('approved:t1:rpc-a:allowed-once')
    expect(await bridge.onApprovalDecision(USER, 'rpc-a' as RpcId, 'rejected')).toBe('stale')
  })

  it('forgets an approval the host no longer holds', async () => {
    const { api, bridge } = harness({ threads: [['t1', SID]] })
    api.acceptResponses = false
    await bridge.handleFrame(frame({ type: 'approval/requested', sessionId: SID, approvalId, toolName: 'bash' }, 'rpc-b'))
    expect(await bridge.onApprovalDecision(USER, 'rpc-b' as RpcId, 'rejected')).toBe('stale')
    expect(await bridge.onApprovalDecision(USER, 'rpc-b' as RpcId, 'rejected')).toBe('stale')
    expect(api.responses).toHaveLength(1)
  })
})

describe('Bridge questions', () => {
  it('collects one selection per question and sends the answer when complete', async () => {
    const { api, poster, bridge } = harness({ threads: [['t1', SID]] })
    const questions = [
      { id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: 'Many?', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true },
    ]
    const requested = frame({ type: 'question/requested', sessionId: SID, questions }, 'rpc-q')
    await bridge.handleFrame(requested)
    await bridge.handleFrame(requested)
    expect(poster.questions).toHaveLength(1)
    expect(await bridge.onQuestionSelection(STRANGER, 'rpc-q' as RpcId, 0, ['A'])).toBe('ignored')
    expect(await bridge.onQuestionSelection(USER, 'rpc-q' as RpcId, 5, ['A'])).toBe('stale')
    expect(await bridge.onQuestionSelection(USER, 'rpc-q' as RpcId, 0, ['A'])).toBe('accepted')
    expect(api.responses).toHaveLength(0)
    expect(await bridge.onQuestionSelection(USER, 'rpc-q' as RpcId, 1, ['X', 'Y'])).toBe('accepted')
    expect(api.responses).toEqual([{
      type: 'client-response',
      rpcId: 'rpc-q',
      result: { ok: true, value: { sessionId: SID, answer: { answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['X', 'Y'] }] } } },
    }])
    await bridge.handleFrame(frame({ type: 'question/resolved', sessionId: SID, questionRpcId: 'rpc-q' as RpcId, outcome: 'answered' }))
    await bridge.handleFrame(frame({ type: 'question/resolved', sessionId: SID, questionRpcId: 'rpc-q' as RpcId, outcome: 'answered' }))
    expect(poster.calls.filter(c => c.startsWith('questioned:'))).toEqual(['questioned:t1:rpc-q:answered'])
  })

  it('answers a question without options from the next thread message', async () => {
    const { api, bridge } = harness({ threads: [['t1', SID]] })
    await bridge.handleFrame(frame({ type: 'question/requested', sessionId: SID, questions: [{ id: 'q1', question: 'Name?' }] }, 'rpc-f'))
    expect(await bridge.onUserMessage('t1', USER, 'Ada')).toBe('answered')
    expect(api.prompts).toHaveLength(0)
    expect(api.responses[0]?.result).toEqual({ ok: true, value: { sessionId: SID, answer: { answers: [{ id: 'q1', selected: [], custom: 'Ada' }] } } })
    expect(await bridge.onUserMessage('t1', USER, 'next')).toBe('prompted')
  })

  it('drops a question the host no longer holds', async () => {
    const { api, bridge } = harness({ threads: [['t1', SID]] })
    api.acceptResponses = false
    await bridge.handleFrame(frame({ type: 'question/requested', sessionId: SID, questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'A' }] }] }, 'rpc-s'))
    expect(await bridge.onQuestionSelection(USER, 'rpc-s' as RpcId, 0, ['A'])).toBe('stale')
    expect(await bridge.onQuestionSelection(USER, 'rpc-s' as RpcId, 0, ['A'])).toBe('stale')
  })
})

describe('Bridge run', () => {
  it('reopens the stream after a close and after a failure until aborted', async () => {
    const infos: string[] = []
    const { api, poster, bridge } = harness({ threads: [['t1', SID]], log: { ...silent, info: m => infos.push(m), warn: m => infos.push(m), error: m => infos.push(m) } })
    api.muxFrames = [[sessionEvent('assistant/message', { message: { content: [{ type: 'text', text: 'first' }] } })], [], []]
    const controller = new AbortController()
    const running = bridge.run(controller.signal)
    while (api.muxOpens < 3) await new Promise(resolve => setTimeout(resolve, 2))
    controller.abort()
    await running
    expect(poster.calls).toEqual(['text:t1:first'])
    expect(infos).toContain('event stream closed')
    expect(infos).toContain('event stream failed: socket dropped')
  })
})
