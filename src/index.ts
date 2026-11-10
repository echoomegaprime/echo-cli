#!/usr/bin/env node
/**
 * @echo-prime/cli
 * Echo Prime Technologies CLI — Query engines, search knowledge, manage doctrines, deploy workers.
 * Commander: Bobby Don McWilliams II | Authority 11.0 SUPREME SOVEREIGN
 */
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { config, getApiKey } from './config.js';
import { EchoClient, EchoApiError } from './client.js';
import { formatOutput, printSuccess, printError, printHeader, printWarning } from './formatters.js';

import { PACKAGE_VERSION as VERSION } from './version.js';

const program = new Command();
program
  .name('echo')
  .description('Echo Prime Technologies CLI — Intelligence at your fingertips')
  .version(VERSION, '-v, --version');

// Global options
program
  .option('-k, --api-key <key>', 'API key (overrides config)')
  .option('-f, --format <fmt>', 'Output format: json, table, text', 'text')
  .option('--verbose', 'Verbose output')
  .option('--gateway <url>', 'Gateway URL override');

function getClient(opts: { apiKey?: string; gateway?: string } = {}): EchoClient {
  return new EchoClient(
    opts.gateway || undefined,
    opts.apiKey || undefined
  );
}

async function run<T>(label: string, fn: () => Promise<T>, opts: { format?: string } = {}): Promise<void> {
  const spinner = ora(label).start();
  try {
    const result = await fn();
    spinner.stop();
    console.log(formatOutput(result, opts.format || program.opts().format));
  } catch (err) {
    spinner.fail();
    if (err instanceof EchoApiError) {
      printError(`${err.code}: ${err.message}`);
    } else {
      printError(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  }
}

// ─── CONFIG ────────────────────────────────────────────────────────────
const configCmd = program.command('config').description('Manage CLI configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a config value (apiKey, gatewayUrl, defaultDomain, outputFormat)')
  .action((key: string, value: string) => {
    const validKeys = ['apiKey', 'gatewayUrl', 'defaultDomain', 'defaultPersonality', 'outputFormat', 'verbose'];
    if (!validKeys.includes(key)) {
      printError(`Invalid key. Valid keys: ${validKeys.join(', ')}`);
      process.exit(1);
    }
    const castValue = key === 'verbose' ? value === 'true' : value;
    config.set(key as keyof typeof config.store, castValue as never);
    printSuccess(`${key} = ${value}`);
  });

configCmd
  .command('get [key]')
  .description('Get config value(s)')
  .action((key?: string) => {
    if (key) {
      console.log(config.get(key as keyof typeof config.store));
    } else {
      const store = config.store;
      const safeStore = { ...store, apiKey: store.apiKey ? '***' + store.apiKey.slice(-6) : '(not set)' };
      console.log(formatOutput(safeStore, 'text'));
    }
  });

configCmd
  .command('path')
  .description('Show config file path')
  .action(() => {
    console.log(config.path);
  });

// ─── INIT ──────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize Echo CLI with your API key')
  .argument('[apiKey]', 'Your Echo Prime API key')
  .action(async (apiKey?: string) => {
    printHeader('Echo Prime CLI Setup');
    if (!apiKey) {
      console.log('\nGet your API key at: ' + chalk.underline('https://echo-ept.com/sdk'));
      console.log('Then run: ' + chalk.cyan('echo init <your-api-key>'));
      return;
    }
    config.set('apiKey', apiKey);
    const spinner = ora('Verifying API key...').start();
    try {
      const client = new EchoClient(undefined, apiKey);
      const health = await client.health() as Record<string, unknown>;
      spinner.succeed('Connected to Echo Prime Gateway');
      console.log(`  Version: ${health.version || 'unknown'}`);
      console.log(`  Services: ${(health.services as string[])?.length || 'unknown'}`);
      printSuccess('CLI configured. Try: echo engine query "What is MACRS depreciation?"');
    } catch {
      spinner.fail('Failed to connect — check your API key');
      config.set('apiKey', '');
    }
  });

// ─── STATUS ────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show system health and connectivity')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Checking system status...', async () => {
      const health = await client.health();
      return health;
    }, opts);
  });

