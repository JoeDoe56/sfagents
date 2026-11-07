/**
 * Web access for agents, through Bright Data's hosted MCP server: search
 * results from Google or Bing (search_engine, search_engine_batch) and pages
 * fetched through its unlocker as Markdown, HTML, plain text or schema.org
 * data (scrape_as_markdown, scrape_batch). The API key is the one added in
 * Settings, kept in the OS keyring. Calls run in the host process; agent
 * containers reach them only through `sfa-web`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getErrorMessage } from '../utils/errors.js';

export const WEB_FORMATS = ['markdown', 'html', 'text', 'ld_json'] as const;
export type WebFormat = (typeof WEB_FORMATS)[number];
export const SEARCH_ENGINES = ['google', 'bing'] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];
export const TIME_RANGES = ['hour', 'day', 'week', 'month', 'year'] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

export interface WebSearch {
  query: string;
  engine: SearchEngine;
  /** Two-letter country code. */
  country?: string;
  /** Results page, 10 per page, from 0. */
  page?: number;
  timeRange?: TimeRange;
}

/** Most searches or pages Bright Data takes in one batch call. */
export const MAX_WEB_BATCH = 5;

export type WebRequest = { op: 'search'; searches: WebSearch[] } | { op: 'fetch'; format: WebFormat; urls: string[] };

export interface WebReply {
  text: string;
  /** Bright Data's notes on the result (a fallback format, a short page), for stderr. */
  notes?: string[];
}

export interface WebAccess {
  /** Runs one request; throws with a message for the model when it fails. */
  request(req: WebRequest, signal?: AbortSignal): Promise<WebReply>;
  close(): Promise<void>;
}

export const BRIGHT_DATA_MCP_URL = 'https://mcp.brightdata.com/mcp';
const TOOLS = ['search_engine', 'search_engine_batch', 'scrape_as_markdown', 'scrape_batch'];
const CONNECT_TIMEOUT_MS = 30_000;

export class WebAccessError extends Error {}

/** The key travels in the endpoint's address, so errors may repeat it: never pass it on. */
function hideKey(message: string, key: string): string {
  return key ? message.split(key).join('[key]').split(encodeURIComponent(key)).join('[key]') : message;
}

/**
 * Bright Data wraps web content between `=====UNTRUSTED_<nonce>_BEGIN=====`
 * and a matching END line, after a notice for the model. sfa-web gives the
 * agent the content itself (its own prompt already says pages are untrusted),
 * so keep only what is between the markers.
 */
export function unwrapUntrusted(text: string): string {
  const begin = /^=====UNTRUSTED_([0-9a-f]+)_BEGIN=====$/m.exec(text);
  if (!begin) return text;
  const start = begin.index + begin[0].length;
  const endMarker = `=====UNTRUSTED_${begin[1]}_END=====`;
  const end = text.lastIndexOf(endMarker);
  if (end < start) return text;
  return text.slice(start, end).replace(/^\n/, '').replace(/\n$/, '');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function searchArgs(s: WebSearch): Record<string, unknown> {
  return {
    query: s.query,
    engine: s.engine,
    ...(s.country ? { country: s.country.toLowerCase() } : {}),
    ...(s.page ? { page: s.page } : {}),
    ...(s.timeRange ? { time_range: s.timeRange } : {}),
  };
}

interface Page {
  url?: string;
  title?: string;
  format?: string;
  content?: unknown;
  error?: string;
  note?: string;
  notes?: string[];
}

function pageNotes(page: Page): string[] {
  return [...(page.note ? [page.note] : []), ...(Array.isArray(page.notes) ? page.notes.filter((n) => typeof n === 'string') : [])];
}

/**
 * The text sfa-web prints for a request. One page prints as its content (so
 * `> page.md` holds Markdown); several print as a JSON array of
 * {url, title, format, content} or {url, error}. Searches print as JSON.
 */
export function formatWebResult(req: WebRequest, raw: string): WebReply {
  const body = unwrapUntrusted(raw);
  const data = parseJson(body);
  if (data === undefined) return { text: body };
  if (req.op === 'search') return { text: JSON.stringify(data, null, 2) };
  if (req.urls.length === 1 && data && typeof data === 'object' && !Array.isArray(data)) {
    const page = data as Page;
    if (page.error) throw new WebAccessError(page.error);
    if (page.content === undefined) return { text: body };
    const notes = [...(page.format && page.format !== req.format ? [`returned ${page.format} instead of ${req.format}`] : []), ...pageNotes(page)];
    const content = typeof page.content === 'string' ? page.content : JSON.stringify(page.content, null, 2);
    return { text: content, ...(notes.length ? { notes } : {}) };
  }
  return { text: JSON.stringify(data, null, 2) };
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
      url.searchParams.set('tools', TOOLS.join(','));
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

  async request(req: WebRequest, signal?: AbortSignal): Promise<WebReply> {
    const client = await this.connect();
    const key = (await this.key()) ?? '';
    const [name, args] =
      req.op === 'search'
        ? req.searches.length === 1
          ? ['search_engine', searchArgs(req.searches[0]!)]
          : ['search_engine_batch', { queries: req.searches.map(searchArgs) }]
        : req.urls.length === 1
          ? ['scrape_as_markdown', { url: req.urls[0], format: req.format }]
          : ['scrape_batch', { urls: req.urls, format: req.format }];
    let result;
    try {
      result = await client.callTool({ name, arguments: args }, undefined, { signal });
    } catch (error) {
      throw new WebAccessError(`Bright Data ${name} failed: ${hideKey(getErrorMessage(error), key)}`);
    }
    const text = ((result.content as Array<{ type: string; text?: string }> | undefined) ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (result.isError) throw new WebAccessError(`Bright Data ${name} failed: ${text || 'no details'}`);
    return formatWebResult(req, text);
  }

  async close(): Promise<void> {
    const current = this.client && (await this.client.catch(() => null));
    this.client = null;
    await current?.client.close().catch(() => {});
  }
}
