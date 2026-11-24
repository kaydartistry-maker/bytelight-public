import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { releaseIO, additiveSql, assertExpectedRelease, builderReleaseAction, builderReleaseTool, copyReleaseTree, identityDigest, credentialPath, eligible, migrateAdditive, runBuilderRelease, previewBuilderCIAdmission, previewBuilderCIRequest, releaseConfig, type ReleaseConfig, type ReleaseIO } from './builder-deployment.js';
import { ciGates, ciOutputRoots, ciSha, expectedCISource, type CIExpected, type CIPackage } from './builder-release-ci.js';
import { protectedCompiledPaths } from './code-deployment.js';
import { startBuilderJob, assertBuilderBaseline, builderBaselineState, openBuilderStore, reconcileBuilderReleases } from './builder-jobs.js';
import type { BuilderJob, ReleaseRecord } from './db/builder-jobs.js';
import { createHash } from 'node:crypto';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const id = 'a'.repeat(32), releaseId = 'd'.repeat(64);
function fixture(managed = false, realWorkspaces = false) {
  const root = mkdtempSync(join(tmpdir(), 'builder-release-test-'));
  const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  const source = join(root, 'source'), prod = join(root, 'production'), workRoot = join(root, 'jobs'), workspace = join(workRoot, id);
  mkdirSync(source); mkdirSync(workRoot);
  const g = (cwd: string, args: string[]) => execFileSync('/usr/bin/git', ['-c', `safe.directory=${cwd}`, '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: { PATH:process.env.PATH, HOME:root, GIT_CONFIG_NOSYSTEM:'1', GIT_AUTHOR_NAME:'Fixture', GIT_AUTHOR_EMAIL:'fixture@example.test', GIT_COMMITTER_NAME:'Fixture', GIT_COMMITTER_EMAIL:'fixture@example.test' }, stdio:['ignore','pipe','pipe'] });
  g(source, ['init', '-b', 'main']);
  put(join(source, 'package.json'), JSON.stringify({private:true,workspaces:['packages/backend','packages/shared','packages/frontend','packages/phone'],allowScripts:{'better-sqlite3@11.10.0':true}}));
  put(join(source, 'package-lock.json'), JSON.stringify({lockfileVersion:3,packages:{'node_modules/better-sqlite3':{version:'11.10.0',hasInstallScript:true}}}));
  for(const name of ['backend','frontend','shared','phone']) put(join(source, `packages/${name}/package.json`), JSON.stringify({name:`fixture-${name}`}));
  if (realWorkspaces) {
    // Match the repository's four workspace paths and scoped package names;
    // no registry dependencies or lifecycle scripts are needed for this fixture.
    for (const name of ['backend', 'frontend', 'shared', 'phone'])
      put(join(source, `packages/${name}/package.json`), JSON.stringify({ name: `@bytelight/${name}`, version: '1.0.0' }));
    execFileSync('/usr/bin/npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], {
      cwd: source, timeout: 30_000, env: { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, npm_config_cache: join(root, 'npm-cache') },
    });
  }
  put(join(source,'packages/backend/src/app.ts'),'export const value = "old";\n');
  put(join(source,'removed.txt'),'restore me');
  g(source,['add','.']);g(source,['commit','-m','baseline']);
  const base = g(source,['rev-parse','HEAD']).toString().trim();
  let repository = source;
  if (managed) { repository = join(root, 'source.git'); g(root, ['clone', '--bare', source, repository]); g(repository, ['update-ref', 'refs/heads/deployed', base]); g(repository, ['symbolic-ref', 'HEAD', 'refs/heads/deployed']); }
  g(root,['clone',source,prod]);g(repository,['worktree','add','-b','boss/fixture',workspace,base]);
  put(join(workspace,'packages/backend/src/app.ts'),'export const value = "new";\n');
  const commit=()=>{g(workspace,['add','-A']);g(workspace,['commit','-m','builder task']);};commit();
  const state=join(root,'state'), metadata=join(root,'metadata'), staging=join(root,'staging'), backup=join(root,'backups');
  for(const path of [state,metadata,staging,backup]) mkdirSync(path,{mode:0o700});
  const cfg:ReleaseConfig={builder:{root:metadata,workRoot,source:repository,base:managed ? 'deployed' : 'HEAD',production:prod,home:join(root,'home'),uid:process.getuid!(),gid:process.getgid!(),timeoutMs:10000},prod,state,staging,backup,app:'fixture-app',health:'http://127.0.0.1:1/api/health',sqlite:join(prod,'data','app.sqlite'),build:{uid:1002,gid:1002}};
  mkdirSync(cfg.builder.home,{mode:0o700});
  mkdirSync(join(prod,'data')); const db=new Database(cfg.sqlite);db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY, content TEXT); INSERT INTO messages(content) VALUES (\'before\')');db.close();
  for(const path of ['node_modules/old-dependency.txt','packages/backend/dist/app.js','packages/frontend/build/index.html','packages/shared/dist/index.js','packages/phone/dist/index.html'])put(join(prod,path),'old runtime');
  put(join(prod,'.env'),'PRODUCTION_SECRET=retained');
  const store=openBuilderStore(metadata);store.insert({id,ownerThread:'owner',ownerSession:'turn',audience:'owner',task:'fixture task',mode:'edit',workspace,branch:'boss/fixture',baseCommit:base,logPath:join(metadata,'job.jsonl')});store.update(id,{},'running');store.update(id,{},'succeeded');const job=store.get(id)!;store.close();
  const commands:string[]=[];let stopped=false;let failBuild=false;let healthFailures=0;let startedNew=false;let writeAfterStart=false;
  const io:ReleaseIO={git:g,inspect:()=>null,chown:()=>{},pauseHealth:false,
    run(file,args,cwd){commands.push(`${file} ${args.join(' ')}`);
      if(file==='/usr/bin/pm2') {if(args[0]==='jlist')return JSON.stringify([{name:cfg.app,pm_id:0,pid:stopped?0:123,pm2_env:{pm_exec_path:join(prod,'packages/backend/dist/server.js'),pm_cwd:prod,exec_interpreter:'node',status:stopped?'stopped':'online',restart_time:0}}]);if(args[0]==='stop')stopped=true;if(args[0]==='restart'){stopped=false;startedNew=true;if(writeAfterStart){const db=new Database(cfg.sqlite);db.prepare('INSERT INTO messages(content) VALUES (?)').run('later write');db.close();}}return '';}
      if(file==='/usr/bin/sqlite3'){assert.ok(stopped,'database backup must follow app stop');const target=args[1].match(/\.backup '([^']+)'/)![1];copyFileSync(cfg.sqlite,target);return '';}
      if(file==='/usr/bin/git')return g(cwd,args);throw Error(`unexpected effect ${file}`);
    },
    build(file,args,cwd){commands.push(`build ${file} ${args.join(' ')}`);assert.ok(cwd.startsWith(staging+'/'));if(failBuild)throw Error('fixture build failure');if(file==='/usr/bin/tar'){execFileSync(file,args,{cwd});return;}
      if(file==='/usr/bin/env' && args[0]==='node') return 'fixture-node-runtime-1';
      if(file==='/usr/bin/npm' && args[0]==='config') return 'fixture-install-policy-1';
      if(file==='/usr/bin/npm' && args[0]==='--version') return 'fixture-npm-1';
      if (realWorkspaces && args[0] === 'ci') { execFileSync(file, args.concat(['--offline', '--no-audit', '--no-fund']), { cwd, timeout: 30_000, env: { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, npm_config_cache: join(root, 'npm-cache') } }); return; }
      if(args[0]==='ci'){put(join(cwd,'node_modules/new-dependency.txt'),'new dependency');mkdirSync(join(cwd,'node_modules/@fixture'),{recursive:true});symlinkSync('../../packages/backend',join(cwd,'node_modules/@fixture/backend'));put(join(cwd,'packages/backend/node_modules/nested/index.js'),'nested dependency');}
      if(args[0]==='run'&&args[1]==='build'){for(const path of ['packages/backend/dist/app.js','packages/frontend/build/index.html','packages/shared/dist/index.js','packages/phone/dist/index.html'])put(join(cwd,path),'new runtime');}
    },
    async health(){if(startedNew&&healthFailures-->0)throw Error('fixture unhealthy');},
  };
  const request=(operation:'prepare'|'deploy'|'rollback')=>{
    const st=openBuilderStore(metadata);let record=st.deployment(id);const plan=operation==='prepare'?eligible(job,cfg,io):JSON.parse(readFileSync(join(metadata,'deployments',releaseId,'request.json'),'utf8')).plan;
    if(!record){const now=new Date().toISOString();record={id:releaseId,jobId:id,status:'preparing',commit:plan.commit,base:plan.base,tree:plan.tree,phase:'queued',created:now,updated:now};}
    if(operation==='prepare'){record.commit=plan.commit;record.tree=plan.tree;record.base=plan.base;}
    record.status=operation==='prepare'?'preparing':operation==='deploy'?'deploying':'rolling_back';st.saveRelease(record);st.close();
    const dir=join(metadata,'deployments',releaseId);mkdirSync(dir,{recursive:true,mode:0o700});put(join(dir,'request.json'),JSON.stringify({config:cfg,plan,job,operation,bundleSha256:record.bundleSha256,ciImport:record.ciImport}));
    // Requests are owner-only durable files, matching coordinator output.
    execFileSync('/usr/bin/chmod',['600',join(dir,'request.json')]);put(join(state,'deploy.lock'),JSON.stringify({key:releaseId,state:'starting'}));
  };
  const status=()=>{const s=openBuilderStore(metadata);try{return s.deployment(id)!;}finally{s.close();}};
  return {root,cfg,job,io,g,put,commit,request,status,commands,setFailBuild:(v:boolean)=>failBuild=v,setUnhealthy:()=>healthFailures=20,setWrites:()=>writeAfterStart=true,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
function ciFixture(){
 const f=fixture(true),inbox=join(f.cfg.builder.root,'ci-inbox'),entry=join(inbox,f.job.id);mkdirSync(entry,{recursive:true,mode:0o700});
 f.cfg.ci={mode:'verified-ci',inbox,repositoryId:'123',workflowPath:'.github/workflows/validate.yml',workflowCommit:'b'.repeat(40)};
 f.io.inspect=pid=>pid===process.pid?{pid,starttime:'fixture-worker',pgid:process.pid,commandHash:'fixture-worker-hash'}:null;
 const fingerprint={versions:{node:process.versions.node,modules:process.versions.modules},platform:process.platform,arch:process.arch,libc:(process.report.getReport() as {header:{glibcVersionRuntime?:string}}).header.glibcVersionRuntime||'fixture-glibc',binary:'node-binary'};
 const oldBuild=f.io.build,oldRun=f.io.run;
 f.io.build=(file,args,cwd,cfg)=>file==='/usr/bin/env'&&args[0]==='node'?JSON.stringify(fingerprint):oldBuild(file,args,cwd,cfg);
 f.io.run=(file,args,cwd)=>file==='/usr/bin/env'&&args[0]==='node'?JSON.stringify(fingerprint):file==='/usr/bin/npm'&&args[0]==='--version'?'fixture-npm-1':oldRun(file,args,cwd);
 const plan=eligible(f.job,f.cfg,f.io),expected:CIExpected={config:f.cfg.ci,plan,job:f.job,baselineManifest:f.g(f.job.workspace,['show',`${plan.base}:package.json`]),runtime:{node:process.version,modules:process.versions.modules,platform:process.platform,arch:process.arch,glibc:fingerprint.libc,npm:'fixture-npm-1'}};
 const payload:CIPackage={schema:1,roots:ciOutputRoots,source:expectedCISource(expected),runtime:expected.runtime,workflow:{repositoryId:'123',path:'.github/workflows/validate.yml',commit:'b'.repeat(40),runId:'456',runAttempt:1},gates:ciGates,files:[]};
 const add=(path:string,content:string)=>payload.files.push({path,mode:'0644',bytes:Buffer.byteLength(content),sha256:ciSha(content),base64:Buffer.from(content).toString('base64')});
 for(const path of ['packages/backend/dist/app.js','packages/shared/dist/index.js','packages/frontend/build/index.html','packages/phone/dist/index.html'])add(path,'new CI runtime');
 for(const path of protectedCompiledPaths){f.put(join(f.cfg.prod,path),'trusted coordinator');add(path,'trusted coordinator');}
 const publish=()=>{f.put(join(entry,'package.json'),JSON.stringify(payload));f.put(join(entry,'receipt.json'),JSON.stringify({schema:1,jobId:f.job.id,owner:{thread:f.job.ownerThread,session:f.job.ownerSession,audience:'owner'},planSha256:ciSha(JSON.stringify(plan)),source:payload.source,workflow:{...payload.workflow,artifactId:'789',artifactSha256:'f'.repeat(64),packageSha256:ciSha(JSON.stringify(payload))}}));execFileSync('/usr/bin/chmod',['600',join(entry,'package.json'),join(entry,'receipt.json')]);};
 const credentialFile=join(f.cfg.state,'gateway.json');f.put(credentialFile,JSON.stringify({security_key:'fixture',authorization_header:'Basic '+Buffer.from('fixture:fixture').toString('base64')}));execFileSync('/usr/bin/chmod',['600',credentialFile]);
 publish();return {...f,payload,publish,entry,credentialFile};
}
const rootCI={skip:process.getuid?.()!==0?'CI root-coordinator fixture requires root':false};
for(const damage of ['missing','permissions','rotated'] as const)test(`default configuration preserves status/logs/frozen deploy/rollback after CI ${damage}`,rootCI,async()=>{const f=ciFixture();
 const env={BYTELIGHT_BUILDER_DEPLOY_ENABLED:'true',BYTELIGHT_BUILDER_ENABLED:'true',BYTELIGHT_BUILDER_ROOT:f.cfg.builder.root,BYTELIGHT_BUILDER_WORK_ROOT:f.cfg.builder.workRoot,BYTELIGHT_BUILDER_SOURCE:f.cfg.builder.source,BYTELIGHT_BUILDER_BASE:'deployed',BYTELIGHT_CODEX_HOME:f.cfg.builder.home,BYTELIGHT_CODEX_UID:'63001',BYTELIGHT_CODEX_GID:'63001',BYTELIGHT_BUILD_UID:'63002',BYTELIGHT_BUILD_GID:'63002',BYTELIGHT_CODE_PRODUCTION:f.cfg.prod,BYTELIGHT_CODE_STATE_DIR:f.cfg.state,BYTELIGHT_CODE_STAGING_DIR:f.cfg.staging,BYTELIGHT_CODE_BACKUP_DIR:f.cfg.backup,BYTELIGHT_CODE_PM2_APP:f.cfg.app,BYTELIGHT_CODE_HEALTH_URL:f.cfg.health,BYTELIGHT_CODE_SQLITE_PATH:f.cfg.sqlite,BYTELIGHT_BUILDER_PREPARE_MODE:'verified-ci',BYTELIGHT_BUILDER_CI_INBOX:f.cfg.ci?.mode==='verified-ci'?f.cfg.ci.inbox:'',BYTELIGHT_BUILDER_CI_REPOSITORY_ID:'123',BYTELIGHT_BUILDER_CI_WORKFLOW_PATH:'.github/workflows/validate.yml',BYTELIGHT_BUILDER_CI_WORKFLOW_COMMIT:'b'.repeat(40),BYTELIGHT_BUILDER_CI_GATEWAY_URL:'https://api.letta.com/v1/agent-webhooks/opaque-capability',BYTELIGHT_BUILDER_CI_GATEWAY_CREDENTIAL_FILE:f.credentialFile};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
 try{
  f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'prepared',f.status().error);
  // Exercise the real default releaseConfig(), not a prebuilt fixture config.
  chownSync(f.cfg.builder.source,63001,63001);chownSync(f.cfg.builder.home,63001,63001);Object.assign(process.env,env);
  if(damage==='missing'){rmSync(f.credentialFile);rmSync(env.BYTELIGHT_BUILDER_CI_INBOX,{recursive:true});}
  if(damage==='permissions'){chmodSync(f.credentialFile,0o644);chmodSync(env.BYTELIGHT_BUILDER_CI_INBOX,0o755);}
  if(damage==='rotated'){writeFileSync(f.credentialFile,'{"authorization_header":"Bearer rotated"}');process.env.BYTELIGHT_BUILDER_CI_WORKFLOW_COMMIT='bad-current-configuration';}
  assert.throws(()=>releaseConfig(true));assert.equal(releaseConfig().ci,undefined);
  const owner={thread:'owner',session:'turn',audience:'owner'} as const;
  assert.equal((await builderReleaseAction('deploy_status',{id},owner) as {status:string}).status,'prepared');
  assert.ok(Array.isArray((await builderReleaseAction('deploy_logs',{id},owner) as {events:unknown[]}).events));
  let launches=0;const launch=async()=>{launches++;await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);};
  // Existing frozen evidence authorizes deploy independently of current CI files.
  assert.equal((await builderReleaseAction('deploy',{id},owner,undefined,launch) as {status:string}).status,'deployed',f.status().error);
  assert.equal((await builderReleaseAction('deploy_status',{id},owner) as {status:string}).status,'deployed');
  assert.equal((await builderReleaseAction('prepare_deploy',{id},owner) as {status:string}).status,'deployed','idempotent reply needs no new preparation config');
  assert.equal((await builderReleaseAction('rollback',{id},owner,undefined,launch) as {status:string}).status,'rolled_back',f.status().error);assert.equal(launches,2);
  assert.equal(readFileSync(join(f.cfg.prod,'packages/phone/dist/index.html'),'utf8'),'old runtime');
 }finally{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;f.cleanup();}
});
test('verified CI rejects protected source changes explicitly at eligibility',rootCI,()=>{const f=ciFixture();try{
 f.put(join(f.job.workspace,'packages/backend/src/services/agent.ts'),'export const changed = true;');f.commit();
 assert.throws(()=>eligible(f.job,f.cfg,f.io),/Verified CI protected source change requires explicit root maintenance/);
}finally{f.cleanup()}});
for(const uncertain of [false,true])test(`configured CI gateway notifies once after seal, restores dependencies while waiting, and imports evidence (uncertain=${uncertain})`,rootCI,async()=>{const f=ciFixture();try{
 if(f.cfg.ci?.mode!=='verified-ci')throw Error('fixture');f.cfg.ci.gateway={url:'https://api.letta.com/v1/agent-webhooks/opaque-capability',credentialFile:f.credentialFile,timeoutMs:5000};rmSync(f.entry,{recursive:true});let notifications=0,pauses=0;
 f.io.notifyCI=async(_gateway,event)=>{notifications++;assert.deepEqual(event,{jobId:f.job.id,releaseId});assert.ok(f.status().bundleSha256);assert.ok(existsSync(join(f.cfg.builder.root,'deployments',releaseId,'source.bundle')));const snapshot=previewBuilderCIRequest(f.cfg.builder.root,releaseId,f.cfg,f.io) as {status:string;jobId:string;bundle:{path:string;sha256:string};inbox:string};assert.equal(snapshot.status,'preparing');assert.equal(snapshot.jobId,f.job.id);assert.equal(snapshot.bundle.sha256,f.status().bundleSha256);assert.equal(snapshot.inbox,f.cfg.ci?.mode==='verified-ci'?f.cfg.ci.inbox:'');if(uncertain)throw Error('uncertain transport');};
 f.io.ciPause=async()=>{pauses++;assert.ok(f.commands.some(c=>c==='build /usr/bin/npm ci --ignore-scripts'));mkdirSync(f.entry,{mode:0o700});f.publish();};
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'prepared',f.status().error);assert.equal(notifications,1);assert.equal(pauses,1);assert.ok(!f.commands.some(c=>c==='build /usr/bin/npm run test'));
}finally{f.cleanup()}});
test('CI gateway timeout fails without local fallback, live mutation or retained shared lock',rootCI,async()=>{const f=ciFixture();try{
 if(f.cfg.ci?.mode!=='verified-ci')throw Error('fixture');f.cfg.ci.gateway={url:'https://api.letta.com/v1/agent-webhooks/opaque-capability',credentialFile:f.credentialFile,timeoutMs:5000};rmSync(f.entry,{recursive:true});let now=0,notifications=0;f.io.ciNow=()=>now;f.io.notifyCI=async()=>{notifications++;};f.io.ciPause=async()=>{now+=5001;};
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'failed');assert.match(f.status().error!,/Timed out/);assert.equal(notifications,1);assert.ok(!existsSync(join(f.cfg.state,'deploy.lock')));assert.ok(!f.commands.some(c=>c.startsWith('/usr/bin/pm2')||c==='build /usr/bin/npm run test'));
}finally{f.cleanup()}});
test('authoritative terminal CI failure ends waiting immediately without local fallback or application effects',rootCI,async()=>{const f=ciFixture();try{
 if(f.cfg.ci?.mode!=='verified-ci')throw Error('fixture');f.cfg.ci.gateway={url:'https://api.letta.com/v1/agent-webhooks/opaque-capability',credentialFile:f.credentialFile,timeoutMs:5000};rmSync(f.entry,{recursive:true});let polls=0;f.io.notifyCI=async()=>{};f.io.ciPause=async()=>{polls++;const dir=join(f.cfg.builder.root,'ci-inbox','failures');mkdirSync(dir,{mode:0o700});const path=join(dir,releaseId+'.json');writeFileSync(path,JSON.stringify({schema:1,jobId:f.job.id,releaseId,commit:f.payload.source.commit,reason:'ci_failed',runId:'123'}),{mode:0o600});};
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'failed');assert.match(f.status().error!,/terminal failure: ci_failed/);assert.equal(polls,1);assert.ok(!existsSync(join(f.cfg.state,'deploy.lock')));assert.ok(!f.commands.some(c=>c.startsWith('/usr/bin/pm2')||c==='build /usr/bin/npm run test'));
}finally{f.cleanup()}});
test('active CI preview rejects missing worker evidence or tampered sealed source',rootCI,async()=>{for(const kind of ['worker','bundle']){const f=ciFixture();try{
 if(f.cfg.ci?.mode!=='verified-ci')throw Error('fixture');f.cfg.ci.gateway={url:'https://api.letta.com/v1/agent-webhooks/opaque-capability',credentialFile:f.credentialFile,timeoutMs:5000};rmSync(f.entry,{recursive:true});let checked=false;
 f.io.notifyCI=async()=>{if(kind==='worker'){const old=f.io.inspect;f.io.inspect=()=>null;assert.throws(()=>previewBuilderCIRequest(f.cfg.builder.root,releaseId,f.cfg,f.io),/worker identity/);f.io.inspect=old;}else{const path=join(f.cfg.builder.root,'deployments',releaseId,'source.bundle'),bytes=readFileSync(path);writeFileSync(path,'tampered');assert.throws(()=>previewBuilderCIRequest(f.cfg.builder.root,releaseId,f.cfg,f.io),/bundle digest/);writeFileSync(path,bytes);}checked=true;mkdirSync(f.entry,{mode:0o700});f.publish();};
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.ok(checked);assert.equal(f.status().status,'prepared',f.status().error);
}finally{f.cleanup()}}});
test('CI gateway waiting cannot hide production baseline drift',rootCI,async()=>{const f=ciFixture();try{
 if(f.cfg.ci?.mode!=='verified-ci')throw Error('fixture');f.cfg.ci.gateway={url:'https://api.letta.com/v1/agent-webhooks/opaque-capability',credentialFile:f.credentialFile,timeoutMs:5000};rmSync(f.entry,{recursive:true});f.io.notifyCI=async()=>{};f.io.ciPause=async()=>{mkdirSync(f.entry,{mode:0o700});f.publish();f.g(f.cfg.prod,['commit','--allow-empty','-m','unrelated drift']);};
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'failed');assert.match(f.status().error!,/baseline/i);assert.ok(!f.commands.some(c=>c.startsWith('/usr/bin/pm2')));
}finally{f.cleanup()}});
test('CI admission preview reads the actual eligible job without creating a release or moving refs',rootCI,()=>{const f=ciFixture();try{
 const ref=f.g(f.cfg.builder.source,['rev-parse','deployed']).toString();const preview=previewBuilderCIAdmission(f.cfg.builder.root,f.job.id,f.cfg,f.io) as {plan:{commit:string};planSha256:string;owner:unknown};
 assert.equal(preview.plan.commit,f.payload.source.commit);assert.ok(/^[a-f0-9]{64}$/.test(preview.planSha256));assert.deepEqual(preview.owner,{thread:'owner',session:'turn',audience:'owner'});assert.equal(f.status(),undefined);assert.equal(f.g(f.cfg.builder.source,['rev-parse','deployed']).toString(),ref);assert.ok(!existsSync(join(f.cfg.state,'deploy.lock')));
}finally{f.cleanup()}});
test('verified CI skips only four gates; target dependencies, complete seal, deploy and write-preserving rollback remain',rootCI,async()=>{const f=ciFixture();try{
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'prepared',f.status().error);assert.ok(f.status().ciImport);
 assert.ok(f.commands.some(c=>c==='build /usr/bin/npm ci --ignore-scripts'));assert.ok(!f.commands.some(c=>/^build \/usr\/bin\/npm run (build|check|test)/.test(c)));
 rmSync(join(f.cfg.builder.root,'ci-inbox'),{recursive:true});f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'deployed',f.status().error);assert.equal(readFileSync(join(f.cfg.prod,'packages/phone/dist/index.html'),'utf8'),'new CI runtime');assert.equal(readFileSync(join(f.cfg.prod,'node_modules/new-dependency.txt'),'utf8'),'new dependency');
 const db=new Database(f.cfg.sqlite);db.prepare('INSERT INTO messages(content) VALUES (?)').run('later CI write');db.close();f.request('rollback');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'rolled_back',f.status().error);const after=new Database(f.cfg.sqlite);assert.equal((after.prepare('SELECT count(*) AS n FROM messages').get() as {n:number}).n,2);after.close();assert.ok(!f.commands.some(c=>c.includes('.restore')));
}finally{f.cleanup()}});
for(const kind of ['missing','bad-gate','protected-bytes','wrong-owner'] as const)test(`verified CI ${kind} fails before touching production and never falls back`,rootCI,async()=>{const f=ciFixture();try{
 if(kind==='missing')rmSync(join(f.entry,'receipt.json'));if(kind==='bad-gate'){const p=f.payload as unknown as {gates:{exitCode:number}[]};p.gates=JSON.parse(JSON.stringify(p.gates));p.gates[3].exitCode=1;f.publish();}if(kind==='protected-bytes'){const file=f.payload.files.find(p=>p.path===protectedCompiledPaths[0])!;file.base64=Buffer.from('hostile').toString('base64');file.bytes=7;file.sha256=ciSha('hostile');f.publish();}if(kind==='wrong-owner'){const path=join(f.entry,'receipt.json'),r=JSON.parse(readFileSync(path,'utf8'));r.owner.thread='guest';writeFileSync(path,JSON.stringify(r));}
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'failed');assert.ok(!f.commands.some(c=>/^build \/usr\/bin\/npm run /.test(c)));assert.ok(!f.commands.some(c=>c.startsWith('/usr/bin/pm2')));assert.equal(f.g(f.cfg.prod,['rev-parse','HEAD']).toString().trim(),f.job.baseCommit);
}finally{f.cleanup()}});
test('tampered frozen CI evidence or pin is refused before deployment stop',rootCI,async()=>{for(const kind of ['receipt','package','record','request','manifest']){const f=ciFixture();try{
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'prepared',f.status().error);f.request('deploy');const dir=join(f.cfg.builder.root,'deployments',releaseId);
 if(kind==='receipt'||kind==='package')writeFileSync(join(dir,`ci-${kind}.json`),'tampered');else if(kind==='record'){const store=openBuilderStore(f.cfg.builder.root),r=store.release(releaseId)!;delete r.ciImport;store.saveRelease(r);store.close();}else{const path=join(dir,kind+'.json'),r=JSON.parse(readFileSync(path,'utf8'));delete r.ciImport;writeFileSync(path,JSON.stringify(r));}
 await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'failed',kind);assert.ok(!f.commands.some(c=>c==='/usr/bin/pm2 stop fixture-app'),kind);
}finally{f.cleanup()}}});
test('public shipped configuration template is allowed while runtime config stays private',()=>{assert.equal(credentialPath('examples/bytelight.yaml'),false);assert.equal(credentialPath('bytelight.yaml'),true);assert.equal(credentialPath('nested/bytelight.yaml'),true);});
test('additive SQL contract accepts nullable/default expansion and rejects destructive or incompatible operations',()=>{
  for(const sql of ['CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, title TEXT);','CREATE INDEX IF NOT EXISTS books_title ON books (title);',"ALTER TABLE messages ADD COLUMN label TEXT DEFAULT 'hello; DROP TABLE x';"])assert.ok(additiveSql(sql).length);
  for(const sql of ['DROP TABLE messages;','DELETE FROM messages;','TRUNCATE TABLE messages;','ALTER TABLE messages DROP COLUMN content;','ALTER TABLE messages ADD COLUMN x TEXT NOT NULL;','CREATE UNIQUE INDEX IF NOT EXISTS x ON messages(content);','CREATE TRIGGER x AFTER INSERT ON messages BEGIN DELETE FROM messages; END;','PRAGMA writable_schema = 1;'])assert.throws(()=>additiveSql(sql));
});
test('migration transaction is repeatable, preserves old inserts and later writes, and rejects ledger drift',()=>{
 const f=fixture();try{const sql='ALTER TABLE messages ADD COLUMN label TEXT; CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, title TEXT);';const migrations=[{path:'049_books.sql',sql,digest:sha(sql)}];migrateAdditive(f.cfg.sqlite,migrations);migrateAdditive(f.cfg.sqlite,migrations);const db=new Database(f.cfg.sqlite);db.exec("INSERT INTO messages(content) VALUES ('old app still writes')");assert.equal((db.prepare('SELECT count(*) AS n FROM messages').get() as {n:number}).n,2);db.close();assert.throws(()=>migrateAdditive(f.cfg.sqlite,[{...migrations[0],digest:'different'}]));}finally{f.cleanup();}
});
test('eligibility pins succeeded clean descendant commit; permits package changes and refuses live worker/dirty/wrong branch',()=>{
 const f=fixture();try{const p=eligible(f.job,f.cfg,f.io);assert.ok(p.commit!==p.base);assert.ok(p.native.includes('better-sqlite3@11.10.0'));assert.throws(()=>eligible({...f.job,status:'failed'},f.cfg,f.io));assert.throws(()=>eligible({...f.job,workerPid:123},f.cfg,{...f.io,inspect:()=>({pid:123,starttime:'1',pgid:123,commandHash:'x'})}));f.put(join(f.job.workspace,'scratch.txt'),'dirty');assert.throws(()=>eligible(f.job,f.cfg,f.io));f.commit();assert.ok(eligible(f.job,f.cfg,f.io));assert.throws(()=>eligible({...f.job,branch:'boss/other'},f.cfg,f.io));}finally{f.cleanup();}
});
for(const [name,path,content] of [['secret','.env','TOKEN=secret'],['private key','private.key','private'],['deployment trust','packages/backend/src/services/code-deployment.ts','root helper'],['migration edit','packages/backend/migrations/049_destructive.sql','DROP TABLE messages;']] as const)test(`eligibility blocks ${name}`,()=>{const f=fixture();try{f.put(join(f.job.workspace,path),content);f.commit();assert.throws(()=>eligible(f.job,f.cfg,f.io));}finally{f.cleanup();}});
test('tracked escaping symlink and submodule tree modes are refused',()=>{const f=fixture();try{symlinkSync('/etc/passwd',join(f.job.workspace,'escape'));f.commit();assert.throws(()=>eligible(f.job,f.cfg,f.io),/symlinks/);}finally{f.cleanup();}});
test('non-descendant commit and production baseline/ref drift are refused',()=>{const f=fixture();try{assert.throws(()=>eligible({...f.job,baseCommit:'f'.repeat(40)},f.cfg,f.io));f.g(f.cfg.prod,['commit','--allow-empty','-m','different live release']);assert.throws(()=>eligible(f.job,f.cfg,f.io),/baseline/);}finally{f.cleanup();}});
test('preparation installs with scripts off, rebuilds reviewed native versions, runs checks/tests/full build; no PM2/DB mutation',async()=>{const f=fixture();try{f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'prepared',f.status().error);assert.ok(f.commands.some(c=>c==='build /usr/bin/npm ci --ignore-scripts'));assert.ok(f.commands.some(c=>c.includes('rebuild better-sqlite3@11.10.0')));assert.ok(f.commands.some(c=>c==='build /usr/bin/npm run check'));assert.ok(f.commands.some(c=>c==='build /usr/bin/npm run test'));assert.ok(f.commands.indexOf('build /usr/bin/npm run build')<f.commands.indexOf('build /usr/bin/npm run test'),'fresh stage must compile detached workers before integration tests');assert.ok(!f.commands.some(c=>c.startsWith('/usr/bin/pm2')));assert.equal(readFileSync(join(f.cfg.prod,'.env'),'utf8'),'PRODUCTION_SECRET=retained');}finally{f.cleanup();}});
test('failed preflight/build does not stop or change production',async()=>{const f=fixture();try{f.setFailBuild(true);f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'failed');assert.ok(!existsSync(join(f.cfg.staging,`builder-${releaseId}`)));assert.ok(!f.commands.some(c=>c.startsWith('/usr/bin/pm2')));assert.match(readFileSync(join(f.cfg.prod,'packages/backend/src/app.ts'),'utf8'),/old/);}finally{f.cleanup();}});
test('deploy promotes complete dependencies, manifests and artifacts; explicit latest rollback restores old deps while preserving DB writes',async()=>{const f=fixture();try{f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'prepared',f.status().error);f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'deployed',f.status().error);assert.ok(existsSync(join(f.cfg.prod,'node_modules/new-dependency.txt')));assert.ok(existsSync(join(f.cfg.prod,'packages/backend/node_modules/nested/index.js')));assert.equal(f.g(f.cfg.prod,['rev-parse','HEAD']).toString().trim(),f.status().commit);const db=new Database(f.cfg.sqlite);db.exec("INSERT INTO messages(content) VALUES ('post-deploy write')");db.close();f.request('rollback');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'rolled_back',f.status().error);assert.ok(existsSync(join(f.cfg.prod,'node_modules/old-dependency.txt')));assert.ok(!existsSync(join(f.cfg.prod,'node_modules/new-dependency.txt')));const after=new Database(f.cfg.sqlite);assert.equal((after.prepare('SELECT count(*) AS n FROM messages').get() as {n:number}).n,2);after.close();assert.ok(!f.commands.some(c=>c.includes('.restore')));}finally{f.cleanup();}});
test('unhealthy new release automatically restores code/deps without overwriting post-start writes',async()=>{const f=fixture();try{f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.setUnhealthy();f.setWrites();f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'rolled_back',f.status().rollback);assert.ok(existsSync(join(f.cfg.prod,'node_modules/old-dependency.txt')));const db=new Database(f.cfg.sqlite);assert.ok((db.prepare('SELECT count(*) AS n FROM messages').get() as {n:number}).n>1);db.close();assert.ok(!f.commands.some(c=>c.includes('.restore')));}finally{f.cleanup();}});
test('additive migrations follow final stopped snapshot and survive explicit code rollback',async()=>{const f=fixture();try{f.put(join(f.job.workspace,'packages/backend/migrations/049_labels.sql'),'ALTER TABLE messages ADD COLUMN label TEXT;');f.commit();f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'deployed',f.status().error);assert.ok(f.commands.findIndex(c=>c==='/usr/bin/pm2 stop fixture-app')<f.commands.findIndex(c=>c.startsWith('/usr/bin/sqlite3')));f.request('rollback');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);const db=new Database(f.cfg.sqlite);assert.ok((db.pragma('table_info(messages)') as {name:string}[]).some(c=>c.name==='label'));db.close();assert.equal(f.status().status,'rolled_back');}finally{f.cleanup();}});
test('prepared source/HEAD drift is caught before stopping production',async()=>{const f=fixture();try{f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.put(join(f.job.workspace,'extra.txt'),'drift');f.commit();f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'failed');assert.ok(!f.commands.some(c=>c==='/usr/bin/pm2 stop fixture-app'));}finally{f.cleanup();}});
test('promotion fault restores already replaced paths and dependencies',async()=>{const f=fixture();try{f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);let count=0;f.io.promote=(source,target)=>{if(++count===2)throw Error('fixture interrupted copy');copyReleaseTree(source,target,source.includes('/release/')?join(f.cfg.builder.root,'deployments',releaseId,'release'):join(f.cfg.backup,`builder-${releaseId}`));};f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'rolled_back',f.status().rollback);assert.ok(existsSync(join(f.cfg.prod,'node_modules/old-dependency.txt')));}finally{f.cleanup();}});
test('durable DB serializes in-progress releases and state survives reopen',()=>{const f=fixture();try{f.request('prepare');const db=openBuilderStore(f.cfg.builder.root),r=db.deployment(id)!;assert.throws(()=>db.saveRelease({...r,id:'e'.repeat(64)}));db.close();assert.equal(f.status().status,'preparing');}finally{f.cleanup();}});
test('owner-only tool denial precedes feature/configuration and never invokes the old classifier',async()=>{const denied=await builderReleaseTool('deploy',{id},undefined);assert.equal(denied.ok,false);assert.match(denied.result,/Trusted owner/);const source=readFileSync(new URL('./builder-deployment.ts',import.meta.url),'utf8');assert.ok(!/from ['"].*code-authorization/.test(source));});
test('removed workspace dependencies are deleted on promotion and restored on rollback',async()=>{const f=fixture();try{
 f.put(join(f.cfg.prod,'packages/phone/node_modules/old/index.js'),'old nested');
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
 assert.equal(f.status().status,'deployed',f.status().error);assert.ok(!existsSync(join(f.cfg.prod,'packages/phone/node_modules')));
 f.request('rollback');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'rolled_back');assert.equal(readFileSync(join(f.cfg.prod,'packages/phone/node_modules/old/index.js'),'utf8'),'old nested');
}finally{f.cleanup();}});
test('terminal log failure cannot reverse a healthy deployment or its current pointer',async()=>{const f=fixture();try{
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);let calls=0;const original=f.io.health;
 f.io.health=async(url)=>{await original(url);if(++calls===6){const path=join(f.cfg.builder.root,'deployments',releaseId,'events.jsonl');rmSync(path);mkdirSync(path);}};
 f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'deployed',f.status().error);assert.equal(JSON.parse(readFileSync(join(f.cfg.state,'builder-current.json'),'utf8')).id,releaseId);
}finally{f.cleanup();}});
test('automatic rollback restores previous release marker and verifies backup integrity',async()=>{const f=fixture();try{
 const marker={id:'c'.repeat(64),commit:f.job.baseCommit};f.put(join(f.cfg.state,'builder-current.json'),JSON.stringify(marker));
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.setUnhealthy();f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
 assert.equal(f.status().status,'rolled_back');assert.deepEqual(JSON.parse(readFileSync(join(f.cfg.state,'builder-current.json'),'utf8')),marker);
}finally{f.cleanup();}});
test('prepared dependency tamper fails without stopping production',async()=>{const f=fixture();try{
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.put(join(f.cfg.builder.root,'deployments',releaseId,'release/node_modules/new-dependency.txt'),'tamper');f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'failed');assert.ok(!f.commands.some(c=>c==='/usr/bin/pm2 stop fixture-app'));
}finally{f.cleanup();}});
test('explicit rollback refuses unrelated tracked source drift and leaves current release online',async()=>{const f=fixture();try{
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.put(join(f.cfg.prod,'removed.txt'),'user change');const stops=f.commands.filter(c=>c==='/usr/bin/pm2 stop fixture-app').length;f.request('rollback');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'deployed');assert.match(f.status().error!,/identity mismatch/);assert.equal(f.commands.filter(c=>c==='/usr/bin/pm2 stop fixture-app').length,stops);
}finally{f.cleanup();}});
test('failed rollback health retains exclusive lock and recovery materials',async()=>{const f=fixture();try{
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.io.health=async()=>{throw Error('old release unhealthy');};f.request('rollback');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'recovery_required');assert.ok(existsSync(join(f.cfg.state,'deploy.lock')));assert.ok(existsSync(join(f.cfg.backup,`builder-${releaseId}`,'restore.json')));
}finally{f.cleanup();}});
test('source deletions and additions are symmetric through rollback',async()=>{const f=fixture();try{
 rmSync(join(f.job.workspace,'removed.txt'));f.put(join(f.job.workspace,'added.txt'),'new');f.commit();f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'deployed',f.status().error);assert.ok(!existsSync(join(f.cfg.prod,'removed.txt')));f.request('rollback');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'rolled_back');assert.equal(readFileSync(join(f.cfg.prod,'removed.txt'),'utf8'),'restore me');assert.ok(!existsSync(join(f.cfg.prod,'added.txt')));
}finally{f.cleanup();}});
test('dependency manifests/lock edits are ordinary but native version changes need review',()=>{const f=fixture();try{
 const p=join(f.job.workspace,'package.json');const manifest=JSON.parse(readFileSync(p,'utf8'));manifest.dependencies={ordinary:'1.0.0'};f.put(p,JSON.stringify(manifest));f.put(join(f.job.workspace,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/better-sqlite3':{version:'11.10.0',hasInstallScript:true},'node_modules/ordinary':{version:'1.0.0'}}}));f.commit();assert.ok(eligible(f.job,f.cfg,f.io));f.put(join(f.job.workspace,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/better-sqlite3':{version:'12.0.0',hasInstallScript:true}}}));f.commit();assert.throws(()=>eligible(f.job,f.cfg,f.io),/Native toolchain/);
}finally{f.cleanup();}});