// ─── DOCTOR ────────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('Diagnose connectivity and configuration issues')
  .action(async () => {
    printHeader('Echo Prime Doctor');
    const checks: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }> = [];

    // Check API key
    const key = getApiKey();
    if (key) {
      checks.push({ name: 'API Key', status: 'ok', detail: `Configured (***${key.slice(-6)})` });
    } else {
      checks.push({ name: 'API Key', status: 'fail', detail: 'Not configured. Run: echo init <key>' });
    }

    // Check gateway
    const gwUrl = config.get('gatewayUrl');
    checks.push({ name: 'Gateway URL', status: 'ok', detail: gwUrl });

    // Check connectivity
    if (key) {
      try {
        const client = new EchoClient(undefined, key);
        const health = await client.health() as Record<string, unknown>;
        checks.push({ name: 'Gateway Health', status: 'ok', detail: `v${health.version || '?'}, ${(health.services as unknown[])?.length || '?'} services` });

        // Check engine runtime
        try {
          const status = await client.engineStats() as Record<string, unknown>;
          checks.push({ name: 'Engine Runtime', status: 'ok', detail: `${status.total_engines || '?'} engines, ${status.total_doctrines || '?'} doctrines` });
        } catch {
          checks.push({ name: 'Engine Runtime', status: 'warn', detail: 'Engine status unavailable' });
        }
      } catch (err) {
        checks.push({ name: 'Gateway Health', status: 'fail', detail: err instanceof Error ? err.message : 'Connection failed' });
      }
    } else {
      checks.push({ name: 'Gateway Health', status: 'fail', detail: 'Skipped — no API key' });
    }

    // Check Node version
    const nodeVer = process.version;
    const major = parseInt(nodeVer.slice(1));
    checks.push({
      name: 'Node.js',
      status: major >= 20 ? 'ok' : 'warn',
      detail: `${nodeVer} ${major >= 20 ? '' : '(recommend v20+)'}`,
    });

    // Print results
    for (const check of checks) {
      const icon = check.status === 'ok' ? chalk.green('✓') : check.status === 'warn' ? chalk.yellow('⚠') : chalk.red('✗');
      console.log(`  ${icon} ${chalk.bold(check.name)}: ${check.detail}`);
    }

    const failures = checks.filter(c => c.status === 'fail');
    if (failures.length === 0) {
      console.log(chalk.green('\n  All checks passed.'));
    } else {
      console.log(chalk.red(`\n  ${failures.length} issue(s) found.`));
    }
  });

// ─── ENGINE ────────────────────────────────────────────────────────────
const engineCmd = program.command('engine').description('Query and explore intelligence engines');

engineCmd
  .command('query <question>')
  .description('Ask a question — routed to the best engine')
  .option('-d, --domain <domain>', 'Target domain (tax, legal, oilfield, etc.)')
  .option('-e, --engine <id>', 'Specific engine ID (e.g., LG01, TX14)')
  .action(async (question: string, cmdOpts: { domain?: string; engine?: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Querying engines: "${question.slice(0, 50)}..."`, async () => {
      if (cmdOpts.engine) {
        return client.engineQuery(cmdOpts.engine, question);
      }
      // Use search for broad queries (semantic + keyword across all engines)
      return client.engineSearch(question, 5);
    }, opts);
  });

engineCmd
  .command('list')
  .description('List available engine domains')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching engine domains...', async () => {
      return client.engineDomains();
    }, opts);
  });

engineCmd
  .command('search <query>')
  .description('Search engines by keyword')
  .option('-l, --limit <n>', 'Max results', '10')
  .action(async (query: string, cmdOpts: { limit: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Searching engines: "${query}"`, async () => {
      return client.engineSearch(query, parseInt(cmdOpts.limit));
    }, opts);
  });

