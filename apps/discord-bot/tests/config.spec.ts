import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

let dir: string
let tokenFile: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-discord-config-'))
  tokenFile = join(dir, 'token')
  await writeFile(tokenFile, 'abc.def\n')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('loadConfig', () => {
  it('reads the token file and applies defaults', () => {
    const config = loadConfig({ DISCORD_TOKEN_FILE: tokenFile, DISCORD_ALLOWED_USER_IDS: ' 123456789 , 987654321 ', DSH_HOME: dir })
    expect(config).toEqual({
      apiBaseUrl: 'http://127.0.0.1:3081',
      discordToken: 'abc.def',
      allowedUserIds: new Set(['123456789', '987654321']),
      stateFile: join(dir, 'discord-bot', 'threads.json'),
    })
  })

  it('honors every override', () => {
    const config = loadConfig({
      DISCORD_TOKEN_FILE: tokenFile,
      DISCORD_ALLOWED_USER_IDS: '123456789',
      DSH_API_URL: 'http://api:8081',
      DSH_DISCORD_STATE_FILE: '/state/x.json',
      DSH_SESSION_CWD: '/workspaces/marketing',
    })
    expect(config.apiBaseUrl).toBe('http://api:8081')
    expect(config.stateFile).toBe('/state/x.json')
    expect(config.sessionCwd).toBe('/workspaces/marketing')
  })

  it('fails loudly on a missing or empty token and a bad allowlist', async () => {
    expect(() => loadConfig({ DISCORD_TOKEN_FILE: join(dir, 'absent'), DISCORD_ALLOWED_USER_IDS: '123456789' })).toThrow('cannot read the Discord token')
    await writeFile(tokenFile, '\n')
    expect(() => loadConfig({ DISCORD_TOKEN_FILE: tokenFile, DISCORD_ALLOWED_USER_IDS: '123456789' })).toThrow('is empty')
    await writeFile(tokenFile, 'tok')
    expect(() => loadConfig({ DISCORD_TOKEN_FILE: tokenFile })).toThrow('DISCORD_ALLOWED_USER_IDS is empty')
    expect(() => loadConfig({ DISCORD_TOKEN_FILE: tokenFile, DISCORD_ALLOWED_USER_IDS: 'alice' })).toThrow('not a Discord user id')
  })
})