test('restart reconciliation retains matching detached worker and fences dead/reused identities without effects',()=>{const f=fixture();try{
 f.request('prepare');const store=openBuilderStore(f.cfg.builder.root);const record=store.deployment(id)!;
 const worker={pid:123,starttime:'1',pgid:123,commandHash:'abc'};store.saveRelease({...record,worker});reconcileBuilderReleases(store,()=>true);assert.equal(store.deployment(id)!.status,'preparing');
 reconcileBuilderReleases(store,()=>false);assert.equal(store.deployment(id)!.status,'recovery_required');assert.ok(existsSync(join(f.cfg.state,'deploy.lock')));assert.equal(f.commands.length,0);store.close();
}finally{f.cleanup();}});
test('missing worker readiness is given a bounded grace period then fenced',()=>{const f=fixture();try{
 f.request('prepare');const store=openBuilderStore(f.cfg.builder.root);const record=store.deployment(id)!;const now=Date.parse(record.updated);reconcileBuilderReleases(store,()=>false,now+1000);assert.equal(store.deployment(id)!.status,'preparing');reconcileBuilderReleases(store,()=>false,now+16000);assert.equal(store.deployment(id)!.status,'recovery_required');store.close();
}finally{f.cleanup();}});

test('metadata failure after promotion attempts rollback and retains lock when durable recording fails',async()=>{const f=fixture();try{
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);let broken=false;
 const stage=join(f.cfg.staging,`builder-${releaseId}`);f.put(join(stage,'keep'),'keep');
 f.io.persist=r=>{if(r.status==='deployed')broken=true;if(broken)throw Error('fixture metadata disk failure');};
 f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.ok(existsSync(join(f.cfg.state,'deploy.lock')));assert.ok(existsSync(join(f.cfg.prod,'node_modules/old-dependency.txt')));assert.equal(f.g(f.cfg.prod,['rev-parse','HEAD']).toString().trim(),f.job.baseCommit);assert.ok(!existsSync(join(f.cfg.state,'builder-current.json')));
 assert.ok(existsSync(stage));assert.ok(existsSync(join(f.cfg.builder.root,'deployments',releaseId,'release')));
}finally{f.cleanup();}});
test('explicit rollback works when current HTTP is unhealthy',async()=>{const f=fixture();try{
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);let checks=0;f.io.health=async()=>{checks++;};
 f.request('rollback');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'rolled_back');assert.equal(checks,3,'HTTP checks run only after old release restart');
}finally{f.cleanup();}});

