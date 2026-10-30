import { redact } from './workspace.js';
import type { Message } from './sessions.js';
export type Action = { action: 'list' | 'read'; path: string } | { action: 'search'; query: string } | { action: 'propose'; path: string; content: string } | { action: 'final'; content: string };
export interface Model { next(messages: Message[], signal?: AbortSignal): Promise<Action> }
export function validateEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Model endpoint must be a credential-free loopback origin');
  return url;
}
function parseAction(value: unknown): Action {
  if (!value || typeof value !== 'object') throw new Error('Model returned an invalid action');
  const a = value as Record<string, unknown>;
  if (['list', 'read', 'propose'].includes(String(a.action)) && typeof a.path !== 'string') throw new Error('Model action needs a path');
  if (a.action === 'search' && typeof a.query === 'string') return { action: 'search', query: a.query };
  if (a.action === 'read' || a.action === 'list') return { action: a.action, path: a.path as string };
  if (a.action === 'propose' && typeof a.content === 'string') return { action: 'propose', path: a.path as string, content: a.content };
  if (a.action === 'final' && typeof a.content === 'string' && a.content.trim()) return { action: 'final', content: a.content };
  throw new Error('Model returned an unsupported action');
}
export class LocalModel implements Model {
  private endpoint: URL;
  constructor(endpoint: string, readonly model: string, private timeoutMs = 120000) {
    this.endpoint = validateEndpoint(endpoint);
    if (!model || model.length > 150 || /cloud/i.test(model) || [...model].some(c => c.charCodeAt(0) < 32)) throw new Error('Cloud or invalid model names are not supported');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('Invalid model timeout');
  }
  async models(): Promise<string[]> {
    const value = await this.request('api/tags') as { models?: { name: string }[] };
    if (!Array.isArray(value.models)) throw new Error('Local model inventory unavailable');
    return value.models.map(m => m.name).filter(name => typeof name === 'string' && !/cloud/i.test(name));
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
      const response = await fetch(new URL(path, this.endpoint), {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Local model HTTP ${response.status}`); }
      const reader = response.body?.getReader(); if (!reader) throw new Error('Empty local model response');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 512000) throw new Error('Local model response limit exceeded'); chunks.push(value); }
      } finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (signal?.aborted) throw new Error('Interrupted');
      if (error instanceof Error && /^Local model (?:HTTP|response limit)/.test(error.message)) throw error;
      throw new Error('Local model unavailable, timed out, or returned invalid JSON; no provider fallback was used');
    }
  }
  async next(messages: Message[], signal?: AbortSignal): Promise<Action> {
    if (Buffer.byteLength(JSON.stringify(messages)) > 180000) throw new Error('Context limit reached; start a focused session');
    const response = await this.request('api/chat', { model: this.model, stream: false, think: false,
      format: { type: 'object', required: ['action'], properties: {
        action: { type: 'string', enum: ['list', 'read', 'search', 'propose', 'final'] }, path: { type: 'string' }, query: { type: 'string' }, content: { type: 'string' },
      }, additionalProperties: false },
      options: { temperature: 0, num_predict: 4096, num_ctx: 32768 }, messages,
    }, signal) as { message?: { content?: string }; done?: boolean };
    if (!response.done || typeof response.message?.content !== 'string') throw new Error('Local model response is incomplete');
    try { return parseAction(JSON.parse(redact(response.message.content))); }
    catch { throw new Error('Local model returned an invalid action; no tools were executed for that response'); }
  }
}