engineCmd
  .command('info <engineId>')
  .description('Get engine details by ID')
  .action(async (engineId: string) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Fetching engine: ${engineId}`, async () => {
      return client.engineGet(engineId);
    }, opts);
  });

engineCmd
  .command('status')
  .description('Engine runtime health and stats')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Checking engine runtime...', async () => {
      return client.engineStats();
    }, opts);
  });

// ─── KNOWLEDGE ─────────────────────────────────────────────────────────
const knowledgeCmd = program.command('knowledge').alias('kg').description('Search the Knowledge Forge');

knowledgeCmd
  .command('search <query>')
  .description('Search knowledge base')
  .option('-l, --limit <n>', 'Max results', '5')
  .action(async (query: string, cmdOpts: { limit: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Searching knowledge: "${query}"`, async () => {
      return client.knowledgeSearch(query, parseInt(cmdOpts.limit));
    }, opts);
  });

knowledgeCmd
  .command('categories')
  .description('List knowledge categories')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching categories...', async () => {
      return client.knowledgeCategories();
    }, opts);
  });

// ─── BRAIN ─────────────────────────────────────────────────────────────
const brainCmd = program.command('brain').description('Interact with the Shared Brain memory system');

brainCmd
  .command('search <query>')
  .description('Search brain memories')
  .option('-l, --limit <n>', 'Max results', '10')
  .action(async (query: string, cmdOpts: { limit: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Searching brain: "${query}"`, async () => {
      return client.brainSearch(query, parseInt(cmdOpts.limit));
    }, opts);
  });

brainCmd
  .command('store <content>')
  .description('Store a memory in the Shared Brain')
  .option('-i, --importance <n>', 'Importance level (1-10)', '5')
  .option('-t, --tags <tags>', 'Comma-separated tags', '')
  .action(async (content: string, cmdOpts: { importance: string; tags: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    const tags = cmdOpts.tags ? cmdOpts.tags.split(',').map(t => t.trim()) : [];
    await run('Storing to brain...', async () => {
      return client.brainIngest(content, parseInt(cmdOpts.importance), tags);
    }, opts);
    printSuccess('Memory stored.');
  });

brainCmd
  .command('recall <key>')
  .description('Recall a specific memory by key')
  .action(async (key: string) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Recalling: ${key}`, async () => {
      return client.brainRecall(key);
    }, opts);
  });

brainCmd
  .command('stats')
  .description('Brain storage statistics')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching brain stats...', async () => {
      return client.brainStats();
    }, opts);
  });

// ─── DOCTRINE ─────────────────────────────────────────────────────────
const doctrineCmd = program.command('doctrine').alias('doc').description('Generate and manage doctrine blocks');

doctrineCmd
  .command('generate <domain> <topic>')
  .description('Generate a doctrine block for a domain/topic')
  .option('-p, --provider <provider>', 'LLM provider (default: auto)')
  .action(async (domain: string, topic: string, cmdOpts: { provider?: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Generating doctrine: ${domain}/${topic}`, async () => {
      return client.doctrineGenerate(domain, topic, cmdOpts.provider);
    }, opts);
  });

doctrineCmd
  .command('list')
  .description('List generated doctrines')
  .option('-d, --domain <domain>', 'Filter by domain')
  .action(async (cmdOpts: { domain?: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching doctrines...', async () => {
      return client.doctrineList(cmdOpts.domain);
    }, opts);
  });

doctrineCmd
  .command('providers')
  .description('List available LLM providers for doctrine generation')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching providers...', async () => {
      return client.doctrineProviders();
    }, opts);
  });

// ─── CHAT ─────────────────────────────────────────────────────────────
program
  .command('chat <message>')
  .description('Chat with Echo Prime AI (14 personalities)')
  .option('-p, --personality <id>', 'AI personality (echo_prime, bree, nexus, etc.)')
  .action(async (message: string, cmdOpts: { personality?: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    const personality = cmdOpts.personality || config.get('defaultPersonality');
    await run(`Thinking...`, async () => {
      return client.chat(message, personality);
    }, opts);
  });

// ─── SEARCH ───────────────────────────────────────────────────────────
program
  .command('search <query>')
  .description('Unified search across engines, knowledge, and brain')
  .option('-s, --sources <sources>', 'Comma-separated sources: engines,knowledge,brain', 'engines,knowledge,brain')
  .option('-l, --limit <n>', 'Max results per source', '5')
  .action(async (query: string, cmdOpts: { sources: string; limit: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    const sources = cmdOpts.sources.split(',').map(s => s.trim());
    await run(`Searching: "${query}"`, async () => {
      return client.search(query, sources, parseInt(cmdOpts.limit));
    }, opts);
  });

// ─── TOOLS ────────────────────────────────────────────────────────────
const toolsCmd = program.command('tools').description('Discover and explore ECHO tools and capabilities');

toolsCmd
  .command('search <query>')
  .description('Search for tools by keyword')
  .option('-c, --category <cat>', 'Filter by category')
  .option('-l, --limit <n>', 'Max results', '10')
  .action(async (query: string, cmdOpts: { category?: string; limit: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Searching tools: "${query}"`, async () => {
      return client.toolSearch(query, cmdOpts.category, parseInt(cmdOpts.limit));
    }, opts);
  });

