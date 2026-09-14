// Web e2e scenario: the workspace MCP approval question. The shipped base
// bundle mounts mcp-workspace, so connecting a workspace whose `.mcp.json`
// declares an undecided server raises the real decision question on the
// userQuestions seam as soon as the workspace's blank session is created. The
// test answers it through the composer, the decision lands in the isolated
// harness home's trust file, the server connects once its credential
// resolves, and a replayed turn calls the attached tool. Keyless: the model
// script is an authored override, because a recording would need the echo
// fixture connected before the first request.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type import: carries the tools Context merge for the attach gate.
import type {} from '@deepseek-ai/dsh-tools'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, pickFreshWorkspace, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/workspace-mcp-approval', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

// The ACP workspace-mcp scenarios' stdio echo server; it resolves the MCP SDK
// from its own location, so the pool's workspace cwd does not affect it.
const MCP_ECHO_SERVER = fileURLToPath(new URL('../../../examples/acp-agent/tests/fixtures/mcp-echo-server.mjs', import.meta.url))
const TOKEN_REF = 'MCP_FIXTURE_TOKEN'
const PROMPT = 'Call mcp__fixture__echo with the text hello, then reply with the result.'
const REPLY = 'The echo tool returned: hello'
const CALL_ID = CallId('call_workspace_echo')

const REPLAY: ReplayOverrideDoc = [
  {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: CALL_ID, name: 'mcp__fixture__echo', argumentsDelta: '{"text":"hello"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CALL_ID, name: 'mcp__fixture__echo', arguments: '{"text":"hello"}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  },
  {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: REPLY },
      { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  },
]

/**
 * Declare the echo fixture as workspace MCP server `fixture`, with a credential
 * placeholder so the question reports the reference's status.
 * @param workspace - the directory the browser connects as the workspace.
 */
async function writeWorkspaceMcpJson(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true })
  const entry = { command: process.execPath, args: [MCP_ECHO_SERVER], env: { [TOKEN_REF]: `\${${TOKEN_REF}}` } }
  await writeFile(join(workspace, '.mcp.json'), `${JSON.stringify({ mcpServers: { fixture: entry } }, null, 2)}\n`)
}

describe.skipIf(MODE === 'record')('web e2e: workspace MCP approval question', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let replayDir: string
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-workspace-mcp-approval-replay-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(REPLAY))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'),
      replayOverride,
      paceMs: 10,
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    await writeWorkspaceMcpJson(join(scaffold.workspaceCwd, 'workspace'))
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The question takes over the composer as soon as the workspace connects.
    await pickFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'workspace-mcp-approval e2e cleanup failed')
  })

  it('asks about the declared server, records Allow for this workspace, and calls its tool', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-mcp-approval'))
    // Creating the workspace's blank session created its agent, which raised
    // the question: a stable waiting state until answered.
    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: 30_000 })
    await expect.poll(() => composer.getByText(`credentials: ${TOKEN_REF} missing`).count(), { timeout: 10_000 })
      .toBeGreaterThan(0)

    // The detail line names the server's command and args: absolute host
    // paths the shared normalizer does not know.
    const snapshot = (await captureStableAria(page, '[data-question-key]', scaffold.workspaceCwd))
      .split(process.execPath).join('{{node}}')
      .split(dirname(MCP_ECHO_SERVER)).join('{{fixtures}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    // The question reported the reference unset; admission resolves it again
    // after the answer, so setting it now lets the server connect.
    await scaffold.ctx.credentials.set(credentialRef(TOKEN_REF), 'fixture-token')
    await composer.getByRole('radio', { name: 'Allow for this workspace' }).click()
    await composer.getByRole('button', { name: 'Submit' }).click()

    const trustFile = join(scaffold.harnessHome, 'mcp-trust.yaml')
    await expect.poll(() => readFile(trustFile, 'utf8').catch(() => ''), { timeout: 15_000 })
      .toContain('decision: allow')
    expect((await stat(trustFile)).mode & 0o777).toBe(0o600)
    expect(await readFile(trustFile, 'utf8')).toContain(join(scaffold.workspaceCwd, 'workspace'))
    await expect.poll(() => page.locator('[data-question-key]').count(), { timeout: 10_000 }).toBe(0)

    // Tools attach once the connection publishes them; the scripted first step
    // calls the tool, so the prompt waits for the agent's registration.
    const [agent] = scaffold.ctx.agents.roots()
    expect(agent).toBeDefined()
    await expect.poll(() => scaffold.ctx.tools.get('mcp__fixture__echo', agent) !== undefined, { timeout: 30_000 })
      .toBe(true)

    const input = page.locator('textarea:enabled').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    await settled

    const results = sessionEvents.filter(event => event.type === 'tool/result')
    expect(results.map(event => event.data.message.content)).toEqual([[{
      type: 'tool-result',
      toolCallId: 'call_workspace_echo',
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    }]])
    await page.locator('[data-tool="mcp__fixture__echo"]').waitFor({ timeout: 15_000 })
    await expect.poll(() => page.getByText(REPLY, { exact: true }).count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
