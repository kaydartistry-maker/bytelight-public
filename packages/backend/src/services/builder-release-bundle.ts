/** A coder-created Git bundle crosses the private release boundary without upload-pack. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chownSync, chmodSync, closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { execution, safeEnv } from './code-patch.js';
import type { BuilderConfig } from './builder-jobs.js';

export interface BundleIdentity { commit: string; tree: string; }
export type BundleGit = (cwd: string, args: string[], identity?: { uid: number; gid: number }) => Buffer;
export const bundleGit: BundleGit = (cwd, args, identity) => {
  const command = execution('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', ...args], identity);
  return execFileSync(command.file, command.args, { cwd, env: { ...safeEnv('/nonexistent'), GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0' }, timeout:60_000, maxBuffer:4*1024*1024, stdio:['ignore','pipe','pipe'] });
};
function syncDirectory(path: string): void { const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);} }
function present(path: string): boolean { try { lstatSync(path);return true; } catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return false;throw error; } }
function privateHome(config: BuilderConfig): void {
  const home=config.home;
  if (!isAbsolute(home) || /[\x00-\x1f\x7f\\]/.test(home) || resolve(home)!==home || home==='/' || realpathSync(home)!==home) throw new Error('Unsafe bundle temporary home');
  let cursor=home;
  while(cursor!=='/') { if(!lstatSync(cursor).isDirectory() || lstatSync(cursor).isSymbolicLink()) throw new Error('Unsafe bundle temporary ancestor');cursor=dirname(cursor); }
  const st=lstatSync(home);
  if(st.uid!==config.uid || st.gid!==config.gid || st.mode&0o077) throw new Error('Bundle temporary home must be private and coder-owned');
  const command=execution('/usr/bin/test',['-x',home],config);
  execFileSync(command.file,command.args,{env:safeEnv('/nonexistent'),stdio:'pipe'});
}
function assertHead(workspace: string, branch: string, plan: BundleIdentity, cfg: BuilderConfig, git: BundleGit): void {
  const text=(args:string[])=>git(workspace,args,cfg).toString().trim();
  if(text(['symbolic-ref','--short','HEAD'])!==branch || text(['rev-parse','HEAD^{commit}'])!==plan.commit || text(['rev-parse','HEAD^{tree}'])!==plan.tree || text(['status','--porcelain','--untracked-files=all'])) throw new Error('Builder ref/tree drift during bundle sealing');
}
/** Root validates a complete standalone bundle in a disposable, root-private bare repository. */
export function verifyReleaseBundle(dir: string, plan: BundleIdentity, expected: unknown, git: BundleGit = bundleGit): string {
  if(typeof expected!=='string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Missing sealed source bundle; reprepare this release');
  const path=join(dir,'source.bundle'), fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let digest:string;
  try {
    const st=fstatSync(fd);
    if(!st.isFile() || st.nlink!==1 || st.uid!==process.getuid?.() || (st.mode&0o777)!==0o600) throw new Error('Unsafe sealed source bundle');
    digest=createHash('sha256').update(readFileSync(fd)).digest('hex');
  } finally {closeSync(fd);}
  if(digest!==expected) throw new Error('Sealed source bundle hash mismatch');
  const heads=git(dir,['bundle','list-heads',path]).toString().trim();
  if(heads!==`${plan.commit} HEAD`) throw new Error('Sealed source bundle HEAD mismatch');
  const check=mkdtempSync(join(dir,'.bundle-check-'));
  try {
    git(dir,['-c','init.templateDir=','init','--bare',check]);
    git(check,['bundle','verify',path]);
    git(check,['fetch','--no-tags','--no-write-fetch-head',path,'HEAD:refs/heads/verified']);
    if(git(check,['rev-parse','refs/heads/verified^{commit}']).toString().trim()!==plan.commit || git(check,['rev-parse','refs/heads/verified^{tree}']).toString().trim()!==plan.tree) throw new Error('Sealed source bundle tree mismatch');
  } finally {rmSync(check,{recursive:true,force:true});}
  return digest;
}
export function sealReleaseBundle(dir: string, workspace: string, branch: string, plan: BundleIdentity, cfg: BuilderConfig, git: BundleGit = bundleGit): string {
  privateHome(cfg);
  if(workspace===cfg.home || cfg.home.startsWith(workspace+'/')) throw new Error('Bundle temporary home must be outside workspace');
  const target=join(dir,'source.bundle');
  if(present(target)) throw new Error('Retained source bundle collision; reprepare this release');
  assertHead(workspace,branch,plan,cfg,git);
  const temp=mkdtempSync(join(cfg.home,'.release-bundle-')), identity=lstatSync(temp), pending=join(dir,`.source.bundle-${identity.ino}.tmp`);
  let taken=false, pendingCreated=false;
  try {
    chownSync(temp,cfg.uid,cfg.gid);chmodSync(temp,0o700);
    // HEAD is a named ref: a raw object id can yield an empty bundle advertisement.
    git(workspace,['bundle','create',join(temp,'source.bundle'),'HEAD'],cfg);
    assertHead(workspace,branch,plan,cfg,git);
    const current=lstatSync(temp);
    if(current.isSymbolicLink() || current.dev!==identity.dev || current.ino!==identity.ino) throw new Error('Bundle temporary directory changed');
    chownSync(temp,process.getuid!(),process.getgid!());chmodSync(temp,0o700);taken=true;
    const input=openSync(join(temp,'source.bundle'),constants.O_RDONLY|constants.O_NOFOLLOW);
    let bytes:Buffer;
    try {
      const st=fstatSync(input);
      if(!st.isFile() || st.nlink!==1 || st.uid!==cfg.uid || st.gid!==cfg.gid) throw new Error('Unsafe coder bundle');
      fchownSync(input,process.getuid!(),process.getgid!());fchmodSync(input,0o600);fsyncSync(input);bytes=readFileSync(input);
    } finally {closeSync(input);}
    const output=openSync(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    pendingCreated=true;
    try {writeFileSync(output,bytes);fsyncSync(output);} finally {closeSync(output);}
    // link is atomic and refuses all existing targets, including dangling symlinks.
    linkSync(pending,target);rmSync(pending);pendingCreated=false;syncDirectory(dir);
    const digest=createHash('sha256').update(bytes).digest('hex');
    verifyReleaseBundle(dir,plan,digest,git);
    return digest;
  } finally {
    // Only remove the directory we created. SIGKILL may retain a private random
    // temp directory; it is never reused by another preparation.
    if(pendingCreated) rmSync(pending,{force:true});
    const current=present(temp)?lstatSync(temp):undefined;
    if(current && current.dev===identity.dev && current.ino===identity.ino && !current.isSymbolicLink()) {
      if(!taken) {chownSync(temp,process.getuid!(),process.getgid!());chmodSync(temp,0o700);}
      rmSync(temp,{recursive:true,force:true});syncDirectory(cfg.home);
    }
  }
}
