/**
 * Keyless end-to-end test of @deepseek-ai/dsh-mcp-workspace through the Loader
 * composition in `fixtures/composition.cordis.yml`: each root session in one
 * workspace mounts its own stdio server child, a `${NAME}` placeholder
 * resolves from `$DSH_HOME/.env` into that child's environment, and disposing
 * a session stops only that session's child.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import {
  bootComposition, createAgent, disposeCompositions, isAlive, pids, runTurn, sessionEvents, TOKEN_TOOL, toolResultTexts, until,
} from './composition-harness.ts'

afterEach(disposeCompositions)

describe('mcp-workspace per-session workspace servers', () => {
  it('starts one child per root session, resolves a $DSH_HOME/.env credential, and stops each child with its session', async () => {
    const { ctx, workspace, pidDir } = await bootComposition({
      // The fixture registers `token` only when MCP_FIXTURE_EXPECT_TOKEN is set, and a sensitive env name refuses a literal value.
      serverEnv: { MCP_FIXTURE_EXPECT_TOKEN: '${MCP_FIXTURE_TOKEN}', MCP_FIXTURE_TOKEN: '${MCP_FIXTURE_TOKEN}' },
      homeEnv: { MCP_FIXTURE_TOKEN: 'token-from-home-env' },
      script: [toolCallResponse('call-token', TOKEN_TOOL, {}), textResponse('done')],
    })

    const first = await createAgent(ctx, 'e2e-first', workspace)
    const second = await createAgent(ctx, 'e2e-second', workspace)
    expect(ctx.tools.get(TOKEN_TOOL, first.agent)).toBeDefined()
    expect(ctx.tools.get(TOKEN_TOOL, second.agent)).toBeDefined()
    const children = await pids(pidDir)
    expect(children).toHaveLength(2)

    await runTurn(ctx, first.agent)
    expect(toolResultTexts(await sessionEvents(ctx, first.agent))).toEqual(['token-from-home-env'])

    await first.dispose()
    await until(async () => (await pids(pidDir)).filter(isAlive).length === 1, 10_000)
    expect(ctx.tools.get(TOKEN_TOOL, second.agent)).toBeDefined()

    await second.dispose()
    await until(() => children.every(pid => !isAlive(pid)), 10_000)
  }, 60_000)
})
