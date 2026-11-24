/** Group keeper. Remains alive until the supervisor kills the complete group,
 * including background grandchildren left after Codex exits. No application imports. */
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { specialistSandbox } from './builder-job-io.js';
import { execution, safeEnv } from './code-patch.js';

process.on('SIGTERM', () => { /* Keep group identity pinned until supervisor escalates. */ });
const keepAlive = setInterval(() => {}, 1000);
process.on('message', (raw: unknown) => {
  const request = raw as { args: string[]; cwd: string; commonGit: string; home: string; uid: number; gid: number };
  if (!Array.isArray(request?.args) || !request.uid || !request.gid || !request.home?.startsWith('/')) process.exit(2);
  process.removeAllListeners('message');
  const cmd = execution('/usr/bin/bwrap', specialistSandbox(request), { uid: request.uid, gid: request.gid });
  const child = spawn(cmd.file, cmd.args, { cwd: request.cwd, env: safeEnv(request.home), stdio: ['ignore', 'pipe', 'pipe'] });
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
    const decoder = new StringDecoder('utf8');
    stream?.on('data', (data: Buffer) => process.send?.({ type: 'output', stream: name, text: decoder.write(data) }));
    stream?.on('end', () => { const text = decoder.end(); if (text) process.send?.({ type: 'output', stream: name, text }); });
  }
  child.once('error', (error) => process.send?.({ type: 'done', code: 1, error: error.message }));
  child.once('close', (code, signal) => process.send?.({ type: 'done', code, signal }));
});
process.on('disconnect', () => {
  // Parent death: kill our entire group, rather than leaving a builder behind.
  clearInterval(keepAlive); process.kill(-process.pid, 'SIGKILL');
});