test('rollback accepts normal PM2 process restarts but refuses changed application configuration',async()=>{const f=fixture();try{
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);const original=f.io.run;
 f.io.run=(file,args,cwd)=>{const result=original(file,args,cwd);if(file==='/usr/bin/pm2'&&args[0]==='jlist'){const apps=JSON.parse(String(result));if(apps[0].pid){apps[0].pid=456;apps[0].pm2_env.restart_time=8;}return JSON.stringify(apps);}return result;};
 f.request('rollback');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'rolled_back',f.status().error);
}finally{f.cleanup();}});
test('build mutation of tracked source fails before touching production',async()=>{const f=fixture();try{
 const original=f.io.build;f.io.build=(file,args,cwd,cfg)=>{original(file,args,cwd,cfg);if(args[0]==='run'&&args[1]==='build')f.put(join(cwd,'packages/backend/src/app.ts'),'mutated by build');};
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'failed');assert.match(f.status().error!,/committed source/);assert.ok(!f.commands.some(c=>c.startsWith('/usr/bin/pm2')));
}finally{f.cleanup();}});
test('final SQLite backup failure rolls back without applying migrations or replacing live DB',async()=>{const f=fixture();try{
 f.put(join(f.job.workspace,'packages/backend/migrations/049_labels.sql'),'ALTER TABLE messages ADD COLUMN label TEXT;');f.commit();f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);const original=f.io.run;f.io.run=(file,args,cwd)=>{if(file==='/usr/bin/sqlite3')throw Error('snapshot unavailable');return original(file,args,cwd);};f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'rolled_back',f.status().rollback);const db=new Database(f.cfg.sqlite);assert.ok(!(db.pragma('table_info(messages)') as {name:string}[]).some(c=>c.name==='label'));assert.equal((db.prepare('SELECT count(*) AS n FROM messages').get() as {n:number}).n,1);db.close();
}finally{f.cleanup();}});
test('rollback rejects changed PM2 script without stopping the app and remains retryable',async()=>{const f=fixture();try{
 f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);const original=f.io.run,stops=f.commands.filter(c=>c==='/usr/bin/pm2 stop fixture-app').length;
 f.io.run=(file,args,cwd)=>{const result=original(file,args,cwd);if(file==='/usr/bin/pm2'&&args[0]==='jlist'){const apps=JSON.parse(String(result));apps[0].pm2_env.pm_exec_path='/different/server.js';return JSON.stringify(apps);}return result;};
 f.request('rollback');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'deployed');assert.match(f.status().error!,/identity changed/);assert.equal(f.commands.filter(c=>c==='/usr/bin/pm2 stop fixture-app').length,stops);
}finally{f.cleanup();}});

