import type { ToolDefinition } from './tools/types.js';

/** The host supplies an authenticated transport to Alevr's broker. No user
 * server URL or provider credential is ever given to the agent or its shell. */
export type McpBridgeRequest = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

export async function brokeredMcpTools(request: McpBridgeRequest, signal?: AbortSignal): Promise<ToolDefinition[]> {
  const result = await request('tools/list', {}, signal) as { tools?: unknown[]; accountScope?: string };
  if (!result || !Array.isArray(result.tools) || result.tools.length > 500 || typeof result.accountScope !== 'string' || !/^[a-f0-9]{64}$/.test(result.accountScope)) throw new Error('Invalid connections catalog');
  const names = new Set<string>();
  return result.tools.map((raw) => {
    const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown };
    if (!tool || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) || names.has(tool.name) || !tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) throw new Error('Invalid connections tool');
    const name = tool.name;
    names.add(name);
    return {
      // Conservative local classification. The server independently enforces
      // its settings, consequential-action floor, approval and audit on EVERY
      // call, even when local Full access allows this command category.
      kind: 'command',
      spec: { name, description: typeof tool.description === 'string' ? tool.description.slice(0, 1024) : name, inputSchema: tool.inputSchema as Record<string, unknown> },
      summarize: () => `Use connection tool ${name}`,
      async execute(input, ctx) {
        if (ctx.signal?.aborted) return { output: 'Connection call cancelled', isError: true };
        try {
          const called = await request('tools/call', { name, arguments: input, callId: ctx.callId, accountScope: result.accountScope }, ctx.signal) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
          if (!called || !Array.isArray(called.content)) throw new Error('Invalid connection result');
          const output = called.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').slice(0, 50_000);
          return { output: output || '(no text result)', isError: called.isError === true };
        } catch { return { output: 'Connection call failed. Check its status in Connections.', isError: true }; }
      },
    } satisfies ToolDefinition;
  });
}

/** For first-party broker endpoints only. Callers build the URL from their
 * trusted backend configuration, never from model input. Fresh authorization
 * is read per call so a native token refresh does not strand a long session. */
export function mcpBridgeRequest(options: { url: string; sessionId: string; authorization: () => string | undefined; fetch?: typeof fetch }): McpBridgeRequest {
  const target = new URL(options.url);
  if (target.pathname !== '/api/mcp/session' || target.username || target.password || target.search || target.hash || (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)))) throw new Error('Invalid connections broker URL');
  const baseFetch = options.fetch ?? fetch;
  return async (method, params, signal) => {
    const authorization = options.authorization();
    if (!authorization) throw new Error('Sign in to use connections');
    const res = await baseFetch(target, {
      method: 'POST', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([AbortSignal.timeout(method === 'tools/call' ? 10 * 60_000 : 20_000), ...(signal ? [signal] : [])]),
      headers: { authorization, 'content-type': 'application/json', 'x-alevr-mcp-session': options.sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    });
    if (!res.ok) throw new Error('Connections broker unavailable');
    // Bound the response while streaming, including chunked responses.
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Empty connections response');
    let total = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 4_194_304) { await reader.cancel(); throw new Error('Connections response is too large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown; result?: unknown };
    if (body.error || body.result === undefined) throw new Error('Invalid connections response');
    return body.result;
  };
}