toolsCmd
  .command('list')
  .description('List tools in a category')
  .option('-c, --category <cat>', 'Category filter')
  .action(async (cmdOpts: { category?: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching tools...', async () => {
      return client.toolList(cmdOpts.category);
    }, opts);
  });

toolsCmd
  .command('chains')
  .description('List recommended tool chains (multi-tool pipelines)')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching tool chains...', async () => {
      return client.toolChains();
    }, opts);
  });

toolsCmd
  .command('recommend <task>')
  .description('Get tool recommendations for a task')
  .action(async (task: string) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Getting recommendations for: "${task}"`, async () => {
      return client.toolRecommend(task);
    }, opts);
  });

toolsCmd
  .command('stats')
  .description('Tool usage statistics')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching tool stats...', async () => {
      return client.toolStats();
    }, opts);
  });

// ─── BOTS ─────────────────────────────────────────────────────────────
const botsCmd = program.command('bots').description('Bot Factory — deploy and manage bots');

botsCmd
  .command('templates')
  .description('List available bot templates')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching bot templates...', async () => {
      return client.botTemplates();
    }, opts);
  });

botsCmd
  .command('deploy <templateId>')
  .description('Deploy a bot from a template')
  .option('-c, --config <json>', 'Bot configuration JSON')
  .action(async (templateId: string, cmdOpts: { config?: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    let botConfig: Record<string, unknown> = {};
    if (cmdOpts.config) {
      try { botConfig = JSON.parse(cmdOpts.config); } catch { printError('Invalid JSON config'); process.exit(1); }
    }
    await run(`Deploying bot: ${templateId}`, async () => {
      return client.botDeploy(templateId, botConfig);
    }, opts);
  });

botsCmd
  .command('list')
  .description('List deployed bots')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching deployments...', async () => {
      return client.botList();
    }, opts);
  });

botsCmd
  .command('logs <deploymentId>')
  .description('View bot deployment logs')
  .action(async (deploymentId: string) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching logs...', async () => {
      return client.botLogs(deploymentId);
    }, opts);
  });

// ─── SCRAPERS ─────────────────────────────────────────────────────────
const scrapersCmd = program.command('scrapers').alias('scrape').description('Scraper Orchestrator — run and manage scrape jobs');

scrapersCmd
  .command('templates')
  .description('List available scraper templates')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching scraper templates...', async () => {
      return client.scraperTemplates();
    }, opts);
  });

scrapersCmd
  .command('run <templateId>')
  .description('Start a scrape job from a template')
  .option('-p, --params <json>', 'Job parameters JSON')
  .action(async (templateId: string, cmdOpts: { params?: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    let params: Record<string, unknown> = {};
    if (cmdOpts.params) {
      try { params = JSON.parse(cmdOpts.params); } catch { printError('Invalid JSON params'); process.exit(1); }
    }
    await run(`Starting scrape job: ${templateId}`, async () => {
      return client.scraperRun(templateId, params);
    }, opts);
  });

scrapersCmd
  .command('jobs')
  .description('List scrape jobs')
  .option('-s, --status <status>', 'Filter by status (pending, running, completed, failed)')
  .action(async (cmdOpts: { status?: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching jobs...', async () => {
      return client.scraperJobs(cmdOpts.status);
    }, opts);
  });

scrapersCmd
  .command('results <jobId>')
  .description('Get results for a scrape job')
  .action(async (jobId: string) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Fetching results: ${jobId}`, async () => {
      return client.scraperResults(jobId);
    }, opts);
  });

