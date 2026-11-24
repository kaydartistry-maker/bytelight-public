import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { activate, recover } from './boss-activation-core.mjs';
import { BASE, FIXED, PUBLIC, copyTree, safeRelative, validatePlan, approvalText, stableHealth, priorDefinition, replaceTree, selectApp, stageCommand, appendCommandDiagnostic, redactCommandTail, effectStep, effectPhase, createSourceBundle, promoteTree, restoreTree } from './activate-boss-daddy.mjs';

// Explicit test-only adapter. Every file is below one fresh disposable root;
// PM2/npm/health are fake. No production adapter or commands are invoked.
function fixture(t, faults = []) {
  const root = fs.mkdtempSync(join(tmpdir(), 'boss-activation-fixture-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const path = n => join(root,n);
  fs.mkdirSync(path('prod')); fs.mkdirSync(path('prod/node_modules'));
  fs.writeFileSync(path('prod/source'),'prior'); fs.writeFileSync(path('prod/node_modules/native'),'prior-dependency'); fs.writeFileSync(path('prod/database'),'write-before');
  fs.writeFileSync(path('prod/.env'),'API_KEY=fixture-private-value');
  const git = args => execFileSync('/usr/bin/git',args,{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:['ignore','pipe','pipe']}).toString().trim();
  git(['init','--bare','source.git']);
  // Real immutable Git objects/ref CAS; private fixture repo only.
  const blob=git(['--git-dir=source.git','hash-object','-w','--stdin']);
  const tree=execFileSync('/usr/bin/git',['--git-dir=source.git','mktree'],{cwd:root,input:`100644 blob ${blob}\tfixture\n`}).toString().trim();
  const commit = message => execFileSync('/usr/bin/git',['--git-dir=source.git','commit-tree',tree],{cwd:root,input:message,env:{PATH:'/usr/bin:/bin',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}}).toString().trim();
  const base=commit('base'), target=commit('target');
  git(['--git-dir=source.git','update-ref','refs/heads/deployed',base]);
  const state={running:true,head:base,env:{OLD:'preserved'},policy:{kill_timeout:9000,exp_backoff_restart_delay:300,max_memory_restart:500000},stopCount:0,health:0};
  const calls=[], remaining=[...faults];
  const hit=name=>{calls.push(name);const i=remaining.indexOf(name);if(i>=0){remaining.splice(i,1);throw new Error('password=fixture-private-value phase '+name);}};
  const plan={target,tree};
  const adapter={
    async preflight(){hit('preflight');if(state.head!==base||fs.existsSync(path('receipt')))throw Error('second-run');},
    async lock(){hit('lock');fs.writeFileSync(path('lock'),'locked',{flag:'wx'});},
    async unlock(){hit('unlock');fs.unlinkSync(path('lock'));},
    async record(r){fs.writeFileSync(path('receipt'),JSON.stringify(r));},
    async stage(){hit('stage');fs.mkdirSync(path('stage'));fs.writeFileSync(path('stage/source'),'target');fs.mkdirSync(path('stage/node_modules'));fs.writeFileSync(path('stage/node_modules/native'),'new-dependency');hit('npm');},
    async backup(){hit('backup');fs.cpSync(path('prod'),path('backup'),{recursive:true});fs.writeFileSync(path('prior-env'),JSON.stringify({env:state.env,policy:state.policy}));},
    async stop(){hit('stop');state.running=false;state.stopCount++;},
    async snapshot(){hit('snapshot');assert.equal(state.running,false);fs.copyFileSync(path('prod/database'),path('final-db'));},
    async promote(){hit('promote');assert.equal(state.running,false);assert.ok(fs.existsSync(path('final-db')));fs.copyFileSync(path('stage/source'),path('prod/source'));fs.rmSync(path('prod/node_modules'),{recursive:true});fs.cpSync(path('stage/node_modules'),path('prod/node_modules'),{recursive:true});state.head=target;hit('promote-partial');},
    async source(){hit('source');git(['--git-dir=source.git','update-ref','refs/heads/deployed',target,base]);},
    async configure(){hit('config');state.env={...state.env,...PUBLIC};},
    async restart(){hit('restart');state.running=true;fs.appendFileSync(path('prod/database'),'\npost-start-write');},
    async health(){hit('health');state.health+=3;assert.equal(state.running,true);assert.equal(git(['--git-dir=source.git','rev-parse','deployed']),target);},
    async persist(){hit('persist');},
    async safetySnapshot(){hit('safety');assert.equal(state.running,false);fs.copyFileSync(path('prod/database'),path('current-db'));},
    async restore(){hit('restore');for(const p of ['source','node_modules']){fs.rmSync(path('prod/'+p),{recursive:true,force:true});fs.cpSync(path('backup/'+p),path('prod/'+p),{recursive:true});}state.head=base;const ref=git(['--git-dir=source.git','rev-parse','deployed']);if(ref===target)git(['--git-dir=source.git','update-ref','refs/heads/deployed',base,target]);else assert.equal(ref,base);},
    async restartPrior(){hit('restart-prior');const prior=JSON.parse(fs.readFileSync(path('prior-env')));state.env=prior.env;state.policy=prior.policy;state.running=true;},
    async healthPrior(){hit('health-prior');assert.equal(state.running,true);assert.equal(state.head,base);assert.equal(fs.readFileSync(path('prod/node_modules/native'),'utf8'),'prior-dependency');assert.deepEqual(state.env,{OLD:'preserved'});assert.equal(state.policy.kill_timeout,9000);},
  };
  const foreign=commit('foreign');
  adapter.loadRecovery=async()=>JSON.parse(fs.readFileSync(path('receipt')));
  adapter.verifyUntouched=async()=>{assert.equal(state.head,base);assert.equal(state.running,true);};
  return {root,path,git,base,target,foreign,plan,state,calls,adapter};
}

test('successful bootstrap stages before downtime, snapshots while stopped, keeps deps/source coherent and retains backup',async t=>{
 const f=fixture(t);const r=await activate(f.adapter,f.plan);assert.equal(r.status,'activated');assert.equal(f.state.head,f.target);assert.equal(f.state.health,3);assert.equal(fs.existsSync(f.path('lock')),false);assert.ok(fs.existsSync(f.path('backup/.env')));assert.ok(f.calls.indexOf('npm')<f.calls.indexOf('stop'));assert.ok(f.calls.indexOf('snapshot')<f.calls.indexOf('promote'));assert.equal(fs.readFileSync(f.path('prod/.env'),'utf8'),'API_KEY=fixture-private-value');
 await assert.rejects(activate(f.adapter,f.plan),/second-run/);
});
for(const fault of ['preflight','lock']) test(`${fault} refuses without stop`,async t=>{const f=fixture(t,[fault]);if(fault==='preflight')await assert.rejects(activate(f.adapter,f.plan));else assert.equal((await activate(f.adapter,f.plan)).status,'failed_before_stop');assert.equal(f.state.stopCount,0);});
for(const fault of ['stage','npm','backup']) test(`${fault} leaves production running and untouched`,async t=>{const f=fixture(t,[fault]);const r=await activate(f.adapter,f.plan);assert.equal(r.status,'failed_before_stop');assert.equal(f.state.stopCount,0);assert.equal(f.state.head,f.base);assert.equal(fs.readFileSync(f.path('prod/source'),'utf8'),'prior');assert.equal(fs.existsSync(f.path('lock')),false);});
for(const fault of ['stop','snapshot','promote','promote-partial','source','config','restart','health','persist']) test(`${fault} fault restores source, dependencies, environment and PM2 policy`,async t=>{const f=fixture(t,[fault]);const r=await activate(f.adapter,f.plan);assert.equal(r.status,'rolled_back');assert.equal(f.state.head,f.base);assert.equal(f.state.running,true);assert.equal(fs.existsSync(f.path('lock')),false);assert.equal(JSON.stringify(r).includes('fixture-private-value'),false);if(fault==='health'||fault==='persist')assert.match(fs.readFileSync(f.path('prod/database'),'utf8'),/post-start-write/);});
for(const rollbackFault of ['safety','restore','restart-prior','health-prior']) test(`rollback ${rollbackFault} failure keeps lock and never claims health`,async t=>{const f=fixture(t,['health',rollbackFault]);const r=await activate(f.adapter,f.plan);assert.equal(r.status,'recovery_required');assert.equal(r.rollback.healthy,false);assert.equal(fs.existsSync(f.path('lock')),true);assert.equal(f.state.running,false);});
test('foreign source ref drift is preserved and fences rollback',async t=>{const f=fixture(t,['health']);f.adapter.health=async()=>{f.git(['--git-dir=source.git','update-ref','refs/heads/deployed',f.foreign,f.target]);throw Error('unhealthy');};const r=await activate(f.adapter,f.plan);assert.equal(r.status,'recovery_required');assert.equal(f.git(['--git-dir=source.git','rev-parse','deployed']),f.foreign);assert.equal(fs.existsSync(f.path('lock')),true);});
test('copy preserves internal dependency symlinks and executable modes; escaping links rejected',t=>{
 const root=fs.mkdtempSync(join(tmpdir(),'boss-activation-fixture-copy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(join(root,'source'));fs.mkdirSync(join(root,'source/bin'));fs.writeFileSync(join(root,'source/bin/run'),'run',{mode:0o755});fs.chmodSync(join(root,'source/bin/run'),0o755);fs.symlinkSync('bin/run',join(root,'source/run'));copyTree(join(root,'source'),join(root,'copy'));assert.equal(fs.readlinkSync(join(root,'copy/run')),'bin/run');assert.equal(fs.statSync(join(root,'copy/bin/run')).mode&0o111,0o111);fs.symlinkSync('/etc/passwd',join(root,'source/bad'));assert.throws(()=>copyTree(join(root,'source'),join(root,'badcopy')),/ESCAPING_LINK/);
});
test('relative path and strict plan reject injected commands, paths or configuration',()=>{
 for(const p of ['/root','../a','a/../b','x\ny',''])assert.throws(()=>safeRelative(p));
 const plan={version:1,baseline:BASE,target:'a'.repeat(40),tree:'b'.repeat(40),files:['README.md'],changedFiles:['M\tREADME.md'],productionFingerprints:{'.env':'c'.repeat(64),'ecosystem.config.cjs':'c'.repeat(64),'package-lock.json':'c'.repeat(64)},identity:{},publicEnvironment:PUBLIC,lockSha256:'c'.repeat(64),native:[],scriptHashes:{'activate-boss-daddy.mjs':'d'.repeat(64),'boss-activation-core.mjs':'d'.repeat(64)}};
 assert.equal(validatePlan(plan),plan);assert.throws(()=>validatePlan({...plan,command:'whoami'}));assert.throws(()=>validatePlan({...plan,publicEnvironment:{...PUBLIC,BYTELIGHT_BUILDER_SOURCE:'/root'}}));assert.throws(()=>validatePlan({...plan,files:['../secret']}));assert.equal(approvalText(plan,'d'.repeat(64)).includes('fixture-private-value'),false);assert.equal(FIXED.repo,'/srv/bytelight-builder-source');
});

test('fresh recovery resumes rollback from durable receipt without redeploy',async t=>{const f=fixture(t,['health','restore']);assert.equal((await activate(f.adapter,f.plan)).status,'recovery_required');const before=f.calls.filter(x=>x==='promote').length;const r=await recover({...f.adapter});assert.equal(r.status,'rolled_back');assert.equal(fs.existsSync(f.path('lock')),false);assert.equal(f.calls.filter(x=>x==='promote').length,before);});

test('recovery before stop releases only after proving untouched production',async t=>{const f=fixture(t);await f.adapter.lock();await f.adapter.record({target:f.target,tree:f.plan.tree,phases:['stage']});const r=await recover(f.adapter);assert.equal(r.status,'failed_before_stop');assert.equal(f.state.stopCount,0);assert.equal(fs.existsSync(f.path('lock')),false);});
test('PM2 capture preserves prior operational policy and exact environment absence',()=>{const app={pm2_env:{name:'bytelight',pm_exec_path:'/fixture/server.js',pm_cwd:'/fixture',exec_interpreter:'node',env:{OLD:'old'},kill_timeout:9000,max_memory_restart:1000,exp_backoff_restart_delay:200,pm_out_log_path:'/fixture/out.log'}};const d=priorDefinition(app);for(const k of ['kill_timeout','max_memory_restart','exp_backoff_restart_delay','pm_out_log_path'])assert.equal(d[k],app.pm2_env[k]);assert.equal(d.env.BYTELIGHT_BUILDER_ENABLED,undefined);assert.deepEqual(d.env,{OLD:'old'});});
test('health requires three consecutive successful samples with stable process identity',async()=>{const identity={name:'bytelight',cwd:'/fixture',script:'/fixture/server.js',interpreter:'node',uid:0};let n=0,requests=0;const read=()=>({name:'bytelight',pid:++n<3?10:11,pm2_env:{pm_cwd:'/fixture',pm_exec_path:'/fixture/server.js',exec_interpreter:'node',status:'online',restart_time:0}});const request=async()=>({ok:++requests!==2,json:async()=>({status:'ok'})});const result=await stableHealth(read,request,identity,async()=>{});assert.equal(result.samples,3);assert.equal(result.pid,11);assert.equal(requests,5);});
test('health refuses changed PM2 script identity without accepting HTTP success',async()=>{await assert.rejects(stableHealth(()=>({name:'bytelight',pid:1,pm2_env:{pm_cwd:'/wrong',pm_exec_path:'/wrong',exec_interpreter:'node',status:'online'}}),async()=>({ok:true,json:async()=>({status:'ok'})}),{},async()=>{}),/PM2_IDENTITY_CHANGED/);});

test('PM2 recovery accepts absent selected app but rejects duplicate applications',()=>{assert.equal(selectApp([],true),undefined);assert.throws(()=>selectApp([]),/PM2_IDENTITY/);assert.throws(()=>selectApp([{name:'bytelight'},{name:'bytelight'}],true),/PM2_IDENTITY/);});
test('failed copy removes only its partial temp; rollback can replace interrupted promotion',t=>{const root=fs.mkdtempSync(join(tmpdir(),'boss-activation-fixture-replace-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const source=join(root,'source'),prod=join(root,'prod');fs.mkdirSync(source);fs.mkdirSync(prod);fs.mkdirSync(join(source,'tree'));fs.writeFileSync(join(source,'tree/a'),'new');fs.symlinkSync('/etc/passwd',join(source,'tree/z'));fs.mkdirSync(join(prod,'tree'));fs.writeFileSync(join(prod,'tree/old'),'old');assert.throws(()=>replaceTree(join(source,'tree'),join(prod,'tree'),source,prod),/ESCAPING_LINK/);assert.equal(fs.existsSync(join(prod,'tree.boss-next')),false);assert.equal(fs.readFileSync(join(prod,'tree/old'),'utf8'),'old');fs.unlinkSync(join(source,'tree/z'));fs.mkdirSync(join(prod,'tree.boss-next'));fs.writeFileSync(join(prod,'tree.boss-next/partial'),'interrupted');replaceTree(join(source,'tree'),join(prod,'tree'),source,prod,true);assert.equal(fs.readFileSync(join(prod,'tree/a'),'utf8'),'new');assert.equal(fs.existsSync(join(prod,'tree.boss-next')),false);});
test('kernel operator lock serializes competing executions and is released after owner fds close',async t=>{const root=fs.mkdtempSync(join(tmpdir(),'boss-activation-fixture-flock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const lock=join(root,'lock'),ready=join(root,'ready');const fd=fs.openSync(lock,'wx',0o600);const child=spawn('/usr/bin/flock',['--nonblock','/proc/self/fd/3',process.execPath,'-e','require("fs").writeFileSync(process.argv[1],"ready");setTimeout(()=>{},500)',ready],{stdio:['ignore','ignore','ignore',fd]});const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});try{for(let i=0;i<100&&!fs.existsSync(ready);i++)await new Promise(r=>setTimeout(r,10));assert.ok(fs.existsSync(ready));assert.throws(()=>execFileSync('/usr/bin/flock',['--nonblock',lock,'/usr/bin/true']));await done;}finally{fs.closeSync(fd);}execFileSync('/usr/bin/flock',['--nonblock',lock,'/usr/bin/true']);});

test('failed stage command persists bounded redacted diagnostics before failed-before-stop receipt', async t => {
  const f = fixture(t); let command;
  const log = f.path('commands.jsonl');
  const record = f.adapter.record;
  f.adapter.record = async r => record({ ...r, command });
  f.adapter.stage = async () => stageCommand('check', () => {
    execFileSync(process.execPath, ['-e', `process.stderr.write('password=fixture-private-value\\nBearer abc.def.ghi\\nTS2345: string | undefined\\n'); process.stdout.write('API_KEY=fixture-private-value'); process.exit(2)`], { stdio: ['ignore','pipe','pipe'] });
  }, value => {
    command = value; appendCommandDiagnostic(log, value);
    const previous = JSON.parse(fs.readFileSync(f.path('receipt')));
    fs.writeFileSync(f.path('receipt'), JSON.stringify({ ...previous, command }));
    assert.equal(JSON.parse(fs.readFileSync(f.path('receipt'))).command.status, value.status);
  });
  const receipt = await activate(f.adapter, f.plan);
  assert.equal(receipt.status, 'failed_before_stop'); assert.equal(f.state.stopCount, 0);
  const saved = JSON.parse(fs.readFileSync(f.path('receipt')));
  assert.equal(JSON.stringify(saved).includes('fixture-private-value'), false);
  assert.equal(saved.command.phase, 'check'); assert.equal(saved.command.exitCode, 2);
  assert.match(saved.command.stderrTail, /TS2345/);
  assert.equal(fs.readFileSync(log, 'utf8').includes('fixture-private-value'), false);
  assert.equal(fs.readFileSync(log, 'utf8').includes('abc.def.ghi'), false);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l).status), ['running', 'failed']);
});
test('command log is append-only bounded, refuses symlinks and redacts credential forms', t => {
  const f = fixture(t), log = f.path('commands');
  const input = 'https://user:password@example.test token="private words" test-api-key\n' + 'x'.repeat(20000);
  assert.ok(redactCommandTail(input).length <= 8192);
  assert.equal(redactCommandTail('password=' + 's'.repeat(20000)), 'password=[REDACTED]');
  assert.equal(redactCommandTail('https://user:password@example.test token="private words" test-api-key').includes('private words'), false);
  for (let i=0;i<100;i++) appendCommandDiagnostic(log, { stderrTail: 'x'.repeat(8192) });
  assert.ok(fs.statSync(log).size <= 256*1024);
  const before=fs.readFileSync(log); appendCommandDiagnostic(log,{stderrTail:'x'.repeat(8192)}); assert.deepEqual(fs.readFileSync(log),before);
  fs.symlinkSync(log,f.path('link')); assert.throws(()=>appendCommandDiagnostic(f.path('link'),{}));
  assert.throws(()=>stageCommand('arbitrary',()=>{},()=>{}),/INVALID_COMMAND_PHASE/);
});

function promotionFixture(t) {
 const root=fs.mkdtempSync(join(tmpdir(),'boss-real-promote-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=join(root,'source'),work=join(root,'work'),prod=join(root,'prod'),sealed=join(root,'sealed'),backupTree=join(root,'backup');
 for(const p of [source,prod,sealed,backupTree])fs.mkdirSync(p);
 const env={PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'};
 const gitCommand=(cwd,args)=>execFileSync('/usr/bin/git',['-c',`safe.directory=${cwd}`,'-c','core.hooksPath=/dev/null',...args],{cwd,env,stdio:['ignore','pipe','pipe']}).toString().trim();
 gitCommand(source,['init','--initial-branch=main']);fs.writeFileSync(join(source,'app'),'old');fs.writeFileSync(join(source,'package.json'),'{}\n');gitCommand(source,['add','.']);gitCommand(source,['commit','-m','base']);
 const base=gitCommand(source,['rev-parse','HEAD']);gitCommand(source,['worktree','add','-b','target',work]);fs.writeFileSync(join(work,'app'),'new');fs.writeFileSync(join(work,'added'),'new-file');gitCommand(work,['add','.']);gitCommand(work,['commit','-m','target']);
 const target=gitCommand(work,['rev-parse','HEAD']),tree=gitCommand(work,['rev-parse','HEAD^{tree}']),bundle=join(root,'source.bundle');
 createSourceBundle(work,target,bundle,gitCommand);
 gitCommand(prod,['init','--initial-branch=main']);gitCommand(prod,['fetch','--no-tags',bundle,base]);gitCommand(prod,['update-ref','refs/heads/main',base]);gitCommand(prod,['reset','--mixed',base]);
 for(const p of [prod,backupTree]){fs.writeFileSync(join(p,'app'),'old');fs.writeFileSync(join(p,'package.json'),'{}\n');fs.mkdirSync(join(p,'node_modules'));fs.writeFileSync(join(p,'node_modules/runtime'),'old-dep');}
 for(const f of ['app','added','package.json'])fs.writeFileSync(join(sealed,f),fs.readFileSync(join(work,f)));
 fs.mkdirSync(join(sealed,'node_modules'));fs.writeFileSync(join(sealed,'node_modules/runtime'),'new-dep');fs.writeFileSync(join(prod,'database'),'preserve-live-writes');
 const affected=['app','added','package.json','node_modules'],prior=affected.map(path=>({path,existed:path!=='added'}));const events=[];
 const trace=(label,fn,detail)=>effectStep(label,fn,event=>events.push(structuredClone(event)),detail);
 const cfg={prod,sealed,bundle,affected,base,target,tree,ref:'refs/heads/main',stopped:()=>{},gitCommand,trace};
 return {root,source,work,prod,sealed,backupTree,base,target,tree,bundle,prior,cfg,gitCommand,env,events};
}
test('real Git tree promotion and dependency-coherent rollback use the same production helpers',t=>{
 const f=promotionFixture(t);promoteTree(f.cfg);
 assert.equal(f.gitCommand(f.prod,['rev-parse','HEAD']),f.target);assert.equal(f.gitCommand(f.prod,['status','--porcelain','--untracked-files=no']),'');assert.equal(fs.readFileSync(join(f.prod,'node_modules/runtime'),'utf8'),'new-dep');
 fs.appendFileSync(join(f.prod,'database'),'\npost-start');
 restoreTree({...f.cfg,backupTree:f.backupTree,prior:f.prior});
 assert.equal(f.gitCommand(f.prod,['rev-parse','HEAD']),f.base);assert.equal(fs.readFileSync(join(f.prod,'app'),'utf8'),'old');assert.equal(fs.existsSync(join(f.prod,'added')),false);assert.equal(fs.readFileSync(join(f.prod,'node_modules/runtime'),'utf8'),'old-dep');assert.match(fs.readFileSync(join(f.prod,'database'),'utf8'),/post-start/);
 assert.deepEqual(f.events.filter(e=>e.status==='succeeded').slice(0,8).map(e=>e.operation),['promote.verify','promote.copy-source','promote.copy-manifest','promote.copy-runtime','promote.fetch','promote.object','promote.cas','promote.reset']);
 assert.equal(JSON.stringify(f.events).includes(f.root),false);
});
test('coder-owned linked-worktree upload fails but exact root-private bundle promotion succeeds',t=>{
 if(process.getuid()!==0){t.skip('Cross-owner linked-worktree regression requires root-owned fixture');return;}
 const f=promotionFixture(t);
 const own=p=>{for(const n of fs.readdirSync(p)){const c=join(p,n);if(fs.lstatSync(c).isDirectory())own(c);else fs.lchownSync(c,995,986);}fs.chownSync(p,995,986);};own(f.source);own(f.work);
 assert.throws(()=>f.gitCommand(f.prod,['ls-remote',f.work,'HEAD']),error=>error.status===128&&String(error.stderr).includes('dubious ownership'));
 fs.unlinkSync(f.bundle);createSourceBundle(f.work,f.target,f.bundle,f.gitCommand);promoteTree(f.cfg);
 assert.equal(f.gitCommand(f.prod,['rev-parse','HEAD']),f.target);assert.equal(fs.statSync(f.bundle).mode&0o777,0o600);
 const bare=join(f.root,'bare');fs.mkdirSync(bare);f.gitCommand(bare,['init','--bare']);f.gitCommand(bare,['fetch','--no-tags',f.bundle,f.target]);f.gitCommand(bare,['update-ref','refs/heads/deployed',f.target,'0'.repeat(40)]);assert.equal(f.gitCommand(bare,['rev-parse','deployed']),f.target);
});
for(const fault of ['copy','fetch','cas','reset'])test(`promotion ${fault} failure persists exact substep and restores private tree`,t=>{
 const f=promotionFixture(t),log=join(f.root,'effects.jsonl');
 const cfg={...f.cfg,trace:(label,fn,detail)=>effectStep(label,fn,event=>{f.events.push(structuredClone(event));appendCommandDiagnostic(log,event);fs.writeFileSync(join(f.root,'latest'),JSON.stringify(event));},detail)};
 if(fault==='copy')cfg.replace=(...args)=>{if(args[1]===join(f.prod,'added')){const e=new Error('private path never logged');e.code='EIO';throw e;}return replaceTree(...args);};
 else cfg.gitCommand=(cwd,args)=>{if((fault==='fetch'&&args[0]==='fetch')||(fault==='cas'&&args[0]==='update-ref')||(fault==='reset'&&args[0]==='reset')){const e=new Error('fixture command');e.status=128;e.stderr=Buffer.from('password=private-fixture\nfatal: exact-fault');throw e;}return f.gitCommand(cwd,args);};
 assert.throws(()=>promoteTree(cfg));const failed=JSON.parse(fs.readFileSync(join(f.root,'latest')));
 assert.equal(failed.status,'failed');assert.equal(failed.operation,fault==='copy'?'promote.copy-source':'promote.'+fault);if(fault==='copy'){assert.equal(failed.category,'source');assert.equal(failed.item,2);assert.equal(failed.completed,1);}else assert.match(failed.stderrTail,/exact-fault/);
 assert.equal(fs.readFileSync(log,'utf8').includes('private-fixture'),false);assert.equal(fs.readFileSync(log,'utf8').includes(f.root),false);
 restoreTree({...f.cfg,backupTree:f.backupTree,prior:f.prior});assert.equal(f.gitCommand(f.prod,['rev-parse','HEAD']),f.base);assert.equal(fs.readFileSync(join(f.prod,'node_modules/runtime'),'utf8'),'old-dep');
});
test('broad effect phase records before and after failure and keeps main failure through rollback',async t=>{
 const f=fixture(t,['promote']);const events=[];f.adapter.effect=(name,fn)=>effectPhase(name,fn,event=>events.push(event));
 const r=await activate(f.adapter,f.plan);assert.equal(r.status,'rolled_back');assert.equal(events.find(e=>e.status==='failed').operation,'promote');assert.ok(events.some(e=>e.operation==='rollback.restore'&&e.status==='succeeded'));assert.ok(events.some(e=>e.operation==='final-snapshot'&&e.status==='running'));assert.equal(JSON.stringify(events).includes('fixture-private-value'),false);
});

for (const recovering of [false,true]) test(`diagnostic disk failure cannot gate ${recovering ? 'recovery' : 'rollback'} or fence stop`,async t=>{
 const f=fixture(t,['health','health-prior']);let diskFailed=false;
 const record=f.adapter.record;f.adapter.record=async r=>{if(diskFailed)throw Error('ENOSPC');return record(r);};
 f.adapter.effect=(name,fn,options)=>effectPhase(name,fn,()=>{if(diskFailed)throw Error('ENOSPC');},options);
 if(recovering){await activate({...f.adapter,effect:undefined},f.plan);f.state.running=true;f.adapter.loadRecovery=async()=>({phases:['promote'],target:f.target});}
 const stop=f.adapter.stop;f.adapter.stop=async()=>{await stop();};
 if(recovering)diskFailed=true;else{const restart=f.adapter.restart;f.adapter.restart=async()=>{await restart();diskFailed=true;};}
 await assert.rejects(recovering?recover(f.adapter):activate(f.adapter,f.plan),/ENOSPC/);
 assert.equal(f.state.running,false);assert.ok(f.calls.includes('restore'));assert.ok(f.calls.includes('health-prior'));assert.ok(fs.existsSync(f.path('lock')));assert.ok(f.state.stopCount>=3);
});
test('safety diagnostic phase preserves actual effect errors and ignores only telemetry errors',async()=>{
 let invoked=false;await effectPhase('rollback.stop',async()=>{invoked=true;},()=>{throw Error('ENOSPC');},{safety:true});assert.equal(invoked,true);
 await assert.rejects(effectPhase('rollback.stop',async()=>{throw Error('STOP_FAILED');},()=>{throw Error('ENOSPC');},{safety:true}),/STOP_FAILED/);
 invoked=false;await assert.rejects(effectPhase('promote',async()=>{invoked=true;},()=>{throw Error('ENOSPC');}),/ENOSPC/);assert.equal(invoked,false);
});
