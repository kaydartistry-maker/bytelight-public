// A tiny stdio MCP server for mcp-json-bridge.test.ts: one echo tool, one
// failing tool, and the env it was given, so the test can see what reached it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' });
server.tool('echo', 'Echo the value back', { value: z.string() }, async ({ value }) => ({
  content: [{ type: 'text', text: `echo:${value}:${process.env.FIXTURE_FLAG ?? 'unset'}` }],
}));
server.tool('broken', 'Always fails', {}, async () => ({ isError: true, content: [{ type: 'text', text: 'nope' }] }));
await server.connect(new StdioServerTransport());
