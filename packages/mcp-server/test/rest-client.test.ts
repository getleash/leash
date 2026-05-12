import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RestHttpClient } from '../src/proxy/rest-client.js';
import type { HttpRestUpstreamAdapter } from '../src/upstreams/types.js';

// Build a minimal adapter exercising path params + JSON body + custom headers.
const adapter: HttpRestUpstreamAdapter = {
  name: 'test',
  transport: 'http-rest',
  x402Version: 1,
  challengeLocation: 'body',
  usdcDomainSource: 'hardcoded',
  baseUrl: 'https://api.example.com',
  tools: [
    {
      name: 'search',
      description: 'Search for things.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      method: 'POST',
      path: '/v1/search',
      headers: { 'x-custom': 'static' },
    },
    {
      name: 'get_user',
      description: 'Fetch a user by id.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      method: 'GET',
      path: '/v1/users/{id}',
      bodyMode: 'none',
    },
    {
      name: 'list_items',
      description: 'List items with query params.',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      method: 'GET',
      path: '/v1/items',
      // default bodyMode for GET is 'query'
    },
  ],
};

describe('RestHttpClient', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchOk(body: unknown): { spy: ReturnType<typeof vi.spyOn> } {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    return { spy };
  }

  it('listTools synthesizes the adapter tools', async () => {
    const c = new RestHttpClient(adapter);
    const tools = await c.listTools();
    expect(tools).toHaveLength(3);
    expect(tools[0].name).toBe('search');
    expect(tools[0].inputSchema).toEqual(adapter.tools[0].inputSchema);
  });

  it('POST + JSON body: encodes args as request body', async () => {
    const { spy } = mockFetchOk({ ok: true });
    const c = new RestHttpClient(adapter);
    const res = await c.callTool('search', { query: 'hello' });
    expect(res.status).toBe(200);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/search');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ query: 'hello' });
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-custom']).toBe('static');
  });

  it('GET + path params: substitutes {id} and uses no body', async () => {
    const { spy } = mockFetchOk({ id: '42' });
    const c = new RestHttpClient(adapter);
    await c.callTool('get_user', { id: '42' });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/users/42');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('GET + query mode (default): appends remaining args as URL params', async () => {
    const { spy } = mockFetchOk([]);
    const c = new RestHttpClient(adapter);
    await c.callTool('list_items', { limit: 10 });
    const [url] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/items?limit=10');
  });

  it('extraHeaders (the Payment-Signature on retry) override tool headers', async () => {
    const { spy } = mockFetchOk({ ok: true });
    const c = new RestHttpClient(adapter);
    await c.callTool('search', { query: 'hi' }, { 'X-PAYMENT': 'base64-payload' });
    const init = (spy.mock.calls[0] as [string, RequestInit])[1];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-PAYMENT']).toBe('base64-payload');
  });

  it('forwards 402 status + body so PaidToolCaller can parse the challenge', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ x402Version: 1, accepts: [{ payTo: '0xabc', amount: '10000' }] }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      ),
    );
    const c = new RestHttpClient(adapter);
    const res = await c.callTool('search', { query: 'hi' });
    expect(res.status).toBe(402);
    expect((res.body as { x402Version: number }).x402Version).toBe(1);
  });

  it('throws on unknown tool name', async () => {
    const c = new RestHttpClient(adapter);
    await expect(c.callTool('nonexistent', {})).rejects.toThrow(/unknown tool/);
  });
});
