import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { assistantText, splitMessage, toolCallLine, toolErrorLine, turnEndLine } from '../src/text.ts'

describe('splitMessage', () => {
  it('keeps a short message whole and drops an empty one', () => {
    expect(splitMessage('hello')).toEqual(['hello'])
    expect(splitMessage('')).toEqual([])
  })

  it('splits on the last newline before the limit', () => {
    const chunks = splitMessage('aaaa\nbbbb\ncccc', 10)
    expect(chunks).toEqual(['aaaa\nbbbb', 'cccc'])
  })

  it('splits hard when a line exceeds the limit', () => {
    expect(splitMessage('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'xxxxx'])
  })
})

describe('assistantText', () => {
  it('joins text blocks and skips the rest', () => {
    const content = [
      { type: 'text', text: 'one' },
      { type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' },
      { type: 'text', text: '  ' },
      { type: 'text', text: 'two' },
    ] as unknown as ContentBlock[]
    expect(assistantText(content)).toBe('one\ntwo')
  })
})

describe('toolCallLine', () => {
  it('prefers the presentation title', () => {
    const line = toolCallLine('bash', '{"command":"pwd"}', { for: 'call', view: { card: 'terminal', title: 'pwd' } })
    expect(line).toBe('🔧 **bash** pwd')
  })

  it('falls back to compacted arguments', () => {
    expect(toolCallLine('read_file', '{\n  "path": "a.ts"\n}', undefined)).toBe('🔧 **read_file** { "path": "a.ts" }')
    expect(toolCallLine('x', 'y'.repeat(200), undefined)).toBe(`🔧 **x** ${'y'.repeat(157)}...`)
  })
})

describe('toolErrorLine', () => {
  it('quotes the first line of the result', () => {
    const content = [{ type: 'text', text: 'Error: sandbox unusable\nmore' }] as unknown as ContentBlock[]
    expect(toolErrorLine('bash', 'SANDBOX_UNAVAILABLE', content)).toBe('❌ **bash** failed (SANDBOX_UNAVAILABLE): Error: sandbox unusable')
    expect(toolErrorLine('bash', 'X', [])).toBe('❌ **bash** failed (X)')
  })
})

describe('turnEndLine', () => {
  it('is silent for completion and names every other reason', () => {
    expect(turnEndLine({ kind: 'completed' })).toBeUndefined()
    expect(turnEndLine({ kind: 'aborted', reason: 'user' } as unknown as TurnEndReason)).toBe('⏹️ Cancelled.')
    expect(turnEndLine({ kind: 'blocked' })).toContain('blocked')
    expect(turnEndLine({ kind: 'max-tokens' })).toContain('ceiling')
    expect(turnEndLine({ kind: 'interrupted' })).toContain('interrupted')
    expect(turnEndLine({ kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } as unknown as TurnEndReason)).toBe('⚠️ Turn failed: boom')
    expect(turnEndLine({ kind: 'plugin-defined' } as unknown as TurnEndReason)).toBe('⚠️ Turn ended: plugin-defined')
  })
})
