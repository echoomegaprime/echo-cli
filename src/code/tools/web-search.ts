import type { ToolModule } from './types.js';
import { record, stamp, str } from './util.js';

/** The gate capability the Workspace's `internet.py` uses too: Tavily behind `echo.websearch.query`. The key lives on the gate. */
export const SEARCH_CAP = 'echo.websearch.query';
export const SEARCH_PROVIDER = 'Echo web search (Tavily via SDK gate echo.websearch.query)';

export const webSearch: ToolModule = {
  spec: {
    name: 'web_search', family: 'web', cacheTtlMs: 10 * 60 * 1000,
    description: 'Search the live internet. Returns ranked results with title, url, snippet and date (null when the provider gives none) plus the provider name. Cite the url of anything you use.',
    params: {
      query: { type: 'string', required: true, max: 400, description: 'Plain search query' },
      max_results: { type: 'integer', min: 1, max: 10, description: 'How many results (default 5)' },
    },
  },
  available: env => env.sdk ? { available: true } : { available: false, reason: 'SDK gate not attached; web search needs the gate capability ' + SEARCH_CAP },
  async run(args, env, signal) {
    if (!env.sdk) throw new Error('SDK gate not attached');
    const query = args.query as string, max = typeof args.max_results === 'number' ? args.max_results : 5;
    const body = record(await env.sdk(SEARCH_CAP, 'query', { query, max_results: max }, signal));
    const rows = Array.isArray(body.results) ? body.results : Array.isArray(body.sources) ? body.sources : [];
    const results = rows.slice(0, max).map((row, i) => {
      const r = record(row);
      return {
        rank: i + 1, title: str(r.title, 300) || null, url: str(r.url ?? r.link, 2048) || null,
        snippet: str(r.content ?? r.snippet ?? r.description, 600) || null,
        date: str(r.published_date ?? r.date ?? r.published, 60) || null,
        score: typeof r.score === 'number' ? r.score : undefined,
      };
    }).filter(r => r.url);
    if (!results.length && !body.answer) return { ok: false, provider: SEARCH_PROVIDER, query, error: 'The search provider returned no ranked results', retrieved_at: stamp(env.now) };
    return { ok: true, provider: SEARCH_PROVIDER, query, retrieved_at: stamp(env.now), answer: str(body.answer, 1500) || null, results };
  },
};
