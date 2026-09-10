/**
 * Startup configuration for the Discord bridge, read once from the process
 * environment and the mounted token file. Every field is validated here so a
 * misconfigured deployment fails before the bot logs in to Discord.
 * @module @deepseek-ai/dsh-discord-bot/config
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolved bridge configuration. */
export interface BotConfig {
  /** Base URL of the dsh api service; the bot must reach it through a loopback or trusted Host. */
  apiBaseUrl: string
  /** Discord bot token, read from the token file. */
  discordToken: string
  /** Discord user ids allowed to drive the agent and answer its prompts. */
  allowedUserIds: ReadonlySet<string>
  /** JSON file that maps Discord threads to harness sessions across restarts. */
  stateFile: string
  /** Working directory for every session the bot creates; absent means the api service's own cwd. */
  sessionCwd?: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3081'
const DEFAULT_TOKEN_FILE = '/etc/dsh/secrets/discord-token'
const SNOWFLAKE = /^\d{5,25}$/

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim()
  return text === undefined || text === '' ? undefined : text
}

/**
 * Read and validate the bridge configuration.
 *
 * Environment: `DSH_API_URL` (default `http://127.0.0.1:3081`),
 * `DISCORD_TOKEN_FILE` (default `/etc/dsh/secrets/discord-token`),
 * `DISCORD_ALLOWED_USER_IDS` (required, comma-separated snowflakes),
 * `DSH_DISCORD_STATE_FILE` (default `$DSH_HOME/discord-bot/threads.json`),
 * `DSH_SESSION_CWD` (optional absolute path).
 * @param env - the process environment.
 * @returns the validated configuration.
 * @throws when the token file is unreadable or empty, or the allowlist is empty or malformed.
 */
export function loadConfig(env: NodeJS.ProcessEnv): BotConfig {
  const apiBaseUrl = trimmed(env.DSH_API_URL) ?? DEFAULT_API_BASE_URL
  const tokenFile = trimmed(env.DISCORD_TOKEN_FILE) ?? DEFAULT_TOKEN_FILE
  let discordToken: string
  try {
    discordToken = readFileSync(tokenFile, 'utf8').trim()
  } catch (error) {
    throw new Error(`discord-bot: cannot read the Discord token at ${tokenFile}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (discordToken === '') throw new Error(`discord-bot: the Discord token file ${tokenFile} is empty`)

  const allowed = (env.DISCORD_ALLOWED_USER_IDS ?? '').split(',').map(id => id.trim()).filter(id => id !== '')
  if (allowed.length === 0) {
    throw new Error('discord-bot: DISCORD_ALLOWED_USER_IDS is empty; list the Discord user ids that may drive the agent')
  }
  for (const id of allowed) {
    if (!SNOWFLAKE.test(id)) throw new Error(`discord-bot: DISCORD_ALLOWED_USER_IDS entry ${JSON.stringify(id)} is not a Discord user id`)
  }

  const home = trimmed(env.DSH_HOME) ?? join(homedir(), '.dsh')
  const stateFile = trimmed(env.DSH_DISCORD_STATE_FILE) ?? join(home, 'discord-bot', 'threads.json')
  const sessionCwd = trimmed(env.DSH_SESSION_CWD)
  return {
    apiBaseUrl,
    discordToken,
    allowedUserIds: new Set(allowed),
    stateFile,
    ...(sessionCwd === undefined ? {} : { sessionCwd }),
  }
}
