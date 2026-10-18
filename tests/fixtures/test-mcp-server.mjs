#!/usr/bin/env node
/**
 * Small local MCP server for SF Agents tests.
 *
 *   node test-mcp-server.mjs            stdio transport
 *   node test-mcp-server.mjs --http 0   Streamable HTTP on a port ("0" = any);
 *                                       prints "LISTENING <port>" when ready
 *
 * Tools: echo, add, fail (isError result), throw (protocol error), slow,
 * env_probe (reports which variables the server process can see),
 * structured (structuredContent), counter (side effect counter).
 */

import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

let counter = 0;

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the given text back, prefixed with "echo:".',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  { name: 'fail', description: 'Always returns an error result.', inputSchema: { type: 'object', properties: {} } },
  { name: 'throw', description: 'Always fails with a protocol error.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'slow',
    description: 'Waits for ms milliseconds.',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
  },
  {
    name: 'env_probe',
    description: 'Reports whether named environment variables are visible to the server.',
    inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] },
  },
  { name: 'structured', description: 'Returns structuredContent.', inputSchema: { type: 'object', properties: {} } },
  { name: 'counter', description: 'Increments and returns a counter.', inputSchema: { type: 'object', properties: {} } },
];

function createServer() {
  const server = new Server({ name: 'sfagents-test-server', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    switch (request.params.name) {
      case 'echo':
        return { content: [{ type: 'text', text: `echo:${args.text}` }] };
      case 'add':
        return { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] };
      case 'fail':
        return { isError: true, content: [{ type: 'text', text: 'deliberate failure' }] };
      case 'throw':
        throw new Error('deliberate protocol error');
      case 'slow':
        await new Promise((r) => setTimeout(r, Number(args.ms)));
        return { content: [{ type: 'text', text: `slept ${args.ms}` }] };
      case 'env_probe':
        return {
          content: [
            { type: 'text', text: JSON.stringify(Object.fromEntries(args.names.map((n) => [n, process.env[n] !== undefined]))) },
          ],
        };
      case 'structured':
        return { structuredContent: { answer: 42 }, content: [{ type: 'text', text: 'see structured content' }] };
      case 'counter':
        counter++;
        return { content: [{ type: 'text', text: `counter=${counter}` }] };
      default:
        throw new Error(`unknown tool ${request.params.name}`);
    }
  });
  return server;
}

const httpIndex = process.argv.indexOf('--http');
if (httpIndex >= 0) {
  const port = Number(process.argv[httpIndex + 1] ?? 0);
  const httpServer = http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    if (process.env.TEST_MCP_TOKEN && req.headers.authorization !== `Bearer ${process.env.TEST_MCP_TOKEN}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    // Stateless mode: a fresh server and transport per request.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    });
  });
  httpServer.listen(port, '127.0.0.1', () => {
    process.stdout.write(`LISTENING ${httpServer.address().port}\n`);
  });
} else {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
