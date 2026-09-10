/**
 * discord.js adapter: feeds thread messages and component interactions into
 * the {@link Bridge} and implements {@link Poster} over Discord channels.
 * @module @deepseek-ai/dsh-discord-bot/discord
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Interaction,
  type Message,
  type MessageActionRowComponentBuilder,
  type SendableChannels,
} from 'discord.js'
import type { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { ApprovalPrompt, Bridge, Logger, Poster, QuestionPrompt } from './bridge.ts'
import { splitMessage } from './text.ts'

/** Discord's ceiling on options in one select menu. */
const SELECT_OPTION_LIMIT = 25
/** Discord's ceiling on component rows per message. */
const ROW_LIMIT = 5
/** Discord's ceiling on a thread name. */
const THREAD_NAME_LIMIT = 100

/** Custom-id prefixes; ids stay under Discord's 100-character limit because an RpcId is a UUID. */
const APPROVAL_ID = /^apr:([^:]+):(allow|reject)$/
const QUESTION_ID = /^q:([^:]+):(\d+)$/

/** Poster over Discord channels. Approval and question prompts remember their message for later edits. */
export class DiscordPoster implements Poster {
  private readonly prompts = new Map<RpcId, Message>()

  /** @param client - a logged-in or logging-in discord.js client. */
  constructor(private readonly client: Client) {}

  private async channel(threadId: string): Promise<SendableChannels> {
    const channel = await this.client.channels.fetch(threadId)
    if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
      throw new Error(`channel ${threadId} is not a sendable text channel`)
    }
    return channel
  }

  async postText(threadId: string, text: string): Promise<void> {
    const channel = await this.channel(threadId)
    for (const chunk of splitMessage(text)) await channel.send({ content: chunk })
  }

  async postLine(threadId: string, line: string): Promise<void> {
    const channel = await this.channel(threadId)
    const [chunk] = splitMessage(line)
    if (chunk !== undefined) await channel.send({ content: chunk })
  }

  async postApproval(threadId: string, prompt: ApprovalPrompt): Promise<void> {
    const channel = await this.channel(threadId)
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`apr:${prompt.rpcId}:allow`).setLabel('Allow once').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`apr:${prompt.rpcId}:reject`).setLabel('Reject').setStyle(ButtonStyle.Danger),
    )
    const reason = prompt.reason === undefined ? '' : `\n${prompt.reason}`
    const message = await channel.send({ content: `🔐 **${prompt.toolName}** needs approval.${reason}`, components: [row] })
    this.prompts.set(prompt.rpcId, message)
  }

  resolveApproval(_threadId: string, rpcId: RpcId, outcome: ApprovalOutcome): Promise<void> {
    return this.settle(rpcId, outcome)
  }

  async postQuestion(threadId: string, prompt: QuestionPrompt): Promise<void> {
    const channel = await this.channel(threadId)
    const lines: string[] = ['❓ The agent has a question.']
    const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = []
    prompt.questions.forEach((question, index) => {
      const header = question.header === undefined ? '' : `**${question.header}** `
      lines.push(`${index + 1}. ${header}${question.question}`)
      if (question.detail !== undefined) lines.push(question.detail)
      const options = question.options ?? []
      if (options.length === 0) {
        lines.push('_Reply in this thread to answer._')
        return
      }
      if (rows.length >= ROW_LIMIT) {
        lines.push('_Too many questions for one message; this one cannot be answered here._')
        return
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`q:${prompt.rpcId}:${index}`)
        .setPlaceholder(question.header ?? `Question ${index + 1}`)
        .setMinValues(1)
        .setMaxValues(question.multiSelect === true ? Math.min(options.length, SELECT_OPTION_LIMIT) : 1)
        .addOptions(options.slice(0, SELECT_OPTION_LIMIT).map((option) => {
          const built = new StringSelectMenuOptionBuilder().setLabel(option.label.slice(0, 100)).setValue(option.label.slice(0, 100))
          if (option.description !== undefined && option.description !== '') built.setDescription(option.description.slice(0, 100))
          return built
        }))
      rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu))
    })
    const [content] = splitMessage(lines.join('\n'))
    const message = await channel.send({ content: content ?? '❓', components: rows })
    this.prompts.set(prompt.rpcId, message)
  }

  resolveQuestion(_threadId: string, rpcId: RpcId, outcome: 'answered' | 'cancelled'): Promise<void> {
    return this.settle(rpcId, outcome)
  }

  /** Strip a prompt's components and append its outcome; a prompt this process never posted is left alone. */
  private async settle(rpcId: RpcId, outcome: string): Promise<void> {
    const message = this.prompts.get(rpcId)
    if (message === undefined) return
    this.prompts.delete(rpcId)
    await message.edit({ content: `${message.content}\n→ ${outcome}`, components: [] })
  }
}

