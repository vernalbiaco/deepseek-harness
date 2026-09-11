#!/usr/bin/env node
/**
 * dsh-discord-bot entry: validate configuration, confirm the api service
 * answers, log in to Discord, and pump the event stream until SIGINT or
 * SIGTERM.
 * @module @deepseek-ai/dsh-discord-bot/bin
 */

import { NodeApiClient } from './api-client.ts'
import { Bridge, type Logger } from './bridge.ts'
import { loadConfig } from './config.ts'
import { DiscordPoster, attachBridge, createDiscordClient } from './discord.ts'
import { openThreadStore } from './state.ts'

const log: Logger = {
  info: (message) => { console.error(`[discord-bot] ${message}`) },
  warn: (message) => { console.error(`[discord-bot] warn: ${message}`) },
  error: (message) => { console.error(`[discord-bot] error: ${message}`) },
}

const config = loadConfig(process.env)
const api = new NodeApiClient(config.apiBaseUrl)
const described = await api.host.describe({})
if (!described.result.ok) throw new Error(`discord-bot: api service at ${config.apiBaseUrl} refused host.describe: ${described.result.error.message}`)
log.info(`api service ${config.apiBaseUrl}: dsh ${described.result.value.version}, cwd ${described.result.value.cwd}`)

const store = await openThreadStore(config.stateFile)
const client = createDiscordClient()
const bridge = new Bridge({
  api,
  poster: new DiscordPoster(client),
  store,
  allowedUserIds: config.allowedUserIds,
  workspace: { path: config.workspaceDir, title: config.workspaceTitle },
  log,
})
await bridge.ensureWorkspace()
attachBridge(client, bridge, log)

const controller = new AbortController()
const stop = (signal: string): void => {
  log.info(`${signal} received; shutting down`)
  controller.abort()
  void client.destroy()
}
process.once('SIGINT', () => { stop('SIGINT') })
process.once('SIGTERM', () => { stop('SIGTERM') })

client.once('clientReady', () => { log.info(`logged in to Discord as ${client.user?.tag ?? 'unknown user'}`) })
await client.login(config.discordToken)
await bridge.run(controller.signal)
log.info('stopped')