// ─── DASHBOARD ────────────────────────────────────────────────────────
const dashCmd = program.command('dashboard').alias('dash').description('SDK usage dashboard and analytics');

dashCmd
  .command('usage')
  .description('View API usage statistics')
  .option('-p, --period <period>', 'Time period: today, week, month', 'today')
  .action(async (cmdOpts: { period: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching usage...', async () => {
      return client.dashboardUsage(cmdOpts.period);
    }, opts);
  });

dashCmd
  .command('tenants')
  .description('List tenant accounts')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching tenants...', async () => {
      return client.dashboardTenants();
    }, opts);
  });

dashCmd
  .command('audit')
  .description('View audit log')
  .option('-l, --limit <n>', 'Max entries', '50')
  .action(async (cmdOpts: { limit: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching audit log...', async () => {
      return client.dashboardAudit(parseInt(cmdOpts.limit));
    }, opts);
  });

// ─── AUTH ──────────────────────────────────────────────────────────────
const authCmd = program.command('auth').description('Manage API keys and authentication');

authCmd
  .command('create-key <name>')
  .description('Create a new API key')
  .option('-p, --plan <plan>', 'Plan tier: free, pro, enterprise', 'free')
  .action(async (name: string, cmdOpts: { plan: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Creating API key: ${name}`, async () => {
      return client.authCreateKey(name, cmdOpts.plan);
    }, opts);
  });

authCmd
  .command('list-keys')
  .description('List all API keys for your tenant')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching API keys...', async () => {
      return client.authListKeys();
    }, opts);
  });

// ─── WORKER ────────────────────────────────────────────────────────────
const workerCmd = program.command('worker').description('Call other Echo Workers via gateway proxy');

workerCmd
  .command('call <worker> <path>')
  .description('Proxy a request to a Worker')
  .option('-m, --method <method>', 'HTTP method', 'GET')
  .option('-b, --body <json>', 'JSON body for POST/PUT')
  .action(async (worker: string, path: string, cmdOpts: { method: string; body?: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    let body: Record<string, unknown> | undefined;
    if (cmdOpts.body) {
      try {
        body = JSON.parse(cmdOpts.body);
      } catch {
        printError('Invalid JSON body');
        process.exit(1);
      }
    }
    await run(`Calling ${worker}${path}...`, async () => {
      return client.workerCall(worker, path, cmdOpts.method, body);
    }, opts);
  });

workerCmd
  .command('list')
  .description('List known Workers and their health')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching worker list...', async () => {
      return client.workerCall('echo-service-registry', '/services', 'GET');
    }, opts);
  });

// ─── VAULT ─────────────────────────────────────────────────────────────
program
  .command('vault <service>')
  .description('Retrieve a credential from the vault')
  .action(async (service: string) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Fetching credential: ${service}`, async () => {
      return client.vaultGet(service);
    }, opts);
  });

// ─── DEPLOY ────────────────────────────────────────────────────────────
program
  .command('deploy [path]')
  .description('Deploy a Worker to Cloudflare (wraps wrangler)')
  .option('--dry-run', 'Show what would be deployed')
  .action(async (path?: string, cmdOpts?: { dryRun?: boolean }) => {
    const cwd = path || process.cwd();
    printHeader('Echo Deploy');
    console.log(`  Directory: ${cwd}`);
    if (cmdOpts?.dryRun) {
      printWarning('Dry run — no changes will be made');
    }
    // Delegate to wrangler
    const { execSync } = await import('child_process');
    try {
      const cmd = cmdOpts?.dryRun ? 'npx wrangler deploy --dry-run' : 'npx wrangler deploy';
      execSync(cmd, { cwd, stdio: 'inherit' });
      printSuccess('Deployed successfully.');
    } catch {
      printError('Deploy failed. Check wrangler output above.');
      process.exit(1);
    }
  });

