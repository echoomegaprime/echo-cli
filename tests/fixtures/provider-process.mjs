import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, directory] = process.argv.slice(2);
const fixture = fileURLToPath(import.meta.url);
const note = name => {
  writeFileSync(join(directory, name + '.pid'), String(process.pid));
  writeFileSync(join(directory, name + '.json'), JSON.stringify({ pid: process.pid, parent: process.ppid }));
};
// An independent fixture failsafe; tests also terminate every PID they own in finally.
setTimeout(() => process.exit(99), 15000).unref();
if (mode === 'caller') {
  note('caller');
  const { run } = await import('../../src/code/providers.ts');
  const result = await run(process.execPath, [fixture, 'tree', directory], { cwd: directory, env: { PATH: process.env.PATH }, timeoutMs: 8000, maxBytes: 1024 });
  process.stdout.write(JSON.stringify(result));
} else if (mode === 'signal-answer' || mode === 'signal-refusal') {
  const result = mode === 'signal-answer' ? '{"action":"final","content":"owned valid answer"}' : 'I cannot assist with that request.';
  process.stdout.write(JSON.stringify({ is_error: false, result, modelUsage: { 'owned-signalled-model': { outputTokens: 1 } } }), () => process.kill(process.pid, 'SIGTERM'));
} else if (mode === 'normal') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', text => { input += text; });
  process.stdin.on('end', () => { process.stderr.write('normal diagnostic'); process.stdout.write(JSON.stringify({ input, token: process.env.ECHO_FIXTURE_SENTINEL ?? null })); });
} else if (mode === 'large-normal') {
  process.stdout.write('x'.repeat(128000)); process.stderr.write('e'.repeat(16000));
} else if (mode === 'exit-error') {
  process.stdout.write('partial'); process.stderr.write('failure'); process.exitCode = 7;
} else if (mode === 'tree' || mode === 'parent-exits') {
  note('parent');
  const child = spawn(process.execPath, [fixture, 'descendant', directory], { stdio: 'inherit' });
  child.once('spawn', () => {
    if (mode === 'parent-exits') setTimeout(() => process.exit(0), 100);
  });
  if (mode === 'tree') setInterval(() => {}, 100);
} else {
  process.on('SIGTERM', () => {
    if (mode === 'late-output') { process.stdout.write('LATE_SUCCESS'); process.stderr.write('LATE_ERROR'); }
  });
  note(mode === 'descendant' ? 'descendant' : 'parent');
  if (mode === 'overflow') setTimeout(() => process.stdout.write('x'.repeat(8192)), 30);
  if (mode === 'late-output') process.stdout.write('before-stop');
  setInterval(() => {
    if (mode === 'descendant') appendFileSync(join(directory, 'heartbeat'), '.');
  }, 40);
}
