import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { createInterface as createPrompt } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './sessions.js';
import { Workspace } from './workspace.js';
import { LocalModel } from './model.js';
import { runTurn } from './agent.js';
import { dispatchMcp } from './mcp.js';
import type { RpcRequest } from './mcp.js';

interface Options { workspace: string; stateDir: string; model: string; endpoint: string; steps: string; session?: string }
function common(command: Command) {
  return command.option('-w, --workspace <path>', 'Workspace directory', process.cwd())
    .option('--state-dir <path>', 'Private local session directory', join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'EchoCode', 'sessions'));
}
function context(opts: Options) {
  const store = new SessionStore(opts.stateDir);
  return { store, workspace: new Workspace(opts.workspace, [store.directory]) };
}
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));

export function registerCodeCommands(code: Command): void {
  code.description('ECHO Code — local inference, source inspection, reviewed edits and resumable sessions');
  common(code.command('run <prompt>').description('Run one bounded turn; all edits stay pending approval'))
    .option('--model <name>', 'Installed local Ollama model', process.env.ECHO_CODE_MODEL || 'echo-steward:4b-pilot')
    .option('--endpoint <origin>', 'Loopback Ollama origin', 'http://127.0.0.1:11434')
    .option('--steps <count>', 'Maximum model steps (1-30)', '10')
    .option('--session <id>', 'Resume this existing session')
    .action(async (prompt: string, opts: Options) => {
      const { store, workspace } = context(opts), model = new LocalModel(opts.endpoint, opts.model);
      const session = opts.session ? store.get(opts.session) : store.create(workspace.root, opts.model);
      if (session.model !== opts.model) throw new Error('Resume model mismatch; select the original model');
      const abort = new AbortController(); const onInterrupt = () => abort.abort(); process.on('SIGINT', onInterrupt);
      try {
        const result = await runTurn({ workspace, store, sessionId: session.id, model, prompt, maxSteps: Number(opts.steps), signal: abort.signal,
          onEvent: event => process.stderr.write(`[${event.kind}] ${event.detail}\n`),
        });
        output(result); if (!['completed', 'pending_approval'].includes(result.status)) process.exitCode = 2;
      } finally { process.off('SIGINT', onInterrupt); }
    });
  common(code.command('chat').description('Interactive local conversation; use /exit to finish'))
    .option('--model <name>', 'Installed local Ollama model', process.env.ECHO_CODE_MODEL || 'echo-steward:4b-pilot')
    .option('--endpoint <origin>', 'Loopback Ollama origin', 'http://127.0.0.1:11434')
    .option('--session <id>', 'Resume a session')
    .action(async (opts: Options) => {
      if (!process.stdin.isTTY) throw new Error('Interactive chat needs a terminal; use run for scripts');
      const { workspace, store } = context(opts), model = new LocalModel(opts.endpoint, opts.model);
      const s = opts.session ? store.get(opts.session) : store.create(workspace.root, opts.model);
      if (s.workspace !== workspace.root || s.model !== opts.model) throw new Error('Resume workspace/model mismatch');
      const prompt = createPrompt({ input: process.stdin, output: process.stdout });
      output({ sessionId: s.id, approval: 'Edits remain staged; inspect with show and apply with approve in a separate invocation.' });
      try { for (;;) {
        const text = await prompt.question('ECHO > '); if (text.trim() === '/exit') break; if (!text.trim()) continue;
        output(await runTurn({ workspace, store, sessionId: s.id, model, prompt: text }));
      } } finally { prompt.close(); }
    });
  common(code.command('doctor').description('Check local model inventory without generating or downloading a model'))
    .option('--model <name>', 'Installed local model', process.env.ECHO_CODE_MODEL || 'echo-steward:4b-pilot')
    .option('--endpoint <origin>', 'Loopback Ollama origin', 'http://127.0.0.1:11434')
    .action(async (opts: Options) => {
      const model = new LocalModel(opts.endpoint, opts.model, 10000), models = await model.models();
      const available = models.includes(opts.model); output({ provider: 'local-ollama', selected: opts.model, available, models, modelGenerationTested: false });
      if (!available) process.exitCode = 2;
    });
  common(code.command('sessions').description('List local session summaries')).action((opts: Options) => output(context(opts).store.list()));
  common(code.command('show <session>').description('Review transcript and complete before/after edits'))
    .action((session: string, opts: Options) => output(context(opts).store.get(session)));
  for (const verb of ['approve', 'revert'] as const) {
    common(code.command(`${verb} <session> <proposal>`).description(verb === 'approve' ? 'Apply one explicitly selected proposal if its original file is unchanged' : 'Restore the original file only if the applied edit is unchanged'))
      .action((session: string, proposal: string, opts: Options) => {
        const { workspace, store } = context(opts); store[verb](session, proposal, workspace);
        output({ session, proposal, status: verb === 'approve' ? 'applied' : 'reverted' });
      });
  }
  common(code.command('recover <session>').description('Reconcile an interrupted session using its owner process and exact file hashes'))
    .action((session: string, opts: Options) => { const { workspace, store } = context(opts); output(store.recover(session, workspace)); });
  common(code.command('mcp').description('Serve the bounded read-only workspace tools over MCP stdio'))
    .action(async (opts: Options) => {
      const ws = new Workspace(opts.workspace, [opts.stateDir]), state = { initialized: false };
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let result: unknown;
        try {
          if (Buffer.byteLength(line) > 262144) throw new Error('oversized');
          const request = JSON.parse(line) as RpcRequest;
          if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid');
          result = await dispatchMcp(request, ws, state);
        } catch { result = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid or oversized JSON request' } }; }
        if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n');
      }
    });
}
