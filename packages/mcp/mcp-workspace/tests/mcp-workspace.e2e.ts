/**
 * Keyless end-to-end test of @deepseek-ai/dsh-mcp-workspace through the Loader
 * composition in `fixtures/composition.cordis.yml`: two root sessions in one
 * workspace share one stdio server child, a `${NAME}` placeholder resolves from
 * `$DSH_HOME/.env` into that child's environment, and the child exits after
 * both sessions are disposed.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import {
  bootComposition, createAgent, disposeCompositions, durableEvents, isAlive, pids, runTurn, TOKEN_TOOL, toolResultTexts, until,
} from './composition-harness.ts'

afterEach(disposeCompositions)

describe('mcp-workspace shared workspace server', () => {
  it('shares one child between two root sessions, resolves a $DSH_HOME/.env credential, and stops the child after both are disposed', async () => {
    const { ctx, workspace, pidDir } = await bootComposition({
      // Activation runs outside the workspace, so no plugin-held preconnect reference keeps the child alive.
      activationCwd: 'outside',
      // The fixture registers `token` only when MCP_FIXTURE_EXPECT_TOKEN is set, and a sensitive env name refuses a literal value.
      serverEnv: { MCP_FIXTURE_EXPECT_TOKEN: '${MCP_FIXTURE_TOKEN}', MCP_FIXTURE_TOKEN: '${MCP_FIXTURE_TOKEN}' },
      homeEnv: { MCP_FIXTURE_TOKEN: 'token-from-home-env' },
      script: [toolCallResponse('call-token', TOKEN_TOOL, {}), textResponse('done')],
    })

    const first = await createAgent(ctx, 'e2e-first', workspace)
    const second = await createAgent(ctx, 'e2e-second', workspace)
    await until(() => [first, second].every(handle => ctx.tools.get(TOKEN_TOOL, handle.agent) !== undefined), 15_000)
    const children = await pids(pidDir)
    expect(children).toHaveLength(1)
    const [pid] = children as [number]

    await runTurn(ctx, first.agent)
    expect(toolResultTexts(await durableEvents(ctx, first.agent))).toEqual(['token-from-home-env'])

    await first.dispose()
    expect(isAlive(pid)).toBe(true)
    expect(ctx.tools.get(TOKEN_TOOL, second.agent)).toBeDefined()

    await second.dispose()
    await until(() => !isAlive(pid), 10_000)
    expect(await pids(pidDir)).toEqual([pid])
  }, 60_000)
})
