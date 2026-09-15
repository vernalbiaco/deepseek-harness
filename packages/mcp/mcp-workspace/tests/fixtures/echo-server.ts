/**
 * Stdio MCP server for the workspace connection pool tests.
 *
 * Tool `echo` returns its `text` argument. When `MCP_FIXTURE_PID_DIR` is set,
 * startup writes an empty file named after `process.pid` into that directory,
 * so a test counts the children one connection key started. When
 * `MCP_FIXTURE_EXPECT_TOKEN` is set, tool `token` returns `MCP_FIXTURE_TOKEN`.
 *
 * Run: node echo-server.ts
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const pidDir = process.env.MCP_FIXTURE_PID_DIR
if (pidDir !== undefined) writeFileSync(join(pidDir, String(process.pid)), '')

const server = new McpServer({ name: 'echo-server', version: '1.0.0' })

server.registerTool('echo', {
  description: 'Returns the given text.',
  inputSchema: { text: z.string() },
}, async args => ({
  content: [{ type: 'text', text: args.text }],
}))

if (process.env.MCP_FIXTURE_EXPECT_TOKEN !== undefined) {
  server.registerTool('token', {
    description: 'Returns the token the server received.',
    inputSchema: {},
  }, async () => ({
    content: [{ type: 'text', text: process.env.MCP_FIXTURE_TOKEN ?? '' }],
  }))
}

await server.connect(new StdioServerTransport())