test('manual confirmation pins exact release identity/status/commit/base while autonomous calls remain compatible',()=>{const f=fixture();try{
 const store=openBuilderStore(f.cfg.builder.root);const empty={id:null,status:'not_prepared',commit:'',base:''};assert.doesNotThrow(()=>assertExpectedRelease(store,id,empty));store.close();f.request('prepare');const current=openBuilderStore(f.cfg.builder.root),record=current.deployment(id)!;
 assert.throws(()=>assertExpectedRelease(current,id,empty),/changed since confirmation/);const expected={id:record.id,status:record.status,commit:record.commit,base:record.base};assert.doesNotThrow(()=>assertExpectedRelease(current,id,expected));assert.doesNotThrow(()=>assertExpectedRelease(current,id,undefined));
 for(const change of [{id:'e'.repeat(64)},{status:'prepared'},{commit:'e'.repeat(40)},{base:'e'.repeat(40)}])assert.throws(()=>assertExpectedRelease(current,id,{...expected,...change}),/changed since confirmation/);assert.throws(()=>assertExpectedRelease(current,id,{...expected,command:'spoof'}));current.close();
}finally{f.cleanup();}});


test('real release build sandbox preserves resolver behind hidden runtime tree', () => {
  const f = fixture();
  try {
    const expected = readFileSync('/etc/resolv.conf', 'utf8');
    releaseIO.build(process.execPath, ['-e', `const fs=require('fs');if(fs.readFileSync('/etc/resolv.conf','utf8')!==${JSON.stringify(expected)})process.exit(7);if(fs.existsSync('/srv/bytelight-public'))process.exit(8);fs.writeFileSync('resolver-ok.txt','ok');`], f.cfg.staging, { ...f.cfg, build: { uid: process.getuid!(), gid: process.getgid!() } });
    assert.equal(readFileSync(join(f.cfg.staging, 'resolver-ok.txt'), 'utf8'), 'ok');
  } finally { f.cleanup(); }
});


