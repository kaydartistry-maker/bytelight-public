import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releasePrivateMasks, releaseSandboxArgs, releaseIO, type ReleaseConfig } from './builder-deployment.js';
const config = (root = '/var/lib/release-fixture'): ReleaseConfig => ({
  prod:'/root/app', state:join(root,'state'), backup:join(root,'backup'),
  builder:{root:join(root,'builder/jobs'),workRoot:'/srv/jobs',source:'/srv/source',home:'/srv/home'},
  build:{uid:65534,gid:65534},
} as ReleaseConfig);
test('private masks use Builder parent, collapse nested paths and precede stage bind', () => {
  const cfg=config(); cfg.backup=cfg.state; cfg.builder.home='/srv/jobs/home';
  assert.deepEqual(releasePrivateMasks(cfg), ['/root','/srv/jobs','/srv/source','/var/lib/release-fixture/builder','/var/lib/release-fixture/state']);
  const args=releaseSandboxArgs('/usr/bin/true', [], '/srv/stage', cfg);
  assert.ok(args.indexOf('/var/lib/release-fixture/builder') < args.indexOf('--bind'));
  assert.ok(!args.includes(cfg.builder.root));
  assert.ok(args.includes('/etc/resolv.conf'));
});
test('malformed or dangerously broad masks fail closed', () => {
  for (const path of ['relative','/','/var','/srv','/var/..','/srv/../var','/bad\npath']) {
    const cfg=config(); cfg.state=path; assert.throws(()=>releasePrivateMasks(cfg), /Unsafe/);
  }
  for (const path of ['/var/jobs','/srv/jobs','/jobs','relative']) {
    const cfg=config();cfg.builder.root=path;assert.throws(()=>releasePrivateMasks(cfg), /Unsafe/);
  }
});
test('real Bubblewrap masks root-private Builder parent for unprivileged release build', t => {
  if (process.getuid?.() !== 0) return t.skip('requires root to create private-parent fixture and drop build uid');
  if (!existsSync('/usr/bin/bwrap')) return t.skip('Bubblewrap unavailable');
  const identity={uid:65534,gid:65534};
  try { execFileSync('/usr/bin/bwrap',['--ro-bind','/','/','--','/usr/bin/true'],{...identity,stdio:'pipe'}); }
  catch(error) { return t.skip(`unprivileged Bubblewrap/user namespaces unavailable: ${String(error)}`); }
  const root=mkdtempSync(join(process.env.TMPDIR || process.cwd(), 'release-mask-test-')); chmodSync(root,0o755);
  try {
    const cfg=config(root);cfg.prod=join(root,'prod');cfg.builder.workRoot=join(root,'work');cfg.builder.source=join(root,'source');cfg.builder.home=join(root,'home');
    const parent=join(root,'builder'), stage=join(root,'stage'), sentinel=join(parent,'sentinel');
    mkdirSync(parent,{mode:0o700});mkdirSync(cfg.builder.root,{mode:0o700});writeFileSync(sentinel,'private');
    mkdirSync(stage);chownSync(stage,identity.uid,identity.gid);
    for(const path of [cfg.prod,cfg.state,cfg.backup,cfg.builder.workRoot,cfg.builder.source,cfg.builder.home])mkdirSync(path);
    const fixed=releaseSandboxArgs('/usr/bin/true',[],stage,cfg);
    const old=[...fixed];old[old.indexOf(parent)]=cfg.builder.root;
    assert.throws(()=>execFileSync('/usr/bin/bwrap',old,{...identity,stdio:'pipe'}), /Permission denied/);
    // Exercise the actual build IO, including identity drop and generated arguments.
    releaseIO.build('/usr/bin/true',[],stage,cfg);
    releaseIO.build('/bin/sh',['-c','test ! -e "$1" && test ! -e "$2"','fixture',sentinel,cfg.builder.root],stage,cfg);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
