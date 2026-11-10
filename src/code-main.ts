#!/usr/bin/env node
import { Command } from 'commander';
import { registerCodeCommands } from './code/commands.js';
import { redact } from './code/workspace.js';
const program = new Command().name('echo-code').version('0.1.0');
registerCodeCommands(program);
program.parseAsync().catch(error => {
  process.stderr.write(redact(error instanceof Error ? error.message : 'ECHO Code failed') + '\n');
  process.exitCode = 1;
});