// ─── FORGE ────────────────────────────────────────────────────────────
const forgeCmd = program.command('forge').description('Trigger forge builds — create engines, workers, bots');

forgeCmd
  .command('create <type> <spec>')
  .alias('build')
  .description('Trigger a forge build (type: engine, worker, bot, scraper)')
  .action(async (type: string, spec: string) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Forging ${type}: "${spec.slice(0, 60)}"`, async () => {
      return client.forgeCreate(type, spec);
    }, opts);
  });

forgeCmd
  .command('status <buildId>')
  .description('Check forge build status')
  .action(async (buildId: string) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Checking build: ${buildId}`, async () => {
      return client.forgeStatus(buildId);
    }, opts);
  });

forgeCmd
  .command('list')
  .description('List recent forge builds')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching forge builds...', async () => {
      return client.forgeList();
    }, opts);
  });

// ─── LLM ──────────────────────────────────────────────────────────────
program
  .command('llm <prompt>')
  .description('Query an LLM through the gateway')
  .option('-p, --provider <provider>', 'LLM provider (e.g., openai, anthropic, groq)')
  .option('-m, --model <model>', 'Specific model name')
  .action(async (prompt: string, cmdOpts: { provider?: string; model?: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Querying LLM...', async () => {
      return client.llmQuery(prompt, cmdOpts.provider, cmdOpts.model);
    }, opts);
  });

// ─── AGI ──────────────────────────────────────────────────────────────
const agiCmd = program.command('agi').description('AGI self-improvement and learning status');

agiCmd
  .command('status')
  .description('Show AGI learning status and metrics')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching AGI status...', async () => {
      return client.agiStatus();
    }, opts);
  });

agiCmd
  .command('history')
  .description('Show AGI learning history')
  .option('-l, --limit <n>', 'Max entries', '20')
  .action(async (cmdOpts: { limit: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching learning history...', async () => {
      return client.agiLearningHistory(parseInt(cmdOpts.limit));
    }, opts);
  });

// ─── COMPOSE ──────────────────────────────────────────────────────────
const composeCmd = program.command('compose').description('Create and manage compound engines');

composeCmd
  .command('create <engines...>')
  .description('Create a compound engine from multiple engines')
  .option('-n, --name <name>', 'Name for the compound engine')
  .action(async (engines: string[], cmdOpts: { name?: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Composing ${engines.length} engines...`, async () => {
      return client.composeCreate(engines, cmdOpts.name);
    }, opts);
  });

composeCmd
  .command('list')
  .description('List compound engines')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching compound engines...', async () => {
      return client.composeList();
    }, opts);
  });

composeCmd
  .command('info <compoundId>')
  .description('Get details about a compound engine')
  .action(async (compoundId: string) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Fetching compound engine: ${compoundId}`, async () => {
      return client.composeInfo(compoundId);
    }, opts);
  });

// ─── WEBHOOKS ─────────────────────────────────────────────────────────
const webhooksCmd = program.command('webhooks').alias('wh').description('Manage webhook subscriptions');

webhooksCmd
  .command('list')
  .description('List webhook subscriptions')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching webhooks...', async () => {
      return client.webhooksList();
    }, opts);
  });

webhooksCmd
  .command('create <url>')
  .description('Create a webhook subscription')
  .option('-e, --events <events>', 'Comma-separated event types', 'engine.query,forge.complete')
  .action(async (url: string, cmdOpts: { events: string }) => {
    const opts = program.opts();
    const client = getClient(opts);
    const events = cmdOpts.events.split(',').map(e => e.trim());
    await run(`Creating webhook: ${url}`, async () => {
      return client.webhooksCreate(url, events);
    }, opts);
  });

