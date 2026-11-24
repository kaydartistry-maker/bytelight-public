import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chownSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bundleGit, sealReleaseBundle, verifyReleaseBundle, type BundleGit } from './builder-release-bundle.js';
import type { BuilderConfig } from './builder-jobs.js';
const digest=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(uid=process.getuid!(),gid=process.getgid!()) {
  const root=mkdtempSync(join(process.env.TMPDIR || process.cwd(), 'bundle-test-'));chmodSync(root,0o755);
  const home=join(root,'home'), seed=join(root,'seed'), source=join(root,'source.git'), workspace=join(root,'workspace'), release=join(root,'release'), production=join(root,'prod');
  for(const path of [home,seed,source,workspace]) {mkdirSync(path,{mode:0o700});chownSync(path,uid,gid);}
  for(const path of [release,production]) mkdirSync(path,{mode:0o700});
  const cfg={home,source,uid,gid} as BuilderConfig;
  const git=(cwd:string,args:string[])=>bundleGit(cwd,args,cfg).toString().trim();
  git(seed,['-c','init.templateDir=','init','-b','main']);
  writeFileSync(join(seed,'tracked.txt'),'exact bytes\n');chownSync(join(seed,'tracked.txt'),uid,gid);
  git(seed,['add','.']);git(seed,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','target']);
  git(root,['clone','--bare',seed,source]);git(source,['worktree','add',workspace,'main']);
  const plan={commit:git(workspace,['rev-parse','HEAD']),tree:git(workspace,['rev-parse','HEAD^{tree}'])};
  const seal=(run:BundleGit=bundleGit)=>sealReleaseBundle(release,workspace,'main',plan,cfg,run);
  return {root,home,seed,source,workspace,release,production,cfg,plan,git,seal,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('sealed bundle pins HEAD/tree/hash, imports standalone and leaves workspace clean',()=>{
  const f=fixture();try {
    const sha=f.seal();assert.equal(sha,digest(join(f.release,'source.bundle')));
    assert.equal(verifyReleaseBundle(f.release,f.plan,sha),sha);
    assert.equal(lstatSync(join(f.release,'source.bundle')).mode&0o777,0o600);
    assert.equal(f.git(f.workspace,['status','--porcelain','--untracked-files=all']),'');assert.deepEqual(readdirSync(f.home),[]);
    bundleGit(f.production,['-c','init.templateDir=','init']);
    bundleGit(f.production,['fetch','--no-tags',join(f.release,'source.bundle'),'HEAD']);
    assert.equal(bundleGit(f.production,['rev-parse','FETCH_HEAD^{tree}']).toString().trim(),f.plan.tree);
  } finally {f.cleanup();}
});
test('missing, tampered, wrong hash/head/tree, and symlink bundles are refused',()=>{
  const f=fixture();try {
    assert.throws(()=>verifyReleaseBundle(f.release,f.plan,undefined),/reprepare/);
    assert.throws(()=>verifyReleaseBundle(f.release,f.plan,'0'.repeat(64)),/ENOENT/);
    const sha=f.seal(),path=join(f.release,'source.bundle');
    assert.throws(()=>verifyReleaseBundle(f.release,f.plan,'0'.repeat(64)),/hash mismatch/);
    assert.throws(()=>verifyReleaseBundle(f.release,{...f.plan,commit:'0'.repeat(40)},sha),/HEAD mismatch/);
    assert.throws(()=>verifyReleaseBundle(f.release,{...f.plan,tree:'0'.repeat(40)},sha),/tree mismatch/);
    rmSync(path);bundleGit(f.workspace,['bundle','create',path,'refs/heads/main']);chmodSync(path,0o600);
    assert.throws(()=>verifyReleaseBundle(f.release,f.plan,digest(path)),/HEAD mismatch/);
    writeFileSync(path,'tampered');assert.throws(()=>verifyReleaseBundle(f.release,f.plan,sha),/hash mismatch/);
    rmSync(path);symlinkSync(join(f.seed,'tracked.txt'),path);assert.throws(()=>verifyReleaseBundle(f.release,f.plan,sha),/ELOOP/);
    assert.throws(()=>f.seal(),/collision/);assert.deepEqual(readdirSync(f.home),[]);
  } finally {f.cleanup();}
});
test('interruption, coder symlink output, temp collision and ref drift clean only owned temporary state',()=>{
  for(const kind of ['interrupt','symlink','collision','drift']) {
    const f=fixture();try {
      const run:BundleGit=(cwd,args,id)=>{
        if(args[0]==='bundle'&&args[1]==='create') {
          const output=args[2],temp=dirname(output);
          if(kind==='interrupt') throw Error('interrupted');
          if(kind==='symlink') {symlinkSync(join(f.seed,'tracked.txt'),output);return Buffer.alloc(0);}
          if(kind==='collision') symlinkSync(join(f.seed,'tracked.txt'),join(f.release,`.source.bundle-${lstatSync(temp).ino}.tmp`));
          const result=bundleGit(cwd,args,id);
          if(kind==='drift') f.git(f.workspace,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--allow-empty','-m','drift']);
          return result;
        }
        return bundleGit(cwd,args,id);
      };
      assert.throws(()=>f.seal(run),kind==='interrupt'?/interrupted/:kind==='symlink'?/ELOOP/:kind==='collision'?/EEXIST/:/drift/);
      assert.deepEqual(readdirSync(f.home),[]);assert.equal(readFileSync(join(f.seed,'tracked.txt'),'utf8'),'exact bytes\n');
      assert.ok(!existsSync(join(f.release,'source.bundle')));
      if(kind==='collision') assert.equal(readdirSync(f.release).length,1,'existing collision is preserved');
    } finally {f.cleanup();}
  }
});
test('private temporary home rejects symlink/ownership/traversal without changing modes',()=>{
  const f=fixture();try {
    const original=f.cfg.home;f.cfg.home=join(f.root,'alias');symlinkSync(original,f.cfg.home);assert.throws(()=>f.seal(),/Unsafe/);
    f.cfg.home=original;
    if(process.getuid?.()===0){chownSync(original,65534,65534);assert.throws(()=>f.seal(),/private and coder-owned/);chownSync(original,f.cfg.uid,f.cfg.gid);}
    chmodSync(original,0o755);assert.throws(()=>f.seal(),/private and coder-owned/);assert.equal(lstatSync(original).mode&0o777,0o755);
  } finally {f.cleanup();}
});
test('real root/coder linked worktree: old local fetch fails dubious ownership; sealed bundle imports',t=>{
  if(process.getuid?.()!==0) return t.skip('requires root and the existing coder UID/GID');
  const f=fixture(995,986);try {
    bundleGit(f.production,['-c','init.templateDir=','init']);
    assert.throws(()=>bundleGit(f.production,['fetch','--no-tags',f.workspace,f.plan.commit]),/dubious ownership/);
    const sha=f.seal();verifyReleaseBundle(f.release,f.plan,sha);
    bundleGit(f.production,['fetch','--no-tags',join(f.release,'source.bundle'),'HEAD']);
    assert.equal(bundleGit(f.production,['rev-parse','FETCH_HEAD']).toString().trim(),f.plan.commit);
    assert.equal(f.git(f.workspace,['status','--porcelain','--untracked-files=all']),'');
    assert.deepEqual(readdirSync(f.home),[]);
    chmodSync(f.root,0o700);assert.throws(()=>f.seal(),/Command failed/);chmodSync(f.root,0o755);
  } finally {f.cleanup();}
});
