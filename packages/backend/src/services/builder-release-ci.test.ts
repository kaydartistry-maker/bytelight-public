import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, chownSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { assertCIProtectedBytes, assertNoCIFailure, ciConfiguration, ciGates, ciLimits, ciOutputRoots, ciSha, expectedCISource, freezeCIProof, importCIOutputs, loadAdmittedCI, notifyCIGateway, validateCIPackage, validateCIReceipt, verifyFrozenCI, type CIExpected, type CIPackage, type CIReceipt, type VerifiedCI } from './builder-release-ci.js';
const rootFixture={skip:process.getuid?.()!==0?'Root-owned inbox fixture requires root':false};

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'ci-import-test-')),inbox=join(root,'inbox'),dir=join(inbox,'a'.repeat(32)),stage=join(root,'stage');
 mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(inbox,0o700);mkdirSync(stage);
 for(const name of ['shared','backend','frontend','phone'])mkdirSync(join(stage,'packages',name),{recursive:true});
 const expected:CIExpected={config:{mode:'verified-ci',inbox,repositoryId:'123',workflowPath:'.github/workflows/validate.yml',workflowCommit:'b'.repeat(40)},job:{id:'a'.repeat(32),ownerThread:'owner-thread',ownerSession:'owner-turn'} as CIExpected['job'],plan:{commit:'c'.repeat(40),base:'d'.repeat(40),tree:'e'.repeat(40),paths:['package-lock.json'],changed:['app.ts'],migrations:[],native:['better-sqlite3@11.10.0'],lock:'{"lockfileVersion":3}'},baselineManifest:Buffer.from('{"allowScripts":{"better-sqlite3@11.10.0":true}}'),runtime:{node:process.version,modules:process.versions.modules,platform:process.platform,arch:process.arch,glibc:'2.39',npm:'10.9.9'}};
 const payload:CIPackage={schema:1,roots:ciOutputRoots,source:expectedCISource(expected),runtime:expected.runtime,workflow:{repositoryId:'123',path:'.github/workflows/validate.yml',commit:'b'.repeat(40),runId:'456',runAttempt:2},gates:ciGates,files:ciOutputRoots.map(path=>({path:path+'/index.js',mode:'0644',bytes:1,sha256:ciSha('x'),base64:Buffer.from('x').toString('base64')}))};
 const receipt=():CIReceipt=>({schema:1,jobId:expected.job.id,owner:{thread:'owner-thread',session:'owner-turn',audience:'owner'},planSha256:ciSha(JSON.stringify(expected.plan)),source:payload.source,workflow:{...payload.workflow,artifactId:'789',artifactSha256:'f'.repeat(64),packageSha256:ciSha(JSON.stringify(payload))}});
 const publish=()=>{writeFileSync(join(dir,'package.json'),JSON.stringify(payload),{mode:0o600});writeFileSync(join(dir,'receipt.json'),JSON.stringify(receipt()),{mode:0o600});};
 const verified=():VerifiedCI=>({payload,receipt:receipt(),packageBytes:Buffer.from(JSON.stringify(payload)),receiptBytes:Buffer.from(JSON.stringify(receipt()))});
 const credentialFile=join(root,'gateway.json');writeFileSync(credentialFile,JSON.stringify({security_key:'fixture-only',authorization_header:'Basic '+Buffer.from('fixture:fixture-only').toString('base64')}),{mode:0o600});
 return {root,inbox,dir,stage,credentialFile,expected,payload,receipt,publish,verified,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('CI mode is default-off and unknown modes fail closed',()=>{
 assert.deepEqual(ciConfiguration('/ignored',{}),{mode:'local'});assert.throws(()=>ciConfiguration('/ignored',{BYTELIGHT_BUILDER_PREPARE_MODE:'pretend'}));
 assert.throws(()=>ciConfiguration('/ignored',{BYTELIGHT_BUILDER_PREPARE_MODE:'verified-ci'}),/Pinned/);
});
test('trusted gateway sends only sealed release identity and never accepts response authority',rootFixture,async()=>{const f=fixture();try{
 let calls=0,body='';await notifyCIGateway({url:'https://api.letta.com/v1/agent-webhooks/opaque-capability',credentialFile:f.credentialFile,timeoutMs:5000},{jobId:'a'.repeat(32),releaseId:'b'.repeat(64)},(async(_url,options)=>{calls++;body=String(options?.body);assert.equal(options?.redirect,'error');assert.equal(new Headers(options?.headers).get('authorization'),'Basic '+Buffer.from('fixture:fixture-only').toString('base64'));return {ok:true,body:null} as Response}) as typeof fetch);
 assert.equal(calls,1);assert.deepEqual(JSON.parse(body),{schema:1,kind:'virelle-ci-prepare',jobId:'a'.repeat(32),releaseId:'b'.repeat(64)});
}finally{f.cleanup()}
});
test('gateway URL, timeout and identity are fixed, failures redact capability and never retry',rootFixture,async()=>{const f=fixture();try{
 for(const url of ['http://api.letta.com/v1/agent-webhooks/opaque-capability','https://example.com/callback','https://api.letta.com/v1/agent-webhooks/opaque-capability?token=private','https://user:pass@api.letta.com/v1/agent-webhooks/opaque-capability'])await assert.rejects(notifyCIGateway({url,credentialFile:f.credentialFile,timeoutMs:5000},{jobId:'a'.repeat(32),releaseId:'b'.repeat(64)}),/trusted/);
 let calls=0;await assert.rejects(notifyCIGateway({url:'https://api.letta.com/v1/agent-webhooks/opaque-capability',credentialFile:f.credentialFile,timeoutMs:5000},{jobId:'a'.repeat(32),releaseId:'b'.repeat(64)},(async()=>{calls++;throw Error('SECRET opaque-capability')}) as typeof fetch),e=>/uncertain/.test(String(e))&&!/SECRET|opaque-capability/.test(String(e)));assert.equal(calls,1);
}finally{f.cleanup()}
});
test('decoded output limit is enforced across individually valid files',()=>{const f=fixture(),old=ciLimits.decodedBytes;try{ciLimits.decodedBytes=3;assert.throws(()=>validateCIPackage(f.payload,f.expected),/decoded-byte/)}finally{ciLimits.decodedBytes=old;f.cleanup()}});
test('gateway activation requires root-private credential file with canonical Basic header',rootFixture,async()=>{const f=fixture();try{
 const gateway={url:'https://api.letta.com/v1/agent-webhooks/opaque-capability',credentialFile:f.credentialFile,timeoutMs:5000};const event={jobId:'a'.repeat(32),releaseId:'b'.repeat(64)};
 chmodSync(f.credentialFile,0o644);await assert.rejects(notifyCIGateway(gateway,event),/private CI gateway credential/);chmodSync(f.credentialFile,0o600);
 for(const header of ['Bearer private','Basic invalid','Basic '+Buffer.from('no-colon').toString('base64'),'Basic '+Buffer.from(':').toString('base64'),'Basic '+Buffer.from('user:password\n').toString('base64')]){writeFileSync(f.credentialFile,JSON.stringify({authorization_header:header}));await assert.rejects(notifyCIGateway(gateway,event),/private CI gateway credential/);}
 for(const raw of [':fixture-secret','fixture-secret:']){writeFileSync(f.credentialFile,JSON.stringify({authorization_header:'Basic '+Buffer.from(raw).toString('base64')}));await notifyCIGateway(gateway,event,(async()=>({ok:true,body:null} as Response)) as typeof fetch);}
 await assert.rejects(notifyCIGateway({...gateway,credentialFile:''},event),/private CI gateway credential/);
}finally{f.cleanup()}});
test('root terminal failure markers bind job/release/source and never accept free-form reasons',rootFixture,()=>{const f=fixture();try{
 const event={jobId:f.expected.job.id,releaseId:'1'.repeat(64),commit:f.expected.plan.commit},dir=join(f.inbox,'failures');assertNoCIFailure(f.expected.config,event);mkdirSync(dir,{mode:0o700});const path=join(dir,event.releaseId+'.json');
 const marker={schema:1,...event,reason:'ci_cancelled',runId:'123'};writeFileSync(path,JSON.stringify(marker),{mode:0o600});assert.throws(()=>assertNoCIFailure(f.expected.config,event),/terminal failure: ci_cancelled/);
 for(const altered of [{...marker,jobId:'2'.repeat(32)},{...marker,commit:'2'.repeat(40)},{...marker,reason:'raw arbitrary failure message'},{...marker,runId:'not-an-id'}]){writeFileSync(path,JSON.stringify(altered));assert.throws(()=>assertNoCIFailure(f.expected.config,event),/association\/schema/);}
 chmodSync(path,0o644);assert.throws(()=>assertNoCIFailure(f.expected.config,event),/Unsafe CI evidence/);
}finally{f.cleanup()}});
test('valid regular-file-only package imports exactly four roots and retains local dependencies',rootFixture,()=>{const f=fixture();try{
 validateCIPackage(f.payload,f.expected);f.publish();const ci=loadAdmittedCI(f.expected);
 mkdirSync(join(f.stage,'node_modules'));writeFileSync(join(f.stage,'node_modules/local.node'),'target ABI');importCIOutputs(f.stage,ci);
 for(const root of ciOutputRoots)assert.equal(readFileSync(join(f.stage,root,'index.js'),'utf8'),'x');
 assert.equal(readFileSync(join(f.stage,'node_modules/local.node'),'utf8'),'target ABI');
}finally{f.cleanup()}});
for(const kind of ['wrong-commit','wrong-base','wrong-tree','wrong-lock','wrong-baseline-policy','wrong-native','wrong-workflow','wrong-run','wrong-attempt','wrong-runtime','missing-gate','failed-gate','wrong-command','unknown-field'] as const)test(`CI rejects ${kind}`,()=>{const f=fixture();try{
 const p=JSON.parse(JSON.stringify(f.payload));
 if(kind==='wrong-commit')p.source.commit='a'.repeat(40);if(kind==='wrong-base')p.source.base='a'.repeat(40);if(kind==='wrong-tree')p.source.tree='a'.repeat(40);if(kind==='wrong-lock')p.source.lockSha256='a'.repeat(64);if(kind==='wrong-baseline-policy')p.source.baselineManifestSha256='a'.repeat(64);if(kind==='wrong-native')p.source.native=[];
 if(kind==='wrong-workflow')p.workflow.commit='a'.repeat(40);if(kind==='wrong-run')p.workflow.runId='not-an-id';if(kind==='wrong-attempt')p.workflow.runAttempt=0;if(kind==='wrong-runtime')p.runtime.modules='wrong';
 if(kind==='missing-gate')p.gates.pop();if(kind==='failed-gate')p.gates[3].exitCode=1;if(kind==='wrong-command')p.gates[0].command=['npm','echo','success'];if(kind==='unknown-field')p.authorized=true;
 assert.throws(()=>validateCIPackage(p,f.expected));
}finally{f.cleanup()}});
for(const kind of ['traversal','absolute','backslash','control','outside','duplicate','collision','native-extension','native-magic','base64','hash','bytes','mode','oversized-file','file-count','missing-root','link-schema'] as const)test(`CI rejects artifact ${kind}`,()=>{const f=fixture();try{
 const p=JSON.parse(JSON.stringify(f.payload)),file=p.files[0];
 if(kind==='traversal')file.path='packages/shared/dist/../escape';if(kind==='absolute')file.path='/tmp/escape';if(kind==='backslash')file.path='packages/shared/dist/a\\b';if(kind==='control')file.path+='\n';if(kind==='outside')file.path='packages/backend/src/agent.ts';
 if(kind==='duplicate')p.files.push({...file});if(kind==='collision')p.files.push({...file,path:file.path+'/child'});if(kind==='native-extension')file.path='packages/shared/dist/inject.node';
 if(kind==='native-magic'){const b=Buffer.from([0x7f,0x45,0x4c,0x46]);file.base64=b.toString('base64');file.bytes=b.length;file.sha256=ciSha(b)}
 if(kind==='base64')file.base64+='\n';if(kind==='hash')file.sha256='a'.repeat(64);if(kind==='bytes')file.bytes=2;if(kind==='mode')file.mode='4755';if(kind==='oversized-file')file.bytes=ciLimits.fileBytes+1;if(kind==='file-count')p.files=Array(ciLimits.files+1).fill(file);if(kind==='missing-root')p.files.pop();if(kind==='link-schema')file.link='/etc/passwd';
 assert.throws(()=>validateCIPackage(p,f.expected));
}finally{f.cleanup()}});
for(const field of ['job','owner','plan','package','artifact','attempt'] as const)test(`receipt binds ${field}`,()=>{const f=fixture();try{
 const r=f.receipt();if(field==='job')r.jobId='b'.repeat(32);if(field==='owner')r.owner.thread='other';if(field==='plan')r.planSha256='a'.repeat(64);if(field==='package')r.workflow.packageSha256='a'.repeat(64);if(field==='artifact')r.workflow.artifactSha256='not-a-digest';if(field==='attempt')r.workflow.runAttempt++;
 assert.throws(()=>validateCIReceipt(r,f.payload,Buffer.from(JSON.stringify(f.payload)),f.expected));
}finally{f.cleanup()}});
for(const kind of ['mode','symlink','hardlink','owner','inbox-symlink'] as const)test(`root inbox rejects ${kind}`,rootFixture,()=>{const f=fixture();try{
 f.publish();const p=join(f.dir,'package.json');if(kind==='mode')chmodSync(p,0o644);if(kind==='symlink'){rmSync(p);symlinkSync(join(f.dir,'receipt.json'),p)}if(kind==='hardlink')linkSync(p,join(f.dir,'duplicate'));if(kind==='owner'){if(process.getuid?.()!==0)return;chownSync(p,65534,65534)}if(kind==='inbox-symlink'){const alias=join(f.root,'alias');symlinkSync(f.inbox,alias);f.expected.config.inbox=alias;}
 assert.throws(()=>loadAdmittedCI(f.expected));
}finally{f.cleanup()}});
test('release-local evidence survives inbox removal and detects tampering, policy/bundle mismatch',rootFixture,()=>{const f=fixture();try{
 f.publish();const ci=loadAdmittedCI(f.expected),release=join(f.root,'release');mkdirSync(release,{mode:0o700});const pin=freezeCIProof(release,ci,'1'.repeat(64));rmSync(f.inbox,{recursive:true});verifyFrozenCI(release,pin,'1'.repeat(64));
 assert.throws(()=>verifyFrozenCI(release,pin,'2'.repeat(64)));assert.throws(()=>verifyFrozenCI(release,{...pin,policySha256:'2'.repeat(64)},'1'.repeat(64)));
 writeFileSync(join(release,'ci-receipt.json'),'tampered');assert.throws(()=>verifyFrozenCI(release,pin,'1'.repeat(64)));assert.throws(()=>freezeCIProof(release,ci,'1'.repeat(64)),/EEXIST/);
}finally{f.cleanup()}});
test('compiled output import refuses retained roots and symlink ancestors',()=>{const f=fixture();try{
 mkdirSync(join(f.stage,ciOutputRoots[0]));assert.throws(()=>importCIOutputs(f.stage,f.verified()),/exists/);rmSync(join(f.stage,ciOutputRoots[0]),{recursive:true});
 rmSync(join(f.stage,'packages/shared'),{recursive:true});symlinkSync(f.root,join(f.stage,'packages/shared'));assert.throws(()=>importCIOutputs(f.stage,f.verified()),/ancestor/);
}finally{f.cleanup()}});
test('protected compiled coordinator bytes must match installed root-owned bytes',rootFixture,()=>{const f=fixture();try{
 const prod=join(f.root,'production'),p='packages/backend/dist/coordinator.js';mkdirSync(dirname(join(prod,p)),{recursive:true});mkdirSync(dirname(join(f.stage,p)),{recursive:true});writeFileSync(join(prod,p),'trusted');writeFileSync(join(f.stage,p),'trusted');assertCIProtectedBytes(f.stage,prod,[p]);
 writeFileSync(join(f.stage,p),'candidate override');assert.throws(()=>assertCIProtectedBytes(f.stage,prod,[p]),/protected compiled/);assert.equal(readFileSync(join(prod,p),'utf8'),'trusted');
}finally{f.cleanup()}});
