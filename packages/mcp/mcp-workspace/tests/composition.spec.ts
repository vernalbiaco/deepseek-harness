/**
 * Real Loader composition of @deepseek-ai/dsh-mcp-workspace booted from
 * `fixtures/composition.cordis.yml`. A workspace `.mcp.json` server with a
 * saved `allow` is mounted on the agent before its first step, so its tool is
 * in the first model request, and a scripted call's result reaches the
 * session log.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import {
  bootComposition, createAgent, disposeCompositions, ECHO, requestHeaders, runTurn, sessionEvents, toolResultTexts,
} from './composition-harness.ts'

afterEach(disposeCompositions)

describe('mcp-workspace Loader composition', () => {
  it('lists a saved-allow workspace server tool in the first request and logs its call result', async () => {
    const { ctx, workspace } = await bootComposition({
      script: [toolCallResponse('call-echo', ECHO, { text: 'hello from the workspace' }), textResponse('done')],
    })

    const { agent } = await createAgent(ctx, 'composition-echo', workspace)
    await runTurn(ctx, agent)

    const events = await sessionEvents(ctx, agent)
    expect(requestHeaders(events)[0]).toEqual({ reason: 'initial', tools: [ECHO] })
    expect(toolResultTexts(events)).toEqual(['hello from the workspace'])
  }, 30_000)
})