webhooksCmd
  .command('delete <webhookId>')
  .description('Delete a webhook subscription')
  .action(async (webhookId: string) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Deleting webhook: ${webhookId}`, async () => {
      return client.webhooksDelete(webhookId);
    }, opts);
  });

webhooksCmd
  .command('test <webhookId>')
  .description('Send a test event to a webhook')
  .action(async (webhookId: string) => {
    const opts = program.opts();
    const client = getClient(opts);
    await run(`Testing webhook: ${webhookId}`, async () => {
      return client.webhooksTest(webhookId);
    }, opts);
  });

// ─── SIGNUP — Public, no auth ──────────────────────────────────────────
program
  .command('signup')
  .description('Create a free Echo SDK account and get your API key')
  .argument('<email>', 'Your email address')
  .option('-n, --name <name>', 'Your name or company')
  .action(async (email: string, opts: { name?: string }) => {
    const spinner = ora('Creating your account...').start();
    try {
      const baseUrl = program.opts().gateway || 'https://echo-sdk-gateway.bmcii1976.workers.dev';
      const resp = await fetch(`${baseUrl}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: opts.name || email.split('@')[0] }),
      });
      const json = await resp.json() as { success: boolean; data: { api_key: string; tenant_id: string; plan: string; limits: { daily: number } }; error?: { message: string } };
      spinner.stop();
      if (!json.success) {
        printError(json.error?.message || 'Signup failed');
        process.exit(1);
      }

      // Auto-save the API key
      config.set('apiKey', json.data.api_key);

      console.log('');
      printSuccess('Account created successfully!');
      console.log('');
      console.log(chalk.bold('  Your API Key: ') + chalk.green(json.data.api_key));
      console.log(chalk.dim('  (Saved to config — you\'re ready to go!)'));
      console.log('');
      console.log(chalk.bold('  Plan: ') + chalk.cyan(json.data.plan) + chalk.dim(` (${json.data.limits.daily} requests/day)`));
      console.log(chalk.bold('  Tenant ID: ') + json.data.tenant_id);
      console.log('');
      console.log(chalk.bold('  Quick start:'));
      console.log(chalk.dim('    echo engine query "contract liability"'));
      console.log(chalk.dim('    echo knowledge search "drilling regulations"'));
      console.log(chalk.dim('    echo llm "Summarize this contract..."'));
      console.log('');
      console.log(chalk.dim('  Upgrade: ') + chalk.underline('https://echo-ept.com/sdk/pricing'));
      console.log(chalk.dim('  Docs:    ') + chalk.underline('https://echo-ept.com/sdk/docs'));
      console.log('');
      printWarning('Store your API key securely — it cannot be retrieved again.');
    } catch (err) {
      spinner.fail();
      printError(err instanceof Error ? err.message : 'Network error');
      process.exit(1);
    }
  });

// ─── LOGIN — Set API key ──────────────────────────────────────────────
program
  .command('login')
  .description('Set your API key (or run "echo signup" to create an account)')
  .argument('<api-key>', 'Your echo_sk_* API key')
  .action(async (apiKey: string) => {
    if (!apiKey.startsWith('echo_sk_')) {
      printError('Invalid key format. Keys start with echo_sk_');
      process.exit(1);
    }

    config.set('apiKey', apiKey);
    const spinner = ora('Verifying API key...').start();

    try {
      const client = getClient({ apiKey });
      const whoami = await client.authWhoami() as { type: string; tenant_id: string; tenant?: { name: string; plan: string } };
      spinner.stop();
      printSuccess(`Logged in as ${whoami.tenant?.name || whoami.tenant_id} (${whoami.tenant?.plan || 'unknown'} plan)`);
    } catch {
      spinner.stop();
      config.set('apiKey', apiKey); // Save anyway — might work later
      printWarning('Key saved but could not verify. Check your key if requests fail.');
    }
  });

// ─── LOGOUT ────────────────────────────────────────────────────────────
program
  .command('logout')
  .description('Remove saved API key')
  .action(() => {
    config.set('apiKey', '');
    printSuccess('API key removed.');
  });

