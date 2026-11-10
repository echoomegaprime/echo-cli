import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('reports the Prime package version when invoked from another working directory', () => {
  const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'echo-cli-version-'));
  try {
    const output = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), entry, '--version'], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache') },
    });
    expect(output.trim()).toBe(expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
