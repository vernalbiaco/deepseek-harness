import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-mcp-workspace'

export const name = 'workspace-mcp-settlement-marker'

/** Publish a workspace marker after an agent's workspace MCP admission pass settles. */
export function apply(ctx: Context): void {
  ctx.on('mcp-workspace/binding-settled', () => {
    writeFileSync(join(process.cwd(), '.dsh-snapshot-workspace-mcp-settled'), '')
  })
}
