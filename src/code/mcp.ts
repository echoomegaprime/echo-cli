import { Workspace } from './workspace.js';
const tools = [
  { name: 'echo_code_list', description: 'List visible entries in a bounded workspace directory', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'echo_code_read', description: 'Read bounded UTF-8 source with credential redaction', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'echo_code_search', description: 'Literal source search, up to 40 matches across 500 entries', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } }, additionalProperties: false } },
];
export interface RpcRequest { jsonrpc?: string; id?: string | number | null; method: string; params?: Record<string, unknown> }
export async function dispatchMcp(request: RpcRequest, ws: Workspace, state: { initialized: boolean }): Promise<unknown> {
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: request.id ?? null, error: { code, message } });
  const result = (value: unknown) => ({ jsonrpc: '2.0', id: request.id ?? null, result: value });
  if (typeof request.method !== 'string') return error(-32600, 'Invalid request');
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return undefined;
  if (request.id === undefined) return undefined;
  if (request.method === 'initialize') {
    if (state.initialized) return error(-32600, 'Already initialized');
    state.initialized = true;
    return result({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo-code', version: '0.1.0' } });
  }
  if (!state.initialized) return error(-32002, 'Initialize first');
  if (request.method === 'ping') return result({});
  if (request.method === 'tools/list') return result({ tools });
  if (request.method === 'tools/call') {
    try {
      const params = request.params ?? {}, args = (params.arguments ?? {}) as Record<string, unknown>;
      let value: unknown;
      switch (params.name) {
        case 'echo_code_list': value = ws.list(args.path === undefined ? '.' : args.path as string); break;
        case 'echo_code_read': value = ws.read(args.path as string); break;
        case 'echo_code_search': value = ws.search(args.query as string); break;
        default: throw new Error('Unknown read-only tool');
      }
      return result({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    } catch { return result({ isError: true, content: [{ type: 'text', text: 'Tool refused: invalid, protected, linked, oversized or unavailable path/query' }] }); }
  }
  return error(-32601, 'Method not found');
}
