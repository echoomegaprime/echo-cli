import type { ToolModule } from './types.js';
import { ToolRefused } from './types.js';
import { record, stamp, str } from './util.js';

export const KNOWLEDGE_SEARCH_CAP = 'echo.knowledge.search', KNOWLEDGE_GET_CAP = 'echo.knowledge.get';
const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export const echoKnowledge: ToolModule = {
  spec: {
    name: 'echo_knowledge', family: 'knowledge', cacheTtlMs: 5 * 60 * 1000,
    description: 'Echo Knowledge Forge: hybrid search over ingested documents (give query) or read one document by doc_id. Results carry title, path/corpus and snippet; cite the doc_id or path.',
    params: {
      query: { type: 'string', max: 500, description: 'Search text (omit when reading a doc_id)' },
      doc_id: { type: 'string', max: 200, description: 'Exact knowledge_docs doc_id to read in full' },
      limit: { type: 'integer', min: 1, max: 10, description: 'Search hits (default 5)' },
    },
  },
  available: env => env.sdk ? { available: true } : { available: false, reason: `SDK gate not attached; knowledge needs ${KNOWLEDGE_SEARCH_CAP} / ${KNOWLEDGE_GET_CAP}` },
  async run(args, env, signal) {
    if (!env.sdk) throw new Error('SDK gate not attached');
    if (typeof args.doc_id === 'string') {
      if (!DOC_ID.test(args.doc_id)) throw new ToolRefused('doc_id has an invalid shape');
      const body = record(await env.sdk(KNOWLEDGE_GET_CAP, 'get', { doc_id: args.doc_id, include_body: true }, signal));
      const doc = record(body.data ?? body.doc ?? body);
      if (!doc.doc_id && !doc.title && !doc.body_md) return { ok: false, source: KNOWLEDGE_GET_CAP, doc_id: args.doc_id, error: 'No document with this doc_id was returned' };
      return { ok: true, source: KNOWLEDGE_GET_CAP, retrieved_at: stamp(env.now), doc_id: str(doc.doc_id, 200) || args.doc_id, title: str(doc.title, 300) || null, body_sha256: str(doc.body_sha256, 64) || null, body: str(doc.body_md ?? doc.body, 12000) || null };
    }
    if (typeof args.query !== 'string') throw new ToolRefused('Give a query to search or a doc_id to read');
    const limit = typeof args.limit === 'number' ? args.limit : 5;
    const body = record(await env.sdk(KNOWLEDGE_SEARCH_CAP, 'search', { query: args.query, limit, snippet_chars: 400 }, signal));
    const rows = Array.isArray(body.hits) ? body.hits : Array.isArray(body.results) ? body.results : [];
    const hits = rows.slice(0, limit).map((row, i) => { const r = record(row); return {
      rank: i + 1, title: str(r.title, 300) || null, doc_id: str(r.doc_id, 200) || null, path: str(r.path, 500) || null, corpus_id: str(r.corpus_id, 100) || null,
      snippet: str(r.snippet ?? r.content, 600) || null, score: typeof r.hybrid_score === 'number' ? r.hybrid_score : typeof r.score === 'number' ? r.score : undefined, modes: Array.isArray(r.modes) ? r.modes.slice(0, 4).map(m => str(m, 20)) : undefined,
    }; });
    return { ok: true, source: KNOWLEDGE_SEARCH_CAP, retrieved_at: stamp(env.now), query: args.query, hit_count: typeof body.hit_count === 'number' ? body.hit_count : hits.length, hits };
  },
};
