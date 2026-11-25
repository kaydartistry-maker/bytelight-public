#!/usr/bin/env node

// bytelight Setup Wizard — Interactive first-time configuration
// Usage: node scripts/setup.mjs

import { createInterface } from 'readline';
import { writeFileSync, existsSync, copyFileSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { isValidTimezone, trustedDetectedTimezone, processNameFor, joinNames } from './setup-helpers.mjs';

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

  // 5. Check Claude Code is available
  console.log('\n  bytelight uses Claude Code Agent SDK — no API key needed.');
  console.log('  Make sure you\'re logged into Claude Code: claude login');

  // Write bytelight.yaml
  const yamlContent = `identity:
  companion_name: "${companionName}"
  user_name: "${userName}"
  timezone: "${timezone}"
  # The house's own brain: every companion below runs on it.
  local_brain_id: "${processName}"
  # Who lives here. Each name moves in as a companion on first start.
  residents:
${residentNames.map((n) => `    - name: "${n}"`).join('\n')}

server:
  port: 3002
  host: "127.0.0.1"
  db_path: "./data/bytelight.db"

auth:
  password: "${password}"

agent:
  cwd: "."
  claude_md_path: "./CLAUDE.md"
  mcp_json_path: "./.mcp.json"
  model: "claude-sonnet-4-6"
  model_autonomous: "claude-sonnet-4-6"

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
`;

  writeFileSync('bytelight.yaml', yamlContent);
  console.log('\n  Created: bytelight.yaml');

  // Write .env if not exists
  if (!existsSync('.env')) {
    let envContent = '# bytelight Environment\n# No API key needed — uses Claude Code Agent SDK auth\n';
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
  console.log(`
  Setup complete!

  Authentication:
    bytelight uses Claude Code Agent SDK. No API key needed.
    Your companion runs queries through your Claude Code subscription.
    Make sure you're logged in: claude login

  Next steps:
  1. Customize CLAUDE.md — this is your companion's personality
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
