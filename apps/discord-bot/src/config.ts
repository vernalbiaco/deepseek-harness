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
  /** Directory registered as the Web UI workspace when no workspace carries the title. */
  workspaceDir: string
  /** Title of that workspace in the Web UI. */
  workspaceTitle: string
}

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3081'
const DEFAULT_TOKEN_FILE = '/etc/dsh/secrets/discord-token'
const DEFAULT_WORKSPACE_DIR = '/workspaces/Discord'
const DEFAULT_WORKSPACE_TITLE = 'Discord'
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
 * `DSH_DISCORD_WORKSPACE_DIR` (default `/workspaces/Discord`, must be absolute),
 * `DSH_DISCORD_WORKSPACE_TITLE` (default `Discord`).
 * @param env - the process environment.
 * @returns the validated configuration.
 * @throws when the token file is unreadable or empty, the allowlist is empty or malformed, or the workspace directory is relative.
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
  const workspaceDir = trimmed(env.DSH_DISCORD_WORKSPACE_DIR) ?? DEFAULT_WORKSPACE_DIR
  if (!workspaceDir.startsWith('/')) throw new Error(`discord-bot: DSH_DISCORD_WORKSPACE_DIR must be an absolute path, got ${JSON.stringify(workspaceDir)}`)
  const workspaceTitle = trimmed(env.DSH_DISCORD_WORKSPACE_TITLE) ?? DEFAULT_WORKSPACE_TITLE
  return { apiBaseUrl, discordToken, allowedUserIds: new Set(allowed), stateFile, workspaceDir, workspaceTitle }
}