test('bare deployed source advances only after healthy deployment and restores on explicit rollback', async () => {
  const f = fixture(true), ref = () => f.g(f.cfg.builder.source, ['rev-parse', 'refs/heads/deployed']).toString().trim();
  try {
    assertBuilderBaseline(f.cfg.builder); f.request('prepare'); await runBuilderRelease(f.cfg.builder.root, releaseId, f.io);
    assert.equal(f.status().status, 'prepared'); assert.equal(ref(), f.job.baseCommit);
    f.request('deploy'); await runBuilderRelease(f.cfg.builder.root, releaseId, f.io);
    assert.equal(f.status().status, 'deployed', f.status().error); assert.equal(ref(), f.status().commit); assertBuilderBaseline(f.cfg.builder);
    assert.equal(f.g(f.job.workspace, ['rev-parse', '--git-common-dir']).toString().trim(), f.cfg.builder.source);
    f.request('rollback'); await runBuilderRelease(f.cfg.builder.root, releaseId, f.io);
    assert.equal(f.status().status, 'rolled_back', f.status().error); assert.equal(ref(), f.job.baseCommit); assertBuilderBaseline(f.cfg.builder);
  } finally { f.cleanup(); }
});
test('preparation failure and source-production mismatch leave deployed ref untouched', async () => {
  const f = fixture(true);
  try {
    f.setFailBuild(true); f.request('prepare'); await runBuilderRelease(f.cfg.builder.root, releaseId, f.io);
    assert.equal(f.status().status, 'failed'); assertBuilderBaseline(f.cfg.builder);
    f.g(f.cfg.builder.source, ['update-ref', 'refs/heads/deployed', f.g(f.job.workspace, ['rev-parse', 'HEAD']).toString().trim(), f.job.baseCommit]);
    assert.equal(builderBaselineState(f.cfg.builder).status, 'blocked'); assert.throws(() => eligible(f.job, f.cfg, f.io), /BASELINE_MISMATCH/);
    await assert.rejects(startBuilderJob({ task: 'must not spawn' }, { thread: 'owner', session: 'turn', audience: 'owner' }, f.cfg.builder), /BASELINE_MISMATCH/);
    assert.equal(f.g(f.cfg.prod, ['rev-parse', 'HEAD']).toString().trim(), f.job.baseCommit);
  } finally { f.cleanup(); }
});
test('post-ref metadata failure automatically rolls back production and deployed ref coherently', async () => {
  const f = fixture(true); let fail = true;
  try {
    f.request('prepare'); await runBuilderRelease(f.cfg.builder.root, releaseId, f.io);
    f.io.persist = record => { if (record.status === 'deployed' && fail) { fail = false; throw Error('post-ref metadata failure'); } };
    f.request('deploy'); await runBuilderRelease(f.cfg.builder.root, releaseId, f.io);
    assert.equal(f.status().status, 'rolled_back', f.status().error); assertBuilderBaseline(f.cfg.builder);
    assert.equal(f.g(f.cfg.builder.source, ['rev-parse', 'deployed']).toString().trim(), f.job.baseCommit);
  } finally { f.cleanup(); }
});
test('concurrent deployed-ref change is never silently reset and keeps uncertain recovery fenced', async () => {
  const f = fixture(true);
  try {
    f.request('prepare'); await runBuilderRelease(f.cfg.builder.root, releaseId, f.io);
    const other = f.g(f.cfg.builder.source, ['commit-tree', f.g(f.cfg.builder.source, ['rev-parse', f.job.baseCommit + '^{tree}']).toString().trim(), '-p', f.job.baseCommit, '-m', 'external drift']).toString().trim();
    f.io.persist = record => { if (record.phase === 'restarting') f.g(f.cfg.builder.source, ['update-ref', 'refs/heads/deployed', other]); };
    f.request('deploy'); await runBuilderRelease(f.cfg.builder.root, releaseId, f.io);
    assert.equal(f.status().status, 'recovery_required'); assert.equal(f.g(f.cfg.builder.source, ['rev-parse', 'deployed']).toString().trim(), other);
    assert.ok(existsSync(join(f.cfg.state, 'deploy.lock'))); assert.equal(builderBaselineState(f.cfg.builder).status, 'blocked');
  } finally { f.cleanup(); }
});