/**
 * Create the discord.js client with the intents the bridge needs.
 * @returns a client that is not yet logged in.
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  })
}

function stripMention(content: string, botUserId: string): string {
  return content.replace(new RegExp(`<@!?${botUserId}>`, 'g'), ' ').trim()
}

function threadName(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? ''
  const name = firstLine === '' ? 'dsh session' : firstLine
  return name.length > THREAD_NAME_LIMIT ? `${name.slice(0, THREAD_NAME_LIMIT - 1)}…` : name
}

/**
 * Wire Discord gateway events to the bridge. A mention in a guild channel
 * opens a thread and a session; a message in a bridge-owned thread or in a
 * DM continues that thread's session; buttons and select menus answer
 * approvals and questions.
 * @param client - the discord.js client.
 * @param bridge - the bridge to drive.
 * @param log - diagnostics sink.
 */
export function attachBridge(client: Client, bridge: Bridge, log: Logger): void {
  client.on('messageCreate', (message) => {
    void handleMessage(message).catch((error: unknown) => {
      log.error(`message handling failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  client.on('interactionCreate', (interaction) => {
    void handleInteraction(interaction).catch((error: unknown) => {
      log.error(`interaction handling failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  async function handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return
    const botUserId = client.user?.id
    if (botUserId === undefined) return
    const userId = message.author.id
    const { channel } = message

    if (channel.type === ChannelType.DM) {
      if (!bridge.isAllowed(userId)) {
        log.warn(`ignoring DM from user ${userId}: not allowlisted`)
        return
      }
      await bridge.onUserMessage(channel.id, userId, message.content)
      return
    }

    const mentioned = message.mentions.users.has(botUserId)
    if (channel.isThread()) {
      if (!bridge.knowsThread(channel.id) && !mentioned) return
      await bridge.onUserMessage(channel.id, userId, stripMention(message.content, botUserId))
      return
    }

    if (!mentioned) return
    if (!bridge.isAllowed(userId)) {
      log.warn(`ignoring mention from user ${userId} in channel ${channel.id}: not allowlisted`)
      return
    }
    const text = stripMention(message.content, botUserId)
    if (!('threads' in channel) || typeof message.startThread !== 'function') {
      log.warn(`channel ${channel.id} cannot host threads`)
      return
    }
    const thread = await message.startThread({ name: threadName(text) })
    await bridge.onUserMessage(thread.id, userId, text)
  }

  async function handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      const match = APPROVAL_ID.exec(interaction.customId)
      if (match === null) return
      if (!bridge.isAllowed(interaction.user.id)) {
        await interaction.reply({ content: 'You are not on this bot\'s allowlist.', flags: MessageFlags.Ephemeral })
        return
      }
      await interaction.deferUpdate()
      const outcome = await bridge.onApprovalDecision(interaction.user.id, match[1] as RpcId, match[2] === 'allow' ? 'allowed-once' : 'rejected')
      if (outcome === 'stale') await interaction.followUp({ content: 'That approval is no longer pending.', flags: MessageFlags.Ephemeral })
      return
    }
    if (interaction.isStringSelectMenu()) {
      const match = QUESTION_ID.exec(interaction.customId)
      if (match === null) return
      if (!bridge.isAllowed(interaction.user.id)) {
        await interaction.reply({ content: 'You are not on this bot\'s allowlist.', flags: MessageFlags.Ephemeral })
        return
      }
      await interaction.deferUpdate()
      const outcome = await bridge.onQuestionSelection(interaction.user.id, match[1] as RpcId, Number(match[2]), interaction.values)
      if (outcome === 'stale') await interaction.followUp({ content: 'That question is no longer pending.', flags: MessageFlags.Ephemeral })
    }
  }
}
