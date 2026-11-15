import type { ToolModule } from './types.js';
import { record, stamp, str } from './util.js';

export const WOLFRAM_CAP = 'echo.wolfram.llm';
export const WOLFRAM_SIGNUP = 'https://developer.wolframalpha.com/';
export const WOLFRAM_PROVIDER = 'Wolfram|Alpha LLM API (SDK gate echo.wolfram.llm)';
export const WOLFRAM_UNCONFIGURED = `Wolfram not configured: the gate has no Wolfram|Alpha AppID. Fund one at ${WOLFRAM_SIGNUP} and vault it as Wolfram_Alpha / WOLFRAM_FULL_API_KEY for the gate.`;
const NOT_CONFIGURED = /appid|app[_ ]?id|not configured|no key|missing key|unauthori[sz]ed|HTTP 40[13]\b|invalid appid/i;

export const wolfram: ToolModule = {
  spec: {
    name: 'wolfram', family: 'wolfram', cacheTtlMs: 24 * 60 * 60 * 1000,
    description: 'Wolfram|Alpha computational knowledge (math, units, dates, science, real-time facts). Send a short English keyword query; returns the LLM-API answer text with its wolframalpha.com source url.',
    params: { query: { type: 'string', required: true, max: 400, description: 'Short English query, e.g. "integrate x^2 from 0 to 3" or "population of France"' } },
  },
  available: env => env.sdk ? { available: true } : { available: false, reason: 'SDK gate not attached; Wolfram needs the gate capability ' + WOLFRAM_CAP },
  async run(args, env, signal) {
    if (!env.sdk) throw new Error('SDK gate not attached');
    const query = args.query as string, source = 'https://www.wolframalpha.com/input?i=' + encodeURIComponent(query);
    let body: Record<string, unknown>;
    try { body = record(await env.sdk(WOLFRAM_CAP, 'llm', { query }, signal)); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (NOT_CONFIGURED.test(message)) return { ok: false, provider: WOLFRAM_PROVIDER, query, error: WOLFRAM_UNCONFIGURED, signup: WOLFRAM_SIGNUP };
      throw error;
    }
    if (body.ok === false || body.appid_present === false || (typeof body.error === 'string' && NOT_CONFIGURED.test(body.error)))
      return { ok: false, provider: WOLFRAM_PROVIDER, query, error: body.appid_present === false || NOT_CONFIGURED.test(String(body.error ?? '')) ? WOLFRAM_UNCONFIGURED : str(body.error, 400) || 'Wolfram returned no result', signup: WOLFRAM_SIGNUP };
    const result = str(body.result ?? body.answer ?? body.text, 8000);
    if (!result) return { ok: false, provider: WOLFRAM_PROVIDER, query, error: 'Wolfram returned no interpretable result for this query', source };
    return { ok: true, provider: WOLFRAM_PROVIDER, query, result, source, retrieved_at: stamp(env.now) };
  },
};