test('shared bootstrap or legacy deployment lock blocks new coding admission', async () => {
  const f = fixture(true);
  try {
    writeFileSync(join(f.cfg.state, 'deploy.lock'), 'bootstrap');
    await assert.rejects(startBuilderJob({ task: 'must not spawn' }, { thread: 'owner', session: 'turn', audience: 'owner' }, { ...f.cfg.builder, deploymentState: f.cfg.state }), /Shared deployment lock/);
    assert.equal(f.g(f.cfg.builder.source, ['rev-parse', 'deployed']).toString().trim(), f.job.baseCommit);
  } finally { f.cleanup(); }
});

test('real release sandbox provides private writable var/tmp for nested integration fixtures',()=>{const f=fixture();const stage=mkdtempSync(join(f.cfg.staging,'builder-release-stage-test-'));try{mkdirSync(join(stage,'.build-home'));releaseIO.build(process.execPath,['-e','const fs=require("fs");const p=fs.mkdtempSync("/var/tmp/builder-inner-");fs.writeFileSync(p+"/ok","private");fs.writeFileSync(process.cwd()+"/sandbox-ok","ok");if(fs.existsSync("/srv/bytelight-public"))process.exit(2)'],stage,{...f.cfg,build:{uid:process.getuid!(),gid:process.getgid!()}});assert.equal(readFileSync(join(stage,'sandbox-ok'),'utf8'),'ok');}finally{rmSync(stage,{recursive:true,force:true});f.cleanup();}});

