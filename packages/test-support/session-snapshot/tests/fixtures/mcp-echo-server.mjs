/**
 * Stdio MCP server for the workspace-mcp snapshot scenarios: tool `echo`
 * returns its `text` argument. The low-level `Server` declares the input
 * schema as JSON Schema, so this fixture resolves only
 * `@modelcontextprotocol/sdk` from `examples/node_modules`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'echo-server', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{
    name: 'echo',
    description: 'Returns the given text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  }],
}))

server.setRequestHandler(CallToolRequestSchema, (request) => {
  if (request.params.name !== 'echo') throw new Error(`unknown tool: ${request.params.name}`)
  return { content: [{ type: 'text', text: String(request.params.arguments?.text) }] }
})

await server.connect(new StdioServerTransport())
