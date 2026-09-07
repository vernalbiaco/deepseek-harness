// Trusted non-loopback Web access under `--configuration-authority trusted-host`
// reaches the settings API: the welcome notice is acknowledged through the
// Host and stays acknowledged after reload — the inverse of remote-welcome.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, webSnapshotMode,
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_COPY, WELCOME_NOTICE_SETTINGS_NAMESPACE, WELCOME_NOTICE_VERSION,
  type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: remote settings under a trusted-host configuration fence', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      remoteAuthority: 'remote.localhost',
      configurationAuthority: 'trusted-host',
      welcomeNoticePending: true,
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('#root', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('acknowledges through the Host and stays acknowledged after reload', async () => {
    const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    await welcome.waitFor({ timeout: 15_000 })
    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })

    // The Host document, not browser memory, holds the acknowledgement.
    await expect.poll(() => {
      const section = scaffold.ctx.settings.describe()
        .find(row => row.ns === WELCOME_NOTICE_SETTINGS_NAMESPACE)?.user
      return (section as Record<string, unknown> | undefined)?.[WELCOME_NOTICE_ACK_FIELD]
    }, { timeout: 15_000 }).toBe(WELCOME_NOTICE_VERSION)

    const reloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, reloadWarnings)
    await page.waitForSelector('#root', { timeout: 30_000 })
    // The page must not flash the notice while the handshake is pending and
    // then withdraw it: the dialog never attaches, and the root is never inert.
    await expect(welcome.waitFor({ state: 'attached', timeout: 3_000 })).rejects.toThrow()
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(false)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