test('deployment refuses missing/tampered/unpinned source bundle before any stop', async()=>{
  for (const kind of ['missing','tamper','symlink','request','manifest','record']) {
    const f=fixture();try {
      f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
      assert.equal(f.status().status,'prepared',f.status().error);
      const dir=join(f.cfg.builder.root,'deployments',releaseId),path=join(dir,'source.bundle');
      f.request('deploy');
      if(kind==='missing')rmSync(path);
      if(kind==='tamper')writeFileSync(path,'tampered');
      if(kind==='symlink'){rmSync(path);symlinkSync(join(f.cfg.prod,'package.json'),path);}
      if(kind==='request'||kind==='manifest'){
        const path=join(dir,kind+'.json'),data=JSON.parse(readFileSync(path,'utf8'));delete data.bundleSha256;writeFileSync(path,JSON.stringify(data),{mode:0o600});
      }
      if(kind==='record'){const store=openBuilderStore(f.cfg.builder.root),record=store.release(releaseId)!;delete record.bundleSha256;store.saveRelease(record);store.close();}
      await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
      assert.equal(f.status().status,'failed',kind);
      assert.ok(!f.commands.some(command=>command.startsWith('/usr/bin/pm2 stop')),kind);
      assert.equal(f.g(f.cfg.prod,['rev-parse','HEAD']).toString().trim(),f.job.baseCommit);
    }finally{f.cleanup();}
  }
});
test('bundle identity is pinned in request/manifest/record and deploy fetches sealed path', async()=>{
  const f=fixture();try {
    f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
    const dir=join(f.cfg.builder.root,'deployments',releaseId),record=f.status();
    assert.match(record.bundleSha256!,/^[a-f0-9]{64}$/);
    for(const file of ['request.json','manifest.json'])assert.equal(JSON.parse(readFileSync(join(dir,file),'utf8')).bundleSha256,record.bundleSha256);
    f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
    assert.equal(f.status().status,'deployed',f.status().error);
    const fetch=f.commands.find(command=>command.includes(' fetch '))!;
    assert.ok(fetch.includes(join(dir,'source.bundle')));assert.ok(!fetch.includes(f.job.workspace));
  }finally{f.cleanup();}
});

test('bundle tampering during promotion refuses import and automatically restores healthy baseline',async()=>{
  const f=fixture();try {
    f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
    f.io.persist=record=>{if(record.phase==='promoting')writeFileSync(join(f.cfg.builder.root,'deployments',releaseId,'source.bundle'),'tampered after stop');};
    f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
    assert.equal(f.status().status,'rolled_back',f.status().error);assert.match(f.status().error!,/bundle hash mismatch/);
    assert.ok(!f.commands.some(command=>command.includes(' fetch ')));
    assert.equal(f.g(f.cfg.prod,['rev-parse','HEAD']).toString().trim(),f.job.baseCommit);
  }finally{f.cleanup();}
});

test('PREPARE refuses live worker before creating a bundle or coder temporary state',async()=>{
  const f=fixture();try {
    f.request('prepare');const store=openBuilderStore(f.cfg.builder.root);store.update(id,{workerPid:123});store.close();
    f.io.inspect=pid=>pid===123?{pid:123,starttime:'1',pgid:123,commandHash:'fixture'}:null;
    await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
    assert.equal(f.status().status,'failed');assert.match(f.status().error!,/still live/);
    assert.ok(!existsSync(join(f.cfg.builder.root,'deployments',releaseId,'source.bundle')));
    assert.ok(!f.commands.some(command=>command.startsWith('/usr/bin/pm2 stop')));
  }finally{f.cleanup();}
});

test('terminal retention removes stage after prepare and sealed runtime after healthy deploy, keeping metadata and current rollback', async()=>{
 const f=fixture();try {
  const dir=join(f.cfg.builder.root,'deployments',releaseId),stage=join(f.cfg.staging,`builder-${releaseId}`);
  f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
  assert.equal(f.status().status,'prepared',f.status().error);assert.ok(!existsSync(stage));assert.ok(existsSync(join(dir,'release')));
  const obsolete=join(f.cfg.backup,`builder-${'b'.repeat(64)}`);f.put(join(obsolete,'large-runtime'),'obsolete');
  const unrelated=join(f.cfg.backup,'legacy-backup'),malformed=join(f.cfg.backup,'builder-short');
  for(const path of [unrelated,malformed])f.put(join(path,'keep'),'keep');
  const linked=join(f.cfg.backup,`builder-${'c'.repeat(64)}`);symlinkSync(unrelated,linked);
  const file=join(f.cfg.backup,`builder-${'e'.repeat(64)}`);writeFileSync(file,'keep');
  f.put(join(stage,'disposable'),'stage');
  f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
  assert.equal(f.status().status,'deployed',f.status().error);assert.ok(!existsSync(stage));assert.ok(!existsSync(join(dir,'release')));assert.ok(!existsSync(obsolete));
  for(const path of [unrelated,malformed,linked,file,join(f.cfg.backup,`builder-${releaseId}`),f.job.workspace])assert.ok(existsSync(path),path);
  for(const file of ['request.json','manifest.json','source.bundle','events.jsonl'])assert.ok(existsSync(join(dir,file)),file);
  assert.match(readFileSync(join(dir,'events.jsonl'),'utf8'),/Artifact cleanup failed/);assert.ok(!existsSync(join(f.cfg.state,'deploy.lock')));
  f.request('rollback');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);assert.equal(f.status().status,'rolled_back',f.status().error);
 }finally{f.cleanup();}
});

test('failed pre-production deployment removes only disposable stage and sealed runtime',async()=>{
 const f=fixture();try {
  f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
  const dir=join(f.cfg.builder.root,'deployments',releaseId),stage=join(f.cfg.staging,`builder-${releaseId}`);
  f.put(join(stage,'partial'),'partial');f.put(join(dir,'release/node_modules/new-dependency.txt'),'tamper');
  const old=join(f.cfg.backup,`builder-${'b'.repeat(64)}`);f.put(join(old,'keep'),'keep');
  f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
  assert.equal(f.status().status,'failed');assert.ok(!existsSync(stage));assert.ok(!existsSync(join(dir,'release')));assert.ok(existsSync(old));
  for(const file of ['request.json','manifest.json','source.bundle','events.jsonl'])assert.ok(existsSync(join(dir,file)));
  assert.ok(!f.commands.some(c=>c.startsWith('/usr/bin/pm2 stop')));assert.ok(!existsSync(join(f.cfg.state,'deploy.lock')));
 }finally{f.cleanup();}
});

test('failed preparation cleans partial staging and sealed runtime without touching source workspace',async()=>{
 const f=fixture();try {
  f.request('prepare');const dir=join(f.cfg.builder.root,'deployments',releaseId);f.put(join(dir,'release/partial'),'partial');
  f.setFailBuild(true);await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
  assert.equal(f.status().status,'failed');assert.ok(!existsSync(join(f.cfg.staging,`builder-${releaseId}`)));assert.ok(!existsSync(join(dir,'release')));
  assert.ok(existsSync(join(dir,'source.bundle')));assert.ok(existsSync(f.job.workspace));
 }finally{f.cleanup();}
});

