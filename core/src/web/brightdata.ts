/**
 * Web access for agents, through Bright Data's hosted MCP server: Google
 * search results (search_engine) and pages fetched through its unlocker as
 * Markdown or HTML (scrape_as_markdown, scrape_as_html). The API key is the
 * one added in Settings, kept in the OS keyring. Calls run in the host
 * process; sandboxed commands reach them only through `sf-web`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getErrorMessage } from '../utils/errors.js';

export type WebOperation = 'search' | 'markdown' | 'html';

export interface WebAccess {
  /** Runs one request; throws with a message for the model when it fails. */
  request(op: WebOperation, arg: string, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

export const BRIGHT_DATA_MCP_URL = 'https://mcp.brightdata.com/mcp';
const TOOLS: Record<WebOperation, string> = { search: 'search_engine', markdown: 'scrape_as_markdown', html: 'scrape_as_html' };
const CONNECT_TIMEOUT_MS = 30_000;

export class WebAccessError extends Error {}

/** The key travels in the endpoint's address, so errors may repeat it: never pass it on. */
function hideKey(message: string, key: string): string {
  return key ? message.split(key).join('[key]').split(encodeURIComponent(key)).join('[key]') : message;
}

export class BrightDataWeb implements WebAccess {
  private client: Promise<{ client: Client; key: string }> | null = null;

  /** @param key Reads the API key (null when none was added). */
  constructor(private readonly key: () => Promise<string | null>, private readonly url = BRIGHT_DATA_MCP_URL) {}

  private async connect(): Promise<Client> {
    const key = await this.key();
    if (!key) throw new WebAccessError('Web access is not set up: add a Bright Data API key in Settings → Providers → Web access (or `sfagents providers web-key`).');
    const current = this.client && (await this.client.catch(() => null));
    if (current && current.key === key) return current.client;
    if (current) await current.client.close().catch(() => {});
    this.client = (async () => {
      const url = new URL(this.url);
      url.searchParams.set('token', key);
      url.searchParams.set('tools', Object.values(TOOLS).join(','));
      const client = new Client({ name: 'sfagents', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(url);
      transport.onclose = () => {
        this.client = null;
      };
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timed out')), CONNECT_TIMEOUT_MS))),
        ]);
      } catch (error) {
        await client.close().catch(() => {});
        throw new WebAccessError(`Could not reach Bright Data (${hideKey(getErrorMessage(error), key)}).`);
      } finally {
        clearTimeout(timer);
      }
      return { client, key };
    })();
    this.client.catch(() => (this.client = null));
    return (await this.client).client;
  }

  async request(op: WebOperation, arg: string, signal?: AbortSignal): Promise<string> {
    const client = await this.connect();
    const key = (await this.key()) ?? '';
    const args = op === 'search' ? { query: arg } : { url: arg };
    let result;
    try {
      result = await client.callTool({ name: TOOLS[op], arguments: args }, undefined, { signal });
    } catch (error) {
      throw new WebAccessError(`Bright Data ${TOOLS[op]} failed: ${hideKey(getErrorMessage(error), key)}`);
    }
    const text = ((result.content as Array<{ type: string; text?: string }> | undefined) ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (result.isError) throw new WebAccessError(`Bright Data ${TOOLS[op]} failed: ${text || 'no details'}`);
    return text;
  }

  async close(): Promise<void> {
    const current = this.client && (await this.client.catch(() => null));
    this.client = null;
    await current?.client.close().catch(() => {});
  }
}
