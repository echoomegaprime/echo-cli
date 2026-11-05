import { webSearch } from './web-search.js';
import { webFetch } from './web-fetch.js';
import { wolfram } from './wolfram.js';
import { echoKnowledge } from './echo-knowledge.js';
import { echoMemory } from './echo-memory.js';
import { skills } from './skills.js';
import { mcpPlugins } from './mcp-plugins.js';
import type { ToolModule } from './types.js';

/** The registry. Adding a tool = one module file + one entry here; nothing else in the loop changes. */
export const TOOL_MODULES: readonly ToolModule[] = [webSearch, webFetch, wolfram, echoKnowledge, echoMemory, skills, mcpPlugins];

export { ToolKit, TurnTools, ToolCache, type ToolReport, type ToolKitOptions, type ExecuteOutcome } from './runtime.js';
export { parseToolsConfig, DEFAULT_TOOLS, type ToolsConfig } from './config.js';
export { TOOL_FAMILIES, MEMBER_FAMILIES, ToolRefused } from './types.js';
export type { ToolFamily, Audience, ToolModule, ToolSpec, ToolAction, ToolCall, ToolEvent, ToolEnvironment, SdkInvoke, McpGateway, Lookup, FetchTransport, FetchResponse, ToolArgs } from './types.js';
export { webSearch, webFetch, wolfram, echoKnowledge, echoMemory, skills, mcpPlugins };