// ─── PLANS — Show pricing ─────────────────────────────────────────────
program
  .command('plans')
  .description('Show available SDK plans and pricing')
  .action(async () => {
    const baseUrl = program.opts().gateway || 'https://echo-sdk-gateway.bmcii1976.workers.dev';
    const spinner = ora('Loading plans...').start();
    try {
      const resp = await fetch(`${baseUrl}/auth/plans`, { headers: { 'Content-Type': 'application/json' } });
      const json = await resp.json() as { data: { plans: Array<{ id: string; name: string; price_monthly: number; daily_limit: number; features: string[] }> } };
      spinner.stop();
      console.log('');
      printHeader('Echo SDK Plans');
      console.log('');
      for (const plan of json.data.plans) {
        const price = plan.price_monthly === 0 ? chalk.green('FREE') : chalk.yellow(`$${plan.price_monthly}/mo`);
        console.log(`  ${chalk.bold(plan.name.padEnd(12))} ${price.padEnd(20)} ${chalk.dim(plan.daily_limit.toLocaleString() + ' req/day')}`);
        for (const f of plan.features) {
          console.log(`    ${chalk.dim('•')} ${f}`);
        }
        console.log('');
      }
      console.log(chalk.dim('  Upgrade: echo upgrade <plan>'));
      console.log(chalk.dim('  Details: https://echo-ept.com/sdk/pricing'));
      console.log('');
    } catch (err) {
      spinner.fail();
      printError(err instanceof Error ? err.message : 'Failed to load plans');
    }
  });

// ─── UPGRADE — Create checkout session ─────────────────────────────────
program
  .command('upgrade')
  .description('Upgrade your plan (opens browser for payment)')
  .argument('<plan>', 'Plan to upgrade to: starter, pro, enterprise')
  .option('-p, --provider <provider>', 'Payment provider: stripe or paypal', 'stripe')
  .option('-i, --interval <interval>', 'Billing interval: monthly or annual', 'monthly')
  .action(async (plan: string, opts: { provider: string; interval: string }) => {
    const key = getApiKey();
    if (!key) {
      printError('Not logged in. Run: echo signup <email> or echo login <key>');
      process.exit(1);
    }

    const spinner = ora(`Creating ${opts.provider} checkout for ${plan} plan...`).start();
    try {
      const client = getClient();
      const whoami = await client.authWhoami() as { tenant_id: string };

      const baseUrl = program.opts().gateway || 'https://echo-sdk-gateway.bmcii1976.workers.dev';
      const resp = await fetch(`${baseUrl}/auth/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: whoami.tenant_id,
          plan,
          interval: opts.interval,
          provider: opts.provider,
        }),
      });
      const json = await resp.json() as { success: boolean; data?: { checkout_url: string; amount_cents: number }; error?: { message: string } };
      spinner.stop();

      if (!json.success) {
        printError(json.error?.message || 'Checkout failed');
        process.exit(1);
      }

      const amount = (json.data!.amount_cents / 100).toFixed(2);
      console.log('');
      printSuccess(`Checkout ready — $${amount}/${opts.interval}`);
      console.log('');
      console.log(chalk.bold('  Open this URL to complete payment:'));
      console.log(`  ${chalk.underline.cyan(json.data!.checkout_url)}`);
      console.log('');
      console.log(chalk.dim('  Your plan will upgrade automatically after payment.'));
      console.log('');
    } catch (err) {
      spinner.fail();
      printError(err instanceof Error ? err.message : 'Checkout failed');
      process.exit(1);
    }
  });

// ─── USAGE — Show current usage stats ──────────────────────────────────
program
  .command('usage')
  .description('Show your API usage stats')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Fetching usage stats', async () => {
      return client.request('/auth/usage');
    }, opts);
  });

// ─── WHOAMI ────────────────────────────────────────────────────────────
program
  .command('whoami')
  .description('Show your current identity and plan')
  .action(async () => {
    const opts = program.opts();
    const client = getClient(opts);
    await run('Checking identity', async () => {
      return client.authWhoami();
    }, opts);
  });

// ─── PARSE & EXECUTE ───────────────────────────────────────────────────
program.parse();

// If no command provided, show help
if (!process.argv.slice(2).length) {
  printHeader(`Echo Prime CLI v${VERSION}`);
  console.log(chalk.dim('  The sovereign intelligence platform\n'));
  program.outputHelp();
}
