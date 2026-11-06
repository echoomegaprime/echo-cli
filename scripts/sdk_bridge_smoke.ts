/**
 * Live smoke for the Prime SDK bridge: drives the BUILT bridge
 * (dist/bridge/sdk-stdio.js) through the real StdioMcp + sdkBroker against the
 * real loopback gate, using the real key file (defaults = production paths).
 *
 *   node --import tsx scripts/sdk_bridge_smoke.ts
 *
 * Prints counts only — never the key, never a full body.
 */
import { fileURLToPath } from 'node:url';
import { StdioMcp } from '../src/prime/stdio.js';
import { sdkBroker } from '../src/prime/sdk.js';

const BRIDGE = fileURLToPath(new URL('../dist/bridge/sdk-stdio.js', import.meta.url));

async function main(): Promise<void> {
  const conn = await StdioMcp.connect({ command: process.execPath, args: [BRIDGE] }, 30000);
  try {
    const broker = await sdkBroker(conn, { search: 'sdk_search', read: 'sdk_read', invoke: 'sdk_invoke' });
    const rows = await broker.search('knowledge');
    let readOk = false;
    let id = '';
    if (rows.length > 0) {
      id = rows[0].id;
      try { readOk = Boolean(await broker.read(id)); } catch { readOk = false; }
    }
    process.stdout.write(JSON.stringify({ results: rows.length, readOk, id }) + '\n');
  } finally {
    conn.close();
  }
}

main().catch((error: unknown) => {
  process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : 'smoke failed' }) + '\n');
  process.exit(1);
});
