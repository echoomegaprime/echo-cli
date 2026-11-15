/**
 * Always-on model tools for ECHO Prime (Commander order 2026-11-04: live internet, Wolfram and other
 * knowledge APIs, Echo memory, Agent Skills and MCP plugins for every model turn).
 *
 * Prime never holds a vendor key. Web search, Wolfram and Echo knowledge/memory reach their vendors through
 * SDK gate capabilities (`echo.websearch.query`, `echo.wolfram.llm`, `echo.knowledge.*`, `echo.context.recall`);
 * the gate holds the keys. `web_fetch` is a direct, bounded public-page read with no credential at all.
 * Every result is untrusted data: redacted, size-capped and wrapped before the model sees it.
 */
export type ToolFamily = 'web' | 'wolfram' | 'knowledge' | 'skills' | 'mcp';
export const TOOL_FAMILIES: readonly ToolFamily[] = ['web', 'wolfram', 'knowledge', 'skills', 'mcp'];
export type Audience = 'owner' | 'member';
/** A member turn gets the public knowledge families; skills and MCP plugins are owner-only. */
export const MEMBER_FAMILIES: readonly ToolFamily[] = ['web', 'wolfram', 'knowledge'];

export type ToolArgs = Record<string, unknown>;
export interface ParamSpec { type: 'string' | 'integer' | 'object'; required?: boolean; description: string; max?: number; min?: number; enum?: readonly string[] }
export interface ToolSpec {
  name: string; family: ToolFamily; description: string; params: Record<string, ParamSpec>;
  /** Result cache lifetime; 0 disables caching for this tool. */
  cacheTtlMs: number;
}
/** One SDK gate invocation: `{command, options}` envelope, result already unwrapped to the gate body. */
export type SdkInvoke = (capability: string, command: string, options: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
export interface McpToolInfo { name: string; description?: string; inputSchema?: unknown }
export interface McpGateway {
  list(signal?: AbortSignal): Promise<Array<{ id: string; name: string; tools: McpToolInfo[] }>>;
  call(id: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
/** Resolves a hostname to every address it has; injected in tests so nothing touches DNS. */
export type Lookup = (hostname: string) => Promise<string[]>;
export interface FetchResponse { status: number; headers: Record<string, string>; body: Buffer; truncated: boolean }
/** One HTTP hop to an already-validated address; injected in tests so nothing touches the network. */
export type FetchTransport = (url: URL, address: string, signal: AbortSignal, maxBytes: number) => Promise<FetchResponse>;
export interface ToolEnvironment {
  sdk?: SdkInvoke; mcp?: McpGateway; lookup?: Lookup; transport?: FetchTransport;
  skillRoots: string[]; mcpAllow: string[]; crystal: boolean; now: () => number;
}
export interface Availability { available: boolean; reason?: string }
export interface ToolModule {
  spec: ToolSpec;
  available(env: ToolEnvironment): Availability;
  run(args: ToolArgs, env: ToolEnvironment, signal: AbortSignal): Promise<Record<string, unknown>>;
}
export interface ToolCall { tool: string; args: ToolArgs }
export type ToolAction = { action: 'tool'; tool: string; args: ToolArgs } | { action: 'tools'; calls: ToolCall[] };
export type ToolEventStatus = 'returned' | 'failed' | 'cached' | 'deduplicated' | 'budget' | 'refused';
/** The shapes `ui/echo-prime/workspace.js` already renders for `tool_started` / `tool_result`. */
export interface ToolEvent {
  type: 'tool_started' | 'tool_result'; tool: string; request_id: string; sha256: string; at: string;
  arguments?: ToolArgs; result?: unknown; cache_hit?: boolean; deduplicated?: boolean; duration_ms?: number;
  evidence?: { status: ToolEventStatus };
}
export interface ToolsBudget { calls: number; wallMs: number; resultChars: number }
export class ToolRefused extends Error {}
