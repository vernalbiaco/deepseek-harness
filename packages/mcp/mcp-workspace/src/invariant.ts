/**
 * Package-owned invariant for `@deepseek-ai/dsh-mcp-workspace`: every pool
 * attachment belongs to a live agent in the attachment's workspace, and every
 * tool name the pool reports as registered resolves for that agent.
 * @module @deepseek-ai/dsh-mcp-workspace/invariant
 */

import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { activePools } from './active-pools.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-workspace'
/** Cordis companion plugin name. */
export const name = 'mcp-workspace-invariant'
/** Services required before package ownership can be reserved. */
export const inject = ['invariants']

/**
 * Check every attachment of the app's pool against the agent registry and tool registry.
 * @param ctx - context carrying `agents` and `tools`.
 * @param fail - the bound failure reporter.
 */
function checkAttachments(ctx: Context, fail: InvariantFailure): void {
  const pool = activePools().get(ctx.root)
  if (pool === undefined) return
  for (const row of pool.attachments()) {
    const label = `mcp-workspace(${row.serverName})`
    const agent = row.agentCtx.agent
    if (agent === undefined || ctx.agents.get(agent.id) !== agent) {
      fail(`${label}: attachment in ${row.workspacePath} belongs to no live agent`)
      continue
    }
    const cwd = agent.session.header.cwd
    let canonical: string | undefined
    try {
      canonical = cwd === undefined ? undefined : realpathSync.native(cwd)
    } catch {
      // A cwd removed after attachment has no canonical path; the relation is not checkable, not violated.
      canonical = row.workspacePath
    }
    if (canonical !== row.workspacePath) {
      fail(`${label}: agent ${agent.id} with cwd ${cwd} is attached to workspace ${row.workspacePath}`)
    }
    for (const toolName of row.toolNames) {
      if (ctx.tools.get(toolName, agent) === undefined) {
        fail(`${label}: tool ${toolName} registered for agent ${agent.id} does not resolve`)
      }
    }
  }
}

/* jscpd:ignore-start -- package companions share dispatch plumbing */
/** Check pool attachments at every `request/header` session event, before it is appended. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [unknown, SessionEvent]
    if (event.type !== 'request/header') return
    checkAttachments(ctx, fail)
  }, { global: true })
}, { inject: ['agents', 'tools'] })
/* jscpd:ignore-end */

/**
 * Register the package invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
