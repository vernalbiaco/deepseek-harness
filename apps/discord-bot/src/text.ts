/**
 * Pure text projections of harness events into Discord-sized lines.
 * @module @deepseek-ai/dsh-discord-bot/text
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ToolEventView } from '@deepseek-ai/dsh-host-apiproxy'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'

/** Discord's hard limit for one message body. */
const DISCORD_MESSAGE_LIMIT = 2000

/**
 * Split `text` into chunks no longer than `limit`, preferring line boundaries.
 * @param text - the full message.
 * @param limit - maximum chunk length; defaults to Discord's message limit.
 * @returns non-empty chunks in order; an empty input yields no chunks.
 */
export function splitMessage(text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/**
 * Visible text of an assistant message: its text blocks joined by newlines.
 * @param content - the message blocks.
 * @returns the joined text, empty when the message carried no text.
 */
export function assistantText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && block.text.trim() !== '') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * One-line summary of a tool call for the thread transcript.
 * @param name - tool name.
 * @param args - raw JSON argument text.
 * @param view - the host's presentation view for the call, when the tool declares one.
 * @returns a line starting with the tool marker.
 */
export function toolCallLine(name: string, args: string, view: ToolEventView | undefined): string {
  const title = view?.for === 'call' ? view.view.title.trim() : ''
  const detail = title !== '' ? title : compactArguments(args)
  return `🔧 **${name}** ${detail}`.trimEnd()
}

function compactArguments(args: string): string {
  const oneLine = args.replace(/\s+/g, ' ').trim()
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine
}

/**
 * First line of a failed tool result, for a visible failure marker.
 * @param name - tool name.
 * @param code - the structured error code.
 * @param content - the tool result blocks.
 * @returns a line starting with the failure marker.
 */
export function toolErrorLine(name: string, code: string, content: readonly ContentBlock[]): string {
  const text = assistantText(content).split('\n')[0] ?? ''
  const detail = text.length > 300 ? `${text.slice(0, 297)}...` : text
  return `❌ **${name}** failed (${code})${detail === '' ? '' : `: ${detail}`}`
}

/**
 * Text posted when a turn ends for a reason other than completion.
 * @param reason - the turn's end reason.
 * @returns a line to post, or undefined when the turn completed normally.
 */
export function turnEndLine(reason: TurnEndReason): string | undefined {
  switch (reason.kind) {
    case 'completed':
      return undefined
    case 'aborted':
      return '⏹️ Cancelled.'
    case 'blocked':
      return '⛔ The turn was blocked.'
    case 'max-tokens':
      return '⚠️ The model hit its output-token ceiling; the answer may be truncated.'
    case 'interrupted':
      return '⚠️ The turn was interrupted by a restart.'
    case 'error':
      return `⚠️ Turn failed: ${reason.error.message}`
    default:
      return `⚠️ Turn ended: ${(reason as { kind: string }).kind}`
  }
}
