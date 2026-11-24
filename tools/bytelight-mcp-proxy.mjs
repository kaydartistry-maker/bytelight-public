#!/usr/bin/env node
// Copyright 2026 Byte-light contributors. Licensed under the Apache License 2.0.
// A secret-free stdio doorway from owned foreign CLIs to byte-light's scoped
// HTTP MCP belt. The bearer and turn binding arrive only through inherited env.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const token = process.env.BYTELIGHT_MCP_BELT_TOKEN?.trim();
if (!token) throw new Error('BYTELIGHT_MCP_BELT_TOKEN is required');
const port = process.env.RESONANT_PORT || '3002';
const url = new URL(process.env.BYTELIGHT_MCP_BELT_URL || `http://127.0.0.1:${port}/mcp/belt`);
const headers = {
  Authorization: `Bearer ${token}`,
  'X-Bytelight-Thread-Id': process.env.BYTELIGHT_MCP_THREAD_ID || '',
  'X-Bytelight-Is-Autonomous': process.env.BYTELIGHT_MCP_IS_AUTONOMOUS || '0',
  'X-Bytelight-Owner-Message': process.env.BYTELIGHT_MCP_OWNER_MESSAGE || '',
  'X-Bytelight-Audience': process.env.BYTELIGHT_MCP_AUDIENCE || '',
};

const remoteTransport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
const remote = new Client({ name: 'bytelight-foreign-lane', version: '1.0.0' });
await remote.connect(remoteTransport);

const server = new Server({ name: 'bytelight-proxy', version: '1.0.0' }, { capabilities: { tools: { listChanged: false } } });
server.setRequestHandler(ListToolsRequestSchema, async () => remote.listTools());
server.setRequestHandler(CallToolRequestSchema, async (request) => remote.callTool(request.params));

const stdio = new StdioServerTransport();
await server.connect(stdio);

const close = async () => {
  await Promise.allSettled([server.close(), remote.close()]);
  process.exit(0);
};
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
