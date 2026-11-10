import readline from 'node:readline';

const requests = [], heldCalls = [], heldLists = [];
const tools = ['read_status', 'delayed'].map(name => ({ name, inputSchema: { type: 'object' } }));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === 'initialize') {
    reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} } });
    continue;
  }
  requests.push(request);
  if (request.method === 'tools/list') {
    if (process.env.PRIME_TEST_LIST_MODE === 'held' && !request.params.cursor) heldLists.push(request.id);
    else reply(request.id, { tools });
    continue;
  }
  const name = request.params.name;
  if (name === 'delayed') { heldCalls.push(request.id); continue; }
  if (name === 'fixture_state') {
    reply(request.id, { requests, heldCalls: heldCalls.length, heldLists: heldLists.length });
    continue;
  }
  if (name === 'release_calls') {
    for (const id of heldCalls.splice(0)) reply(id, { ok: true, late: true });
  }
  if (name === 'release_list') {
    for (const id of heldLists.splice(0)) reply(id, { tools, nextCursor: 'page-2' });
  }
  reply(request.id, { ok: true });
}