test('recovery-required deployment preserves stage, sealed runtime, every rollback and lock',async()=>{
 const f=fixture();try {
  f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
  const stage=join(f.cfg.staging,`builder-${releaseId}`),sealed=join(f.cfg.builder.root,'deployments',releaseId,'release');
  f.put(join(stage,'keep'),'keep');const old=join(f.cfg.backup,`builder-${'b'.repeat(64)}`);f.put(join(old,'keep'),'keep');
  let checks=0;f.io.health=async()=>{if(++checks>3)throw Error('persistent outage');};
  f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
  assert.equal(f.status().status,'recovery_required');
  for(const path of [stage,sealed,old,join(f.cfg.backup,`builder-${releaseId}`),join(f.cfg.state,'deploy.lock')])assert.ok(existsSync(path),path);
 }finally{f.cleanup();}
});

test('cleanup refuses symlink staging and sealed targets without reversing terminal state',async()=>{
 const f=fixture();try {
  f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
  const stage=join(f.cfg.staging,`builder-${releaseId}`),sealed=join(f.cfg.builder.root,'deployments',releaseId,'release');
  symlinkSync(f.job.workspace,stage);rmSync(sealed,{recursive:true});symlinkSync(f.job.workspace,sealed);
  f.request('deploy');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
  assert.equal(f.status().status,'failed');assert.ok(existsSync(stage));assert.ok(existsSync(sealed));assert.ok(existsSync(f.job.workspace));
  assert.match(readFileSync(join(f.cfg.builder.root,'deployments',releaseId,'events.jsonl'),'utf8'),/Artifact cleanup failed/);
 }finally{f.cleanup();}
});
test('source-only reprepare hits real npm workspace artifact and still runs every validation phase', async () => {
 const f=fixture(false, true);try {
  f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
  assert.equal(f.status().status,'prepared',f.status().error);
  assert.equal(f.status().dependencyCache?.hit,false);
  const release=join(f.cfg.builder.root,'deployments',releaseId);
  rmSync(join(release,'source.bundle'));rmSync(join(release,'release'),{recursive:true});
  const installs=f.commands.filter(c=>c==='build /usr/bin/npm ci --ignore-scripts').length;
  assert.equal(installs, 1);
  const before = f.commands.length;
  f.put(join(f.job.workspace,'packages/backend/src/app.ts'),'export const value = "source-only edit";\n');f.commit();
  f.request('prepare');await runBuilderRelease(f.cfg.builder.root,releaseId,f.io);
  assert.equal(f.status().status,'prepared',f.status().error);
  assert.equal(f.status().dependencyCache?.hit,true);
  assert.equal(f.commands.filter(c=>c==='build /usr/bin/npm ci --ignore-scripts').length,installs);
  for (const command of ['run build --workspace=packages/shared', 'run check', 'run build', 'run test'])
    assert.ok(f.commands.slice(before).includes(`build /usr/bin/npm ${command}`), command);
  const sealed = join(release, 'release');
  for (const name of ['backend', 'frontend', 'shared', 'phone'])
    assert.equal(readFileSync(join(sealed, `node_modules/@bytelight/${name}/package.json`), 'utf8'), readFileSync(join(f.job.workspace, `packages/${name}/package.json`), 'utf8'));
  const metrics=f.status().metrics?.prepare!;
  for(const phase of ['validating','dependencies','checks-tests-build','sealing','_elapsed']) assert.ok(metrics[phase]>=0,phase);
  assert.ok(!existsSync(join(f.cfg.staging,`builder-${releaseId}`)));
 }finally{f.cleanup();}
});

test('runtime identity distinguishes file boundaries and dangling symlink changes', () => {
 const root=mkdtempSync(join(tmpdir(),'identity-test-'));
 try {
  const path=join(root,'artifact');symlinkSync('missing-a',path);
  const first=identityDigest(root,['artifact']);rmSync(path);symlinkSync('missing-b',path);
  assert.notEqual(first,identityDigest(root,['artifact']));
  rmSync(path);writeFileSync(path,'missing-b');
  assert.notEqual(first,identityDigest(root,['artifact']));
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('runtime identity length framing prevents cross-file content boundary collisions', () => {
 const root=mkdtempSync(join(tmpdir(),'identity-boundary-test-'));
 try {
  const a=join(root,'a'),b=join(root,'b');
  writeFileSync(a,'b420',{mode:0o644});writeFileSync(b,'',{mode:0o644});
  const first=identityDigest(root,['a','b']);
  writeFileSync(a,'');writeFileSync(b,'b420');
  assert.notEqual(first,identityDigest(root,['a','b']));
 } finally {rmSync(root,{recursive:true,force:true});}
});


test('native hardlinked install cold-restores before app commands; source-only warm prepare and promotion stay independent', async () => {
 const f = fixture(); try {
  const paths = ['node_modules/better-sqlite3/build/Release/obj.target/better_sqlite3.node',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'packages/backend/node_modules/nested/native.node'];
  const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]);
  const original = f.io.build;
  let artifact = '', checks = 0;
  let stageInodes: number[] = [];
  const assertIndependent = (roots: string[]) => {
    const stats = roots.flatMap(root => paths.map(path => lstatSync(join(root, path))));
    assert.ok(stats.every(st => st.isFile() && st.nlink === 1));
    assert.equal(new Set(stats.map(st => st.ino)).size, stats.length);
    for (const root of roots) for (const path of paths) assert.deepEqual(readFileSync(join(root, path)), bytes);
  };
  f.io.build = (file, args, cwd, cfg) => {
    const result = original(file, args, cwd, cfg);
    if (args[0] === 'ci') {
      for (const path of paths) mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, paths[0]), bytes);
      for (const path of paths.slice(1)) linkSync(join(cwd, paths[0]), join(cwd, path));
      assert.equal(lstatSync(join(cwd, paths[0])).nlink, 3);
    }
    if (args[0] === 'run') {
      artifact = join(f.cfg.builder.root, 'dependency-cache', f.status().dependencyCache!.key, 'tree');
      assertIndependent([artifact, cwd]);
      stageInodes = paths.map(path => lstatSync(join(cwd, path)).ino);
      checks++;
    }
    return result;
  };
  const sealed = join(f.cfg.builder.root, 'deployments', releaseId, 'release');
  for (const warm of [false, true]) {
    if (warm) {
      rmSync(sealed, { recursive: true });
      rmSync(join(f.cfg.builder.root, 'deployments', releaseId, 'source.bundle'));
      f.put(join(f.job.workspace, 'packages/backend/src/app.ts'), 'export const value = "warm";'); f.commit();
      // Match normal ignored coder installs while keeping the source commit clean.
      f.put(join(f.root, 'fixture-ignore'), 'node_modules/\n');
      f.g(f.job.workspace, ['config', 'core.excludesFile', join(f.root, 'fixture-ignore')]);
      // A coder install must never become an input.
      f.put(join(f.job.workspace, paths[0]), 'untrusted workspace dependency');
    }
    const before = f.commands.length;
    f.request('prepare'); await runBuilderRelease(f.cfg.builder.root, releaseId, f.io);
    assert.equal(f.status().status, 'prepared', f.status().error);
    assert.equal(f.status().dependencyCache?.hit, warm);
    for (const command of ['run build --workspace=packages/shared', 'run check', 'run build', 'run test'])
      assert.ok(f.commands.slice(before).includes(`build /usr/bin/npm ${command}`));
    assertIndependent([artifact, sealed]);
    for (const path of paths) assert.ok(!stageInodes.includes(lstatSync(join(sealed, path)).ino));
  }
  assert.equal(checks, 8);
  assert.equal(f.commands.filter(c => c === 'build /usr/bin/npm ci --ignore-scripts').length, 1);
  assert.equal(f.commands.filter(c => c.includes('rebuild better-sqlite3@')).length, 1);
  // Simulate promotion with the same strict copier, retaining the sealed input
  // for simultaneous inode comparison (healthy deployment retention removes it).
  const promoted = join(f.root, 'promoted'); copyReleaseTree(sealed, promoted, sealed);
  assertIndependent([artifact, sealed, promoted]);
 } finally { f.cleanup(); }
});


test('application-created dependency hardlinks still fail strict cold sealing', async () => {
 const f = fixture(); try {
  const original = f.io.build;
  f.io.build = (file, args, cwd, cfg) => {
    const result = original(file, args, cwd, cfg);
    if (args[0] === 'run' && args[1] === 'test')
      linkSync(join(cwd, 'node_modules/new-dependency.txt'), join(cwd, 'node_modules/app-alias'));
    return result;
  };
  f.request('prepare'); await runBuilderRelease(f.cfg.builder.root, releaseId, f.io);
  assert.equal(f.status().status, 'failed');
  assert.match(f.status().error!, /Special file in release:.*nlink=2/);
  assert.ok(!f.commands.some(c => c.startsWith('/usr/bin/pm2')));
 } finally { f.cleanup(); }
});
