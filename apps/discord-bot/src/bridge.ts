/**
 * Discord-agnostic core of the bot: maps chat threads to harness sessions,
 * turns thread messages into prompts, projects the api service's event stream
 * back into thread posts, and answers tool approvals and questions on behalf
 * of allowlisted users. The chat platform is behind {@link Poster}; the api
 * service is behind {@link BridgeApi}.
 * @module @deepseek-ai/dsh-discord-bot/bridge
 */

import type {
  ApprovalResponsePayload,
  ClientResponse,
  IApiClient,
  MuxFrame,
  QuestionResponsePayload,
  RpcId,
  RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { ThreadStore } from './state.ts'
import { assistantText, toolCallLine, toolErrorLine, turnEndLine } from './text.ts'

/** The slice of the api client the bridge drives. */
export interface BridgeApi {
  sessions: Pick<IApiClient['sessions'], 'create' | 'prompt' | 'cancel'>
  events: Pick<IApiClient['events'], 'mux'>
  respond: IApiClient['respond']
}

/** One tool approval waiting for a human, addressed by its server-request id. */
export interface ApprovalPrompt {
  rpcId: RpcId
  toolName: string
  reason?: string
}

/** One `ask_user_question` call waiting for a human, addressed by its server-request id. */
export interface QuestionPrompt {
  rpcId: RpcId
  questions: AskUserQuestionItem[]
}

/** Outbound side of the chat platform. Every method may reject; the bridge logs and continues. */
export interface Poster {
  /** Post assistant prose; the implementation splits it to the platform's message limit. */
  postText(threadId: string, text: string): Promise<void>
  /** Post one status line (tool call, tool failure, turn outcome). */
  postLine(threadId: string, line: string): Promise<void>
  /** Post an approval prompt with allow and reject affordances. */
  postApproval(threadId: string, prompt: ApprovalPrompt): Promise<void>
  /** Mark a posted approval prompt as decided. */
  resolveApproval(threadId: string, rpcId: RpcId, outcome: ApprovalOutcome): Promise<void>
  /** Post a question prompt; questions without options are answered by the next thread message. */
  postQuestion(threadId: string, prompt: QuestionPrompt): Promise<void>
  /** Mark a posted question prompt as settled. */
  resolveQuestion(threadId: string, rpcId: RpcId, outcome: 'answered' | 'cancelled'): Promise<void>
}

/** Minimal logger the bridge writes to. */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Construction options. */
export interface BridgeOptions {
  api: BridgeApi
  poster: Poster
  store: ThreadStore
  allowedUserIds: ReadonlySet<string>
  /** Working directory for new sessions; absent uses the api service's cwd. */
  sessionCwd?: string
  log: Logger
  /** Backoff for reopening the event stream; defaults to 500 ms doubling to 30 s. */
  reconnect?: { initialDelayMs: number; maxDelayMs: number }
}

/** What the bridge did with one thread message. */
export type MessageOutcome = 'ignored' | 'prompted' | 'cancelled' | 'answered' | 'failed'
/** What the bridge did with one approval or question interaction. */
export type ClickOutcome = 'ignored' | 'accepted' | 'stale'

/** Text a user types in a thread to abort the running turn. */
const CANCEL_COMMAND = '!cancel'

interface PendingApproval {
  sessionId: SessionId
  approvalId: ApprovalRequestId
  threadId: string
}

interface PendingQuestion {
  sessionId: SessionId
  threadId: string
  questions: AskUserQuestionItem[]
  answers: Map<number, AskUserQuestionAnswerItem>
}

/** The first unanswered question without options in a thread, which the next thread message answers. */
interface FreeTextQuestion {
  rpcId: RpcId
  pending: PendingQuestion
  index: number
  question: AskUserQuestionItem
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read the live abort state through a call so control-flow narrowing does not freeze it. */
function stopped(signal: AbortSignal): boolean {
  return signal.aborted
}

/** The thread-to-session bridge. One instance serves one api service. */
export class Bridge {
  private readonly api: BridgeApi
  private readonly poster: Poster
  private readonly store: ThreadStore
  private readonly allowedUserIds: ReadonlySet<string>
  private readonly sessionCwd: string | undefined
  private readonly log: Logger
  private readonly reconnect: { initialDelayMs: number; maxDelayMs: number }
  private readonly threadsBySession = new Map<string, string>()
  private readonly pendingApprovals = new Map<RpcId, PendingApproval>()
  private readonly approvalRpcIds = new Map<ApprovalRequestId, RpcId>()
  private readonly pendingQuestions = new Map<RpcId, PendingQuestion>()
  private readonly toolNamesByCall = new Map<CallId, string>()

  /** @param options - collaborators and policy. */
  constructor(options: BridgeOptions) {
    this.api = options.api
    this.poster = options.poster
    this.store = options.store
    this.allowedUserIds = options.allowedUserIds
    this.sessionCwd = options.sessionCwd
    this.log = options.log
    this.reconnect = options.reconnect ?? { initialDelayMs: 500, maxDelayMs: 30_000 }
    for (const [threadId, sessionId] of this.store.entries()) this.threadsBySession.set(sessionId, threadId)
  }

  /**
   * Whether `userId` may drive the agent.
   * @param userId - Discord user id.
   * @returns true for allowlisted users.
   */
  isAllowed(userId: string): boolean {
    return this.allowedUserIds.has(userId)
  }

  /**
   * Whether the bridge owns `threadId`.
   * @param threadId - Discord thread or DM channel id.
   * @returns true when a session is bound to the thread.
   */
  knowsThread(threadId: string): boolean {
    return this.store.get(threadId) !== undefined
  }

  /**
   * Handle one message posted in a thread. Creates the thread's session on
   * first use, answers a pending free-text question, honors
   * {@link CANCEL_COMMAND}, and otherwise queues the text as a prompt.
   * @param threadId - Discord thread or DM channel id.
   * @param userId - author's Discord user id.
   * @param text - message text with any bot mention already stripped.
   * @returns what happened.
   */
  async onUserMessage(threadId: string, userId: string, text: string): Promise<MessageOutcome> {
    if (!this.isAllowed(userId)) {
      this.log.warn(`ignoring message from user ${userId} in thread ${threadId}: not allowlisted`)
      return 'ignored'
    }
    const trimmed = text.trim()
    if (trimmed === '') return 'ignored'

    const freeText = this.freeTextQuestionFor(threadId)
    if (freeText !== undefined) {
      const { rpcId, pending, index, question } = freeText
      pending.answers.set(index, { id: question.id, selected: [], custom: trimmed })
      await this.settleQuestion(rpcId, pending)
      return 'answered'
    }

    if (trimmed === CANCEL_COMMAND) {
      const sessionId = this.store.get(threadId)
      if (sessionId === undefined) {
        await this.post(threadId, () => this.poster.postLine(threadId, 'Nothing to cancel here yet.'))
        return 'ignored'
      }
      const response = await this.api.sessions.cancel({ sessionId: sessionId as SessionId })
      if (!response.result.ok) {
        const { message } = response.result.error
        await this.post(threadId, () => this.poster.postLine(threadId, `⚠️ Cancel failed: ${message}`))
        return 'failed'
      }
      return 'cancelled'
    }

    let sessionId: SessionId
    try {
      sessionId = await this.sessionFor(threadId)
    } catch (error) {
      await this.post(threadId, () => this.poster.postLine(threadId, `⚠️ Could not start a session: ${errorText(error)}`))
      return 'failed'
    }
    const response = await this.api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: trimmed }],
    })
    if (!response.result.ok) {
      const { code, message } = response.result.error
      await this.post(threadId, () => this.poster.postLine(threadId, `⚠️ The harness refused the prompt (${code}): ${message}`))
      return 'failed'
    }
    return 'prompted'
  }

  /**
   * Answer a pending approval on behalf of `userId`.
   * @param userId - Discord user id of the person who clicked.
   * @param rpcId - the approval prompt's server-request id.
   * @param outcome - the decision.
   * @returns `accepted` when the host took the answer, `stale` when nothing was pending, `ignored` for a non-allowlisted user.
   */
  async onApprovalDecision(userId: string, rpcId: RpcId, outcome: 'allowed-once' | 'rejected'): Promise<ClickOutcome> {
    if (!this.isAllowed(userId)) {
      this.log.warn(`ignoring approval click from user ${userId}: not allowlisted`)
      return 'ignored'
    }
    const pending = this.pendingApprovals.get(rpcId)
    if (pending === undefined) return 'stale'
    const value: ApprovalResponsePayload = { sessionId: pending.sessionId, approvalId: pending.approvalId, outcome }
    const message: ClientResponse = { type: 'client-response', rpcId, result: { ok: true, value } }
    const receipt = await this.api.respond(message)
    if (!receipt.accepted) {
      this.log.warn(`host refused approval answer ${rpcId}: ${receipt.reason}`)
      this.forgetApproval(rpcId)
      return 'stale'
    }
    this.log.info(`approval ${pending.approvalId} ${outcome} by user ${userId}`)
    return 'accepted'
  }

  /**
   * Record the selected options for one question of a pending prompt; the
   * answer is sent once every question has one.
   * @param userId - Discord user id of the person who chose.
   * @param rpcId - the question prompt's server-request id.
   * @param questionIndex - index into the prompt's questions.
   * @param selected - chosen option labels.
   * @returns `accepted` when the choice was recorded or sent, `stale` when nothing was pending, `ignored` for a non-allowlisted user.
   */
  async onQuestionSelection(userId: string, rpcId: RpcId, questionIndex: number, selected: string[]): Promise<ClickOutcome> {
    if (!this.isAllowed(userId)) {
      this.log.warn(`ignoring question answer from user ${userId}: not allowlisted`)
      return 'ignored'
    }
    const pending = this.pendingQuestions.get(rpcId)
    const question = pending?.questions[questionIndex]
    if (pending === undefined || question === undefined) return 'stale'
    pending.answers.set(questionIndex, { id: question.id, selected })
    return this.settleQuestion(rpcId, pending)
  }

  /**
   * Consume the api service's event stream until `signal` aborts, reopening
   * it with exponential backoff after every close or failure. Pending
   * approvals and questions replay on each open and are deduplicated by
   * server-request id.
   * @param signal - stops the loop.
   */
  async run(signal: AbortSignal): Promise<void> {
    let delay = this.reconnect.initialDelayMs
    while (!stopped(signal)) {
      try {
        const frames = this.api.events.mux({}, signal, () => {
          delay = this.reconnect.initialDelayMs
          this.log.info('event stream open')
        })
        for await (const frame of frames) await this.handleFrame(frame)
        if (!stopped(signal)) this.log.warn('event stream closed')
      } catch (error) {
        if (stopped(signal)) break
        this.log.error(`event stream failed: ${errorText(error)}`)
      }
      if (stopped(signal)) break
      await sleep(delay, signal)
      delay = Math.min(delay * 2, this.reconnect.maxDelayMs)
    }
  }

  /**
   * Project one stream frame into the owning thread. Frames for sessions the
   * bridge did not create are ignored.
   * @param frame - a mux frame with its server-request id.
   */
  async handleFrame(frame: RpcRequest<MuxFrame>): Promise<void> {
    const { payload } = frame
    if (payload.type === 'stream/error') {
      this.log.error(`event stream error: ${payload.error.message}`)
      return
    }
    if (!('sessionId' in payload)) return
    const threadId = this.threadsBySession.get(payload.sessionId)
    if (threadId === undefined) return
    switch (payload.type) {
      case 'session/event': {
        const { event } = payload
        switch (event.type) {
          case 'tool/call': {
            const { callId, name, arguments: args } = event.data
            this.toolNamesByCall.set(callId, name)
            await this.post(threadId, () => this.poster.postLine(threadId, toolCallLine(name, args, payload.view)))
            return
          }
          case 'tool/result': {
            const [block] = event.data.message.content
            const name = this.toolNamesByCall.get(block.toolCallId) ?? 'tool'
            this.toolNamesByCall.delete(block.toolCallId)
            const { error } = event.data
            if (error === undefined) return
            await this.post(threadId, () => this.poster.postLine(threadId, toolErrorLine(name, error.code, block.content)))
            return
          }
          case 'assistant/message': {
            const text = assistantText(event.data.message.content)
            if (text === '') return
            await this.post(threadId, () => this.poster.postText(threadId, text))
            return
          }
          case 'turn/end': {
            const line = turnEndLine(event.data.reason)
            if (line === undefined) return
            await this.post(threadId, () => this.poster.postLine(threadId, line))
            return
          }
          default:
            return
        }
      }
      case 'approval/requested': {
        if (this.pendingApprovals.has(frame.rpcId)) return
        const { sessionId, approvalId, toolName, reason } = payload
        this.pendingApprovals.set(frame.rpcId, { sessionId, approvalId, threadId })
        this.approvalRpcIds.set(approvalId, frame.rpcId)
        const prompt: ApprovalPrompt = { rpcId: frame.rpcId, toolName, ...(reason === undefined ? {} : { reason }) }
        await this.post(threadId, () => this.poster.postApproval(threadId, prompt))
        return
      }
      case 'approval/resolved': {
        const rpcId = this.approvalRpcIds.get(payload.approvalId)
        if (rpcId === undefined) return
        this.forgetApproval(rpcId)
        await this.post(threadId, () => this.poster.resolveApproval(threadId, rpcId, payload.outcome))
        return
      }
      case 'question/requested': {
        if (this.pendingQuestions.has(frame.rpcId)) return
        const { sessionId, questions } = payload
        this.pendingQuestions.set(frame.rpcId, { sessionId, threadId, questions, answers: new Map() })
        await this.post(threadId, () => this.poster.postQuestion(threadId, { rpcId: frame.rpcId, questions }))
        return
      }
      case 'question/resolved': {
        if (!this.pendingQuestions.delete(payload.questionRpcId)) return
        await this.post(threadId, () => this.poster.resolveQuestion(threadId, payload.questionRpcId, payload.outcome))
        return
      }
      default:
        return
    }
  }

  private async sessionFor(threadId: string): Promise<SessionId> {
    const known = this.store.get(threadId)
    if (known !== undefined) return known as SessionId
    const response = await this.api.sessions.create(this.sessionCwd === undefined ? {} : { cwd: this.sessionCwd })
    if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`)
    const { sessionId } = response.result.value
    await this.store.set(threadId, sessionId)
    this.threadsBySession.set(sessionId, threadId)
    this.log.info(`thread ${threadId} bound to session ${sessionId}`)
    return sessionId
  }

  private freeTextQuestionFor(threadId: string): FreeTextQuestion | undefined {
    for (const [rpcId, pending] of this.pendingQuestions) {
      if (pending.threadId !== threadId) continue
      for (const [index, question] of pending.questions.entries()) {
        if (!pending.answers.has(index) && (question.options?.length ?? 0) === 0) return { rpcId, pending, index, question }
      }
    }
    return undefined
  }

  private async settleQuestion(rpcId: RpcId, pending: PendingQuestion): Promise<ClickOutcome> {
    const answers: AskUserQuestionAnswerItem[] = []
    for (let index = 0; index < pending.questions.length; index += 1) {
      const answer = pending.answers.get(index)
      if (answer === undefined) return 'accepted'
      answers.push(answer)
    }
    const value: QuestionResponsePayload = { sessionId: pending.sessionId, answer: { answers } }
    const message: ClientResponse = { type: 'client-response', rpcId, result: { ok: true, value } }
    const receipt = await this.api.respond(message)
    if (!receipt.accepted) {
      this.log.warn(`host refused question answer ${rpcId}: ${receipt.reason}`)
      this.pendingQuestions.delete(rpcId)
      return 'stale'
    }
    return 'accepted'
  }

  private forgetApproval(rpcId: RpcId): void {
    const pending = this.pendingApprovals.get(rpcId)
    if (pending === undefined) return
    this.pendingApprovals.delete(rpcId)
    this.approvalRpcIds.delete(pending.approvalId)
  }

  private async post(threadId: string, action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch (error) {
      this.log.error(`posting to thread ${threadId} failed: ${errorText(error)}`)
    }
  }
}
