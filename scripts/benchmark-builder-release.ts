/** Workspace-only synthetic dependency-volume benchmark. No production/config access. */
import { constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, openSync, closeSync, ftruncateSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DependencyCache, dependencyKey } from '../packages/backend/src/services/builder-release-dependencies.js';
import { copyReleaseTree, identityDigest } from '../packages/backend/src/services/builder-deployment.js';
const root=mkdtempSync(join(process.cwd(),'.release-benchmark-'));
const cleanup = () => rmSync(root,{recursive:true,force:true});
process.once('SIGTERM', () => { cleanup(); process.exit(143); });
process.once('SIGINT', () => { cleanup(); process.exit(130); });
const phases: Record<string,number>={};
const timed=<T>(name:string,action:()=>T):T=>{const start=performance.now();try{return action();}finally{phases[name]=performance.now()-start;}};
function legacy(source:string,target:string) {
 const st=lstatSync(source);
 if(st.isDirectory()){mkdirSync(target,{recursive:true});for(const name of readdirSync(source))legacy(join(source,name),join(target,name));}
 else {mkdirSync(dirname(target),{recursive:true});writeFileSync(target,readFileSync(source),{mode:st.mode&0o111?0o755:0o644,flag:'wx'});}
}
try {
 const stage=join(root,'stage');mkdirSync(stage);mkdirSync(join(stage,'node_modules'));
 // At most five simultaneous trees, each < 49 MiB: < 256 MiB even
 // if every sparse/reflink copy falls back to a fully allocated ordinary copy.
 let bytes=0;
 timed('fixture-generation',()=>{
  for(let i=0;i<3;i++){
   const fd=openSync(join(stage,'node_modules',`bulk-${i}`),'wx',0o644);
   try { ftruncateSync(fd,16*1024*1024); } finally { closeSync(fd); }
   bytes+=16*1024*1024;
  }
  for(let i=0;i<1000;i++){const content=`module.exports=${i};\n`;writeFileSync(join(stage,'node_modules',`small-${i}.js`),content);bytes+=Buffer.byteLength(content);}
 });
 if (5*bytes >= 256*1024*1024) throw Error('Benchmark fixture budget exceeded');
 let reflink=false;try{copyFileSync(join(stage,'node_modules/bulk-0'),join(root,'probe'),constants.COPYFILE_FICLONE_FORCE);reflink=true;}catch{}finally{rmSync(join(root,'probe'),{force:true});}
 timed('legacy-tree-copy',()=>legacy(stage,join(root,'legacy')));rmSync(join(root,'legacy'),{recursive:true});
 const cache=new DependencyCache(join(root,'cache'),copyReleaseTree),key=dependencyKey([['package-lock.json','unchanged-fixture-lock'],['package.json','unchanged-fixture-manifest']],[]);
 timed('cache-publish',()=>cache.publish(key,stage));
 if (process.argv.includes('--fail-after-publish')) throw Error('Injected benchmark failure for cleanup verification');
 const next=join(root,'next');mkdirSync(next);
 timed('cache-verify-and-restore',()=>cache.restore(key,next,{uid:process.getuid!(),gid:process.getgid!()}));
 const sealed=join(root,'sealed');timed('seal-clone',()=>copyReleaseTree(next,sealed));
 const digest=timed('seal-hash',()=>identityDigest(sealed,['node_modules']));
 rmSync(next,{recursive:true});rmSync(stage,{recursive:true});
 const live=join(root,'live');copyReleaseTree(sealed,live);
 timed('deploy-preflight-hashes',()=>{if(identityDigest(sealed,['node_modules'])!==digest||identityDigest(live,['node_modules'])!==digest)throw Error('seal mismatch');});
 const previous=join(root,'previous');timed('deploy-backup-clone',()=>copyReleaseTree(live,previous));
 timed('deploy-backup-hash',()=>{if(identityDigest(previous,['node_modules'])!==digest)throw Error('backup mismatch');});
 const promotion=join(root,'promotion');timed('deploy-promotion-clone',()=>copyReleaseTree(sealed,promotion));
 rmSync(live,{recursive:true});
 timed('deploy-current-hash',()=>{if(identityDigest(promotion,['node_modules'])!==digest)throw Error('promotion mismatch');});
 rmSync(promotion,{recursive:true});
 timed('rollback-clone',()=>copyReleaseTree(previous,live));
 cleanup();
 console.log(JSON.stringify({schemaVersion:1,synthetic:true,requiresRealReleaseCanary:true,fixture:'3 sparse 16 MiB files + 1000 small files; unchanged lock/manifests',maxSimultaneousTrees:5,maxLogicalBytes:5*bytes,bytes,files:1003,reflink,phasesMs:phases,warmDependencyAndSealMs:phases['cache-verify-and-restore']+phases['seal-clone']+phases['seal-hash'],deployFilesystemMs:Object.entries(phases).filter(([k])=>k.startsWith('deploy-')).reduce((sum,[,n])=>sum+n,0),excludes:'npm ci, application checks/tests/build, Git, database, PM2 and health stability waits; not an end-to-end production claim'},null,2));
}finally{cleanup();}
