/**
 * Real Loader composition of @deepseek-ai/dsh-mcp-workspace booted from
 * `fixtures/composition.cordis.yml`. Activation in a workspace whose
 * `.mcp.json` server has a saved `allow` preconnects that server, so its tool
 * is in the first model request, and a scripted call's result reaches the
 * durable session log.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import {
  bootComposition, createAgent, disposeCompositions, durableEvents, ECHO, requestHeaders, runTurn, toolResultTexts,
} from './composition-harness.ts'

afterEach(disposeCompositions)

describe('mcp-workspace Loader composition', () => {
  it('lists a saved-allow workspace server tool in the first request and logs its call result', async () => {
    const { ctx, workspace } = await bootComposition({
      activationCwd: 'workspace',
      script: [toolCallResponse('call-echo', ECHO, { text: 'hello from the workspace' }), textResponse('done')],
    })

    const { agent } = await createAgent(ctx, 'composition-echo', workspace)
    await runTurn(ctx, agent)

    const events = await durableEvents(ctx, agent)
    expect(requestHeaders(events)[0]).toEqual({ reason: 'initial', tools: [ECHO] })
    expect(toolResultTexts(events)).toEqual(['hello from the workspace'])
  }, 30_000)
})
