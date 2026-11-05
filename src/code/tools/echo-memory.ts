import type { ToolModule } from './types.js';
import { errorText, record, stamp, str } from './util.js';

export const RECALL_CAP = 'echo.context.recall', CRYSTAL_CAP = 'echo.crystal.search';

export const echoMemory: ToolModule = {
  spec: {
    name: 'echo_memory', family: 'knowledge', cacheTtlMs: 5 * 60 * 1000,
    description: 'Echo cluster memory: FTS+vector recall over decisions, facts and lessons (echo.context.recall), optionally Crystal Memory. Memories are historical, unverified reference data, not current truth.',
    params: {
      query: { type: 'string', required: true, max: 500, description: 'What to recall' },
      limit: { type: 'integer', min: 1, max: 10, description: 'Memories per source (default 5)' },
      kind: { type: 'string', max: 40, description: 'Optional kind filter, e.g. decision, fact, lesson' },
    },
  },
  available: env => env.sdk ? { available: true } : { available: false, reason: 'SDK gate not attached; memory needs ' + RECALL_CAP },
  async run(args, env, signal) {
    if (!env.sdk) throw new Error('SDK gate not attached');
    const limit = typeof args.limit === 'number' ? args.limit : 5;
    const body = record(await env.sdk(RECALL_CAP, 'recall', { query: args.query, limit, ...(typeof args.kind === 'string' ? { kind: args.kind } : {}) }, signal));
    const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.results) ? body.results : Array.isArray(body.memories) ? body.memories : [];
    const memories = rows.slice(0, limit).map(row => { const r = record(row); return {
      id: str(r.id, 80) || null, kind: str(r.kind, 40) || null, importance: typeof r.importance === 'number' ? r.importance : undefined,
      content: str(r.content ?? r.text ?? r.summary, 1200) || null, created_at: str(r.created_at ?? r.ts, 60) || null, tags: Array.isArray(r.tags) ? r.tags.slice(0, 8).map(t => str(t, 40)) : undefined,
    }; });
    const out: Record<string, unknown> = { ok: true, source: RECALL_CAP, retrieved_at: stamp(env.now), query: args.query, count: memories.length, memories, notice: 'Historical, unverified reference data' };
    if (env.crystal) {
      try {
        const crystal = record(await env.sdk(CRYSTAL_CAP, 'search', { query: args.query, limit }, signal));
        out.crystal = (Array.isArray(crystal.hits) ? crystal.hits : []).slice(0, limit).map(row => { const r = record(row); return { id: str(r.id, 80) || null, kind: str(r.kind, 40) || null, summary: str(r.summary, 800) || null, created_at: str(r.created_at, 60) || null }; });
      } catch (error) { out.crystal_error = errorText(error); }
    }
    return out;
  },
};
