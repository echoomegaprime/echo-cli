import { isAbsolute } from 'node:path';
import { TOOL_FAMILIES, type ToolFamily, type ToolsBudget } from './types.js';

export interface ToolsConfig {
  enabled: boolean; families: Record<ToolFamily, boolean>; budget: ToolsBudget;
  skills: { roots: string[] }; mcp: { allow: string[] }; memory: { crystal: boolean };
}
/** Reviewed defaults: every family on, 12 calls / 60 s per turn, 6,000 model-facing characters per result. */
export const DEFAULT_TOOLS: ToolsConfig = {
  enabled: true, families: { web: true, wolfram: true, knowledge: true, skills: true, mcp: true },
  budget: { calls: 12, wallMs: 60000, resultChars: 6000 }, skills: { roots: [] }, mcp: { allow: [] }, memory: { crystal: false },
};
const ALLOW_ENTRY = /^[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,100}$/;
/** ESH reads may be allow-listed; every other ESH tool stays behind the review-then-run boundary (`hub.prepare`). */
const ESH_READS = new Set(['esh_status', 'esh_caps', 'esh_ledger', 'esh_session']);
function plain(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid tools configuration: ${what} must be an object`);
  return value as Record<string, unknown>;
}
function only(object: Record<string, unknown>, allowed: string[], what: string): void {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`Invalid tools configuration: unknown ${what} field "${key}"`);
}
function integer(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid tools configuration: ${what} must be an integer between ${min} and ${max}`);
  return value;
}
function flag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid tools configuration: ${what} must be true or false`);
  return value;
}
export const cloneTools = (config: ToolsConfig): ToolsConfig => ({
  enabled: config.enabled, families: { ...config.families }, budget: { ...config.budget },
  skills: { roots: [...config.skills.roots] }, mcp: { allow: [...config.mcp.allow] }, memory: { ...config.memory },
});
/** Strict like `parseModelsConfig`: unknown fields, out-of-range budgets, relative skill roots and ESH action allow-list entries are refused. */
export function parseToolsConfig(value: unknown): ToolsConfig {
  const config = cloneTools(DEFAULT_TOOLS);
  if (value === undefined) return config;
  const input = plain(value, 'tools');
  only(input, ['enabled', 'families', 'budget', 'skills', 'mcp', 'memory'], 'tools');
  if (input.enabled !== undefined) config.enabled = flag(input.enabled, 'enabled');
  if (input.families !== undefined) {
    const families = plain(input.families, 'families');
    only(families, [...TOOL_FAMILIES], 'families');
    for (const family of TOOL_FAMILIES) if (families[family] !== undefined) config.families[family] = flag(families[family], `families.${family}`);
  }
  if (input.budget !== undefined) {
    const budget = plain(input.budget, 'budget');
    only(budget, ['calls', 'wallMs', 'resultChars'], 'budget');
    if (budget.calls !== undefined) config.budget.calls = integer(budget.calls, 1, 30, 'budget.calls');
    if (budget.wallMs !== undefined) config.budget.wallMs = integer(budget.wallMs, 1000, 300000, 'budget.wallMs');
    if (budget.resultChars !== undefined) config.budget.resultChars = integer(budget.resultChars, 500, 20000, 'budget.resultChars');
  }
  if (input.skills !== undefined) {
    const skills = plain(input.skills, 'skills');
    only(skills, ['roots'], 'skills');
    if (skills.roots !== undefined) {
      if (!Array.isArray(skills.roots) || skills.roots.length > 8 || skills.roots.some(r => typeof r !== 'string' || !r || r.length > 1000 || !isAbsolute(r) || [...r].some(c => c.charCodeAt(0) < 32)))
        throw new Error('Invalid tools configuration: skills.roots must list up to 8 absolute directories');
      config.skills.roots = [...skills.roots as string[]];
    }
  }
  if (input.mcp !== undefined) {
    const mcp = plain(input.mcp, 'mcp');
    only(mcp, ['allow'], 'mcp');
    if (mcp.allow !== undefined) {
      if (!Array.isArray(mcp.allow) || mcp.allow.length > 64 || mcp.allow.some(e => typeof e !== 'string' || !ALLOW_ENTRY.test(e)))
        throw new Error('Invalid tools configuration: mcp.allow must list up to 64 "<connection>:<tool>" entries');
      for (const entry of mcp.allow as string[]) {
        const [connection, tool] = entry.split(':');
        if (connection === 'esh' && !ESH_READS.has(tool)) throw new Error(`Invalid tools configuration: mcp.allow "${entry}" would bypass the ESH review-then-run boundary`);
      }
      config.mcp.allow = [...mcp.allow as string[]];
    }
  }
  if (input.memory !== undefined) {
    const memory = plain(input.memory, 'memory');
    only(memory, ['crystal'], 'memory');
    if (memory.crystal !== undefined) config.memory.crystal = flag(memory.crystal, 'memory.crystal');
  }
  return config;
}
