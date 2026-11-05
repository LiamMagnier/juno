import test from 'node:test';
import assert from 'node:assert/strict';
import { brokeredMcpTools, mcpBridgeRequest } from '../mcp-bridge.js';

const accountScope = 'a'.repeat(64);
const catalog = { accountScope, tools: [{ name: 'user_mcp_abc__send_message', description: 'Send a message', inputSchema: { type: 'object' } }] };

test('broker tools carry the provider call id, account and cancellation through the broker', async () => {
  const calls: unknown[] = [];
  const signal = new AbortController().signal;
  const tools = await brokeredMcpTools(async (method, params, passedSignal) => {
    calls.push({ method, params, signal: passedSignal });
    return method === 'tools/list' ? catalog : { content: [{ type: 'text', text: '<untrusted>sent</untrusted>' }], isError: false };
  });
  assert.equal(tools[0].kind, 'command', 'a server cannot claim a read to bypass local command permissions');
  const result = await tools[0].execute({ channel: 'C123', text: 'hello' }, { cwd: '/tmp', callId: 'provider-call-1', signal });
  assert.equal(result.output, '<untrusted>sent</untrusted>');
  assert.deepEqual(calls[1], { method: 'tools/call', params: { name: catalog.tools[0].name, arguments: { channel: 'C123', text: 'hello' }, callId: 'provider-call-1', accountScope }, signal });
});

test('denied or failed broker calls stay errors and expose no transport secrets', async () => {
  let attempts = 0;
  const [tool] = await brokeredMcpTools(async (method) => {
    if (method === 'tools/list') return catalog;
    attempts++;
    if (attempts === 1) return { content: [{ type: 'text', text: 'Action not permitted' }], isError: true };
    throw new Error('Bearer secret-test-value');
  });
  assert.deepEqual(await tool.execute({}, { cwd: '/tmp' }), { output: 'Action not permitted', isError: true });
  assert.doesNotMatch(JSON.stringify(await tool.execute({}, { cwd: '/tmp' })), /secret-test-value/);
  assert.equal((await tool.execute({}, { cwd: '/tmp', signal: AbortSignal.abort() })).isError, true);
  assert.equal(attempts, 2, 'a cancelled call never reaches the transport');
});

test('invalid, duplicated and oversized catalogs are refused', async () => {
  for (const value of [{ tools: [] }, { ...catalog, tools: [{ name: 'bash', inputSchema: [] }] }, { ...catalog, tools: [...catalog.tools, ...catalog.tools] }, { ...catalog, tools: Array(501).fill(catalog.tools[0]) }]) {
    await assert.rejects(brokeredMcpTools(async () => value), /Invalid connections/);
  }
});

test('broker transport reads fresh auth, refuses redirects and rejects arbitrary paths', async () => {
  let authorization = 'Bearer first-test-token';
  const headers: string[] = [];
  const request = mcpBridgeRequest({ url: 'https://alevr.example/api/mcp/session', sessionId: 'local-1', authorization: () => authorization, fetch: async (_url, init) => {
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    headers.push(new Headers(init?.headers).get('authorization')!);
    return Response.json({ result: catalog });
  } });
  await request('tools/list', {});
  authorization = 'Bearer refreshed-test-token';
  await request('tools/list', {});
  assert.deepEqual(headers, ['Bearer first-test-token', 'Bearer refreshed-test-token']);
  for (const url of ['https://other.example/mcp', 'https://user:password@alevr.example/api/mcp/session', 'http://example.com/api/mcp/session', 'https://alevr.example/api/mcp/session?token=x']) {
    assert.throws(() => mcpBridgeRequest({ url, sessionId: 's', authorization: () => authorization }), /Invalid connections broker/);
  }
});

test('broker response streaming has a hard bound and does not retry a write', async () => {
  let calls = 0;
  const request = mcpBridgeRequest({ url: 'https://alevr.example/api/mcp/session', sessionId: 's', authorization: () => 'Bearer test-token', fetch: async () => {
    calls++;
    return new Response(new Uint8Array(4_194_305));
  } });
  await assert.rejects(request('tools/call', {}), /too large/);
  assert.equal(calls, 1);
});
