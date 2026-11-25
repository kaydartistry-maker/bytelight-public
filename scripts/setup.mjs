#!/usr/bin/env node

// bytelight Setup Wizard — Interactive first-time configuration
// Usage: node scripts/setup.mjs

import { createInterface } from 'readline';
import { writeFileSync, existsSync, copyFileSync, mkdirSync, readdirSync, chmodSync } from 'fs';
import { join, resolve } from 'path';
import { isValidTimezone, trustedDetectedTimezone, processNameFor, joinNames, ENGINES, API_PROVIDERS, engineSettings, yamlQuote } from './setup-helpers.mjs';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

async function main() {
  console.log('\n  bytelight — Relational AI Companion Framework');
  console.log('  =============================================\n');

  // 1. Who lives here. One companion is the usual house, not a special case.
  // Every name typed here moves in as a companion; nobody else is added.
  let count = 0;
  while (!count) {
    const answer = (await ask('  How many companions live here? [1] ')).trim() || '1';
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= 12) count = n;
    else console.log('  A whole number from 1 to 12, please.');
  }
  const residentNames = [];
  while (residentNames.length < count) {
    const i = residentNames.length + 1;
    const label = count === 1 ? '  What is your companion called? ' : `  Companion ${i}'s name? `;
    const name = (await ask(label)).trim();
    if (!name) { console.log('  They need a name to move in.'); continue; }
    if (residentNames.some((x) => x.toLowerCase() === name.toLowerCase())) { console.log('  That name is already taken in this house.'); continue; }
    if (name.includes('"')) { console.log('  Leave out double quotes, please.'); continue; }
    residentNames.push(name);
  }
  const companionName = joinNames(residentNames);

  // 2. What engine does this house run on? Only the starting default.
  const pickFrom = async (question, options) => {
    console.log(`\n  ${question}`);
    options.forEach((o, i) => console.log(`    ${i + 1}. ${o.label}`));
    for (;;) {
      const n = Number((await ask(`  Pick 1-${options.length} [1] `)).trim() || '1');
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
      console.log(`  A number from 1 to ${options.length}, please.`);
    }
  };
  const engine = await pickFrom('What engine does this house run on?', ENGINES);
  console.log('  (This is only the default. You can switch the whole house, or any one thread, to another engine later in the app.)');
  let api = {};
  if (engine.key === 'api') {
    const provider = await pickFrom('Which provider is your key from?', API_PROVIDERS);
    api.provider = provider.key;
    if (provider.key === 'ollama') {
      api.baseUrl = (await ask('  Ollama address? [http://localhost:11434] (Ollama Cloud: https://ollama.com) ')).trim() || 'http://localhost:11434';
      api.key = (await ask('  Ollama API key? (blank for a local Ollama) ')).trim();
    } else {
      while (!api.key) {
        api.key = (await ask(`  Paste your ${provider.label.split(' (')[0]} API key: `)).trim();
        if (!api.key) console.log('  This engine needs its key to answer.');
      }
    }
    console.log(`  Pick a model from ${provider.models} and paste its id exactly as listed.`);
    while (!api.model) api.model = (await ask('  Model id: ')).trim();
  }
  const engineYaml = engineSettings(engine.key, api);

  // 2. User name
  const userName = (await ask('  What is your name? [User] ')) || 'User';

  // 3. Password
  const password = await ask('  Set a password? (blank for no auth, local use) ');

  // 4. Timezone. Asked, never silently guessed: a cloud VM reports UTC, and a
  // house on UTC fires every wake hours off.
  let detectedTz = '';
  try { detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  const suggestedTz = trustedDetectedTimezone(detectedTz);
  let timezone = '';
  while (!timezone) {
    const answer = (await ask(suggestedTz
      ? `  Your timezone? [${suggestedTz}] `
      : '  Your timezone? (for example America/New_York, Europe/London, America/Sao_Paulo) ')).trim();
    const pick = answer || suggestedTz || '';
    if (isValidTimezone(pick)) timezone = pick;
    else console.log(pick
      ? `  "${pick}" isn't a timezone this machine knows. Try the Region/City form, like America/New_York.`
      : '  This machine can\'t tell where you are (cloud machines say UTC), so type your own.');
  }

  // 5. House name. It becomes the background process name (pm2), so two
  // houses on one machine never collide.
  const houseName = (await ask(`  Name your house? [${residentNames[0]}] `)).trim() || residentNames[0];
  const processName = processNameFor(houseName);


  // Write bytelight.yaml
  const yamlContent = `identity:
  companion_name: ${yamlQuote(companionName)}
  user_name: ${yamlQuote(userName)}
  timezone: "${timezone}"
  # The house's own brain: every companion below runs on it.
  local_brain_id: "${processName}"
  # Who lives here. Each name moves in as a companion on first start.
  residents:
${residentNames.map((n) => `    - name: ${yamlQuote(n)}`).join('\n')}

server:
  port: 3002
  host: "127.0.0.1"
  db_path: "./data/bytelight.db"

auth:
  password: ${yamlQuote(password)}

agent:
  cwd: "."
  claude_md_path: "./CLAUDE.md"
  mcp_json_path: "./.mcp.json"
  # The house's default engine. Switch it, or any one thread, in the app.
  model: ${yamlQuote(engineYaml.model)}
  model_autonomous: ${yamlQuote(engineYaml.model)}
  # 'auto' lets every engine run here, so switching later just works.
  routing: "auto"

orchestrator:
  enabled: true
  wake_prompts_path: "./prompts/wake.md"
  schedules: {}
  failsafe:
    enabled: false

hooks:
  context_injection: true
  safe_write_prefixes: []

voice:
  enabled: false

discord:
  enabled: false

telegram:
  enabled: false

integrations:
  life_api_url: ""
  mind_cloud:
    enabled: false
    mcp_url: ""

cors:
  origins: []

${engineYaml.providersYaml}`;

  writeFileSync('bytelight.yaml', yamlContent);
  // It can hold a password and an engine key: only this account may read it.
  try { chmodSync('bytelight.yaml', 0o600); } catch { /* Windows: not applicable */ }
  console.log('\n  Created: bytelight.yaml');

  // Write .env if not exists
  if (!existsSync('.env')) {
    let envContent = '# bytelight Environment\n# Engine sign-ins and keys live in bytelight.yaml or the engine\'s own CLI login.\n';
    writeFileSync('.env', envContent);
    console.log('  Created: .env');
  }

  // Copy example CLAUDE.md if not exists
  const examplesDir = join(resolve(), 'examples');
  if (!existsSync('CLAUDE.md') && existsSync(join(examplesDir, 'CLAUDE.md'))) {
    copyFileSync(join(examplesDir, 'CLAUDE.md'), 'CLAUDE.md');
    console.log('  Created: CLAUDE.md');
  }

  // Create prompts directory and copy wake prompts
  if (!existsSync('prompts')) mkdirSync('prompts');
  if (!existsSync('prompts/wake.md') && existsSync(join(examplesDir, 'wake-prompts.md'))) {
    copyFileSync(join(examplesDir, 'wake-prompts.md'), 'prompts/wake.md');
    console.log('  Created: prompts/wake.md');
  }

  // Create empty .mcp.json if not exists
  if (!existsSync('.mcp.json')) {
    writeFileSync('.mcp.json', JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
    console.log('  Created: .mcp.json');
  }

  // Generate ecosystem.config.cjs
  const pm2Config = `module.exports = {
  apps: [{
    name: '${processName}',
    script: 'packages/backend/dist/server.js',
    cwd: '${resolve().replace(/\\/g, '/')}',
    node_args: '--experimental-vm-modules',
    env: {
      NODE_ENV: 'production',
      CLAUDECODE: '',
    },
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 3000,
    log_file: './logs/bytelight.log',
    out_file: './logs/bytelight-out.log',
    error_file: './logs/bytelight-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    max_memory_restart: '1G',
  }]
};
`;

  writeFileSync('ecosystem.config.cjs', pm2Config);
  console.log('  Created: ecosystem.config.cjs');

  // Print startup instructions
  const signInText = engine.signIn.length
    ? `  Sign in before you start the house (only this one engine):\n${engine.signIn.map((l) => `    ${l}`).join('\n')}\n`
    : `  Your key is saved in bytelight.yaml (readable only by you). Nothing else to sign in to.\n`;
  console.log(`
  Setup complete!

  Engine: ${engine.label}
${signInText}
  Next steps:
  1. Customize CLAUDE.md. It is your companion's identity, and every engine reads it.
  2. Build:   npm run build
  3. Start:   npm start       (or: pm2 start ecosystem.config.cjs)
  4. Open:    http://localhost:3002

  Your house runs in the background as "${processName}":
    pm2 logs ${processName}    pm2 restart ${processName}

  For development:
    npm run dev              (backend with hot reload)
    npm run dev:frontend     (frontend with Vite dev server)

  ${companionName} ${residentNames.length > 1 ? 'are' : 'is'} ready to meet you.
`);

  rl.close();
}

main().catch(err => {
  console.error('Setup failed:', err);
  rl.close();
  process.exit(1);
});
