/** Root-admitted CI outputs. GitHub verification is performed by the trusted SSH operator,
 * never by the candidate or a chat-tool argument. No archive extractor or remote code runs here.
 * Verified-CI deliberately preserves EVERY protectedCompiledPaths module (including origin,
 * audience, agent/transport/runtime guards). Their source/toolchain upgrades require explicit
 * root maintenance; the older local builder's narrower source matcher is not CI authority. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuilderJob } from './db/builder-jobs.js';
import type { ReleasePlan } from './builder-deployment.js';

export const ciOutputRoots = ['packages/shared/dist', 'packages/backend/dist', 'packages/frontend/build', 'packages/phone/dist'] as const;
export const ciGates = [
  { name:'shared-build', command:['npm','run','build','--workspace=packages/shared'], exitCode:0 },
  { name:'checks', command:['npm','run','check'], exitCode:0 },
  { name:'build', command:['npm','run','build'], exitCode:0 },
  { name:'tests', command:['npm','run','test'], exitCode:0 },
] as const;
export const ciLimits = { packageBytes:192*1024*1024, decodedBytes:128*1024*1024, fileBytes:32*1024*1024, files:20_000 };
export interface CIGateway {url:string;credentialFile:string;timeoutMs:number;}
export type CIConfig = { mode:'local' } | { mode:'verified-ci'; inbox:string; repositoryId:string; workflowPath:string; workflowCommit:string; gateway?:CIGateway };
export interface CIRuntime { node:string; modules:string; platform:string; arch:string; glibc:string; npm:string; }
export interface CIWorkflow { repositoryId:string; path:string; commit:string; runId:string; runAttempt:number; }
export interface CISource { commit:string; base:string; tree:string; lockSha256:string; baselineManifestSha256:string; native:string[]; }
export interface CIFile { path:string; mode:'0644'; bytes:number; sha256:string; base64:string; }
export interface CIPackage { schema:1; roots:readonly string[]; source:CISource; runtime:CIRuntime; workflow:CIWorkflow; gates:typeof ciGates; files:CIFile[]; }
export interface CIReceipt { schema:1; jobId:string; owner:{thread:string;session:string;audience:'owner'}; planSha256:string; source:CISource; workflow:CIWorkflow & {artifactId:string; artifactSha256:string; packageSha256:string}; }
export interface CIPin { schema:1; receiptSha256:string; packageSha256:string; bundleSha256:string; policySha256:string; artifactSha256:string; runId:string; runAttempt:number; }
export interface CIExpected { config:Extract<CIConfig,{mode:'verified-ci'}>; plan:ReleasePlan; job:BuilderJob; baselineManifest:Buffer; runtime:CIRuntime; }
export interface VerifiedCI { payload:CIPackage; receipt:CIReceipt; packageBytes:Buffer; receiptBytes:Buffer; }
export const ciSha = (data:string|Buffer) => createHash('sha256').update(data).digest('hex');
const policySha = () => ciSha(readFileSync(fileURLToPath(import.meta.url)));
const hex = (value:unknown) => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const objectId = (value:unknown) => typeof value==='string' && /^[a-f0-9]{40,64}$/.test(value);
const decimal = (value:unknown) => typeof value==='string' && /^[1-9][0-9]{0,24}$/.test(value);
function keys(value:unknown, names:string[], label:string): asserts value is Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join('\0')!==[...names].sort().join('\0')) throw Error(`Invalid CI ${label} schema`);
}
function same(actual:unknown, expected:unknown, label:string):void {
  const canonical=(v:unknown):unknown => Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
  if(JSON.stringify(canonical(actual))!==JSON.stringify(canonical(expected))) throw Error(`CI ${label} mismatch`);
}
function safePath(path:unknown):asserts path is string {
  if(typeof path!=='string' || !path || isAbsolute(path) || /[\x00-\x1f\x7f\\]/.test(path) || path.split('/').some(p=>!p||p==='.'||p==='..')) throw Error('Unsafe CI file path');
}
function privateDirectory(path:string):void {
  if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path) throw Error('Unsafe CI directory');
  let cursor=path;
  while(true){const st=lstatSync(cursor);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||((st.mode&0o022)!==0&&!(st.mode&0o1000)))throw Error('Unsafe CI directory ancestor');if(cursor===path&&(st.mode&0o077))throw Error('CI directory must be root-private');if(dirname(cursor)===cursor)break;cursor=dirname(cursor);}
}
function privateBytes(path:string,max:number):Buffer {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {const st=fstatSync(fd);if(!st.isFile()||st.uid!==0||st.nlink!==1||(st.mode&0o777)!==0o600||st.size>max)throw Error('Unsafe CI evidence file');return readFileSync(fd);}finally{closeSync(fd);}
}
function writeExclusive(path:string,bytes:Buffer):void {
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
}
export function ciConfiguration(builderRoot:string,env=process.env):CIConfig {
  const mode=env.BYTELIGHT_BUILDER_PREPARE_MODE??'local';
  if(mode==='local')return {mode};
  if(mode!=='verified-ci')throw Error('Invalid builder preparation mode');
  const inbox=env.BYTELIGHT_BUILDER_CI_INBOX||join(builderRoot,'ci-inbox');
  const repositoryId=env.BYTELIGHT_BUILDER_CI_REPOSITORY_ID||'',workflowPath=env.BYTELIGHT_BUILDER_CI_WORKFLOW_PATH||'',workflowCommit=env.BYTELIGHT_BUILDER_CI_WORKFLOW_COMMIT||'';
  if(!decimal(repositoryId)||!objectId(workflowCommit)||!/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(workflowPath))throw Error('Pinned CI repository and workflow required');
  privateDirectory(inbox);
  let gateway:CIGateway|undefined;
  if(env.BYTELIGHT_BUILDER_CI_GATEWAY_URL!==undefined){
    gateway={url:env.BYTELIGHT_BUILDER_CI_GATEWAY_URL,credentialFile:env.BYTELIGHT_BUILDER_CI_GATEWAY_CREDENTIAL_FILE||'',timeoutMs:Number(env.BYTELIGHT_BUILDER_CI_TIMEOUT_MS??45*60_000)};validateGateway(gateway);gatewayAuthorization(gateway);
  }else if(env.BYTELIGHT_BUILDER_CI_TIMEOUT_MS!==undefined||env.BYTELIGHT_BUILDER_CI_GATEWAY_CREDENTIAL_FILE!==undefined)throw Error('CI timeout/credential requires an explicit trusted gateway');
  return {mode,inbox,repositoryId,workflowPath,workflowCommit,...(gateway?{gateway}:{})};
}
function validateGateway(gateway:CIGateway):void {
  let url:URL;try{url=new URL(gateway.url);}catch{throw Error('Invalid trusted CI gateway');}
  if(url.protocol!=='https:'||url.hostname!=='api.letta.com'||url.port||url.username||url.password||url.search||url.hash||!/^\/v1\/agent-webhooks\/[A-Za-z0-9_-]{10,}$/.test(url.pathname)||!Number.isSafeInteger(gateway.timeoutMs)||gateway.timeoutMs<5_000||gateway.timeoutMs>60*60_000)throw Error('Invalid trusted CI gateway');
}
function gatewayAuthorization(gateway:CIGateway):string {
  try{
    const path=gateway.credentialFile;if(!isAbsolute(path)||resolve(path)!==path)throw Error('Invalid credential path');privateDirectory(dirname(path));
    const data=JSON.parse(privateBytes(path,16*1024).toString('utf8')),header:unknown=data.authorization_header;
    if(typeof header!=='string'||header.length>4096||!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(header))throw Error('Invalid Basic credential');
    const encoded=header.slice(6),bytes=Buffer.from(encoded,'base64'),colon=bytes.indexOf(0x3a);if(bytes.toString('base64')!==encoded||colon<0||bytes.length<=1||bytes.includes(0)||bytes.includes(10)||bytes.includes(13))throw Error('Invalid Basic credential');
    return header;
  }catch{throw Error('Trusted private CI gateway credential required');}
}
/** Capability URL is root configuration only. Never log it or accept response authority. */
export async function notifyCIGateway(gateway:CIGateway,event:{jobId:string;releaseId:string},send:typeof fetch=fetch):Promise<void> {
  validateGateway(gateway);
  const authorization=gatewayAuthorization(gateway);
  if(!/^[a-f0-9]{32}$/.test(event.jobId)||!/^[a-f0-9]{64}$/.test(event.releaseId))throw Error('Invalid CI notification identity');
  try{
    const response=await send(gateway.url,{method:'POST',headers:{'content-type':'application/json',authorization},body:JSON.stringify({schema:1,kind:'virelle-ci-prepare',jobId:event.jobId,releaseId:event.releaseId}),redirect:'error',signal:AbortSignal.timeout(Math.min(10_000,gateway.timeoutMs))});
    if(!response.ok)throw Error('CI notification not acknowledged');
    await response.body?.cancel();
  }catch{throw Error('CI gateway notification uncertain; verify immutable evidence instead of replaying');}
}
export const ciFailureReasons=['ci_failed','ci_cancelled','ci_timed_out','ci_start_failed','artifact_invalid','gateway_failed'] as const;
/** Only the root operator can publish a terminal marker; malformed signals fail closed. */
export function assertNoCIFailure(config:Extract<CIConfig,{mode:'verified-ci'}>,event:{jobId:string;releaseId:string;commit:string}):void {
  if(!/^[a-f0-9]{32}$/.test(event.jobId)||!/^[a-f0-9]{64}$/.test(event.releaseId)||!objectId(event.commit))throw Error('Invalid CI failure association');
  let marker:unknown;
  try{privateDirectory(config.inbox);const dir=join(config.inbox,'failures');privateDirectory(dir);marker=JSON.parse(privateBytes(join(dir,event.releaseId+'.json'),16*1024).toString('utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  const optional=marker&&typeof marker==='object'&&Object.hasOwn(marker,'runId')?['runId']:[];
  keys(marker,['schema','jobId','releaseId','commit','reason',...optional],'failure marker');
  if(marker.schema!==1||marker.jobId!==event.jobId||marker.releaseId!==event.releaseId||marker.commit!==event.commit||!ciFailureReasons.includes(marker.reason as typeof ciFailureReasons[number])||(optional.length&&!decimal(marker.runId)))throw Error('CI failure marker association/schema mismatch');
  throw Error('Verified CI terminal failure: '+marker.reason);
}
export function expectedCISource(expected:CIExpected):CISource {
  const {plan}=expected;
  if(!plan.paths.includes('package-lock.json'))throw Error('Verified CI requires a committed lockfile');
  return {commit:plan.commit,base:plan.base,tree:plan.tree,lockSha256:ciSha(plan.lock),baselineManifestSha256:ciSha(expected.baselineManifest),native:[...plan.native].sort()};
}
function workflow(value:unknown,expected:CIExpected):asserts value is CIWorkflow {
  keys(value,['repositoryId','path','commit','runId','runAttempt'],'workflow');
  const cfg=expected.config;
  if(value.repositoryId!==cfg.repositoryId||value.path!==cfg.workflowPath||value.commit!==cfg.workflowCommit||!decimal(value.runId)||!Number.isSafeInteger(value.runAttempt)||(value.runAttempt as number)<1)throw Error('CI workflow identity mismatch');
}
/** Pure data validation, also used before publishing the immutable root inbox entry. */
export function validateCIPackage(value:unknown,expected:CIExpected):asserts value is CIPackage {
  keys(value,['schema','roots','source','runtime','workflow','gates','files'],'package');
  if(value.schema!==1)throw Error('Unsupported CI package version');
  same(value.roots,ciOutputRoots,'output roots');same(value.source,expectedCISource(expected),'source identity');
  same(value.runtime,expected.runtime,'target runtime');workflow(value.workflow,expected);same(value.gates,ciGates,'complete mandatory gates');
  if(!Array.isArray(value.files)||!value.files.length||value.files.length>ciLimits.files)throw Error('CI file-count limit');
  const seen=new Set<string>(),parents=new Set<string>(),populated=new Set<string>();let bytes=0;
  for(const file of value.files){
    keys(file,['path','mode','bytes','sha256','base64'],'file');safePath(file.path);
    const relativePath=file.path;const root=ciOutputRoots.find(root=>relativePath.startsWith(root+'/'));if(!root)throw Error('CI file outside compiled roots');
    if(seen.has(file.path)||parents.has(file.path))throw Error('Duplicate/colliding CI path');
    let parent=dirname(file.path);while(parent!=='.'){if(seen.has(parent))throw Error('CI file/directory collision');parents.add(parent);parent=dirname(parent);}
    if(file.mode!=='0644'||!Number.isSafeInteger(file.bytes)||(file.bytes as number)<0||(file.bytes as number)>ciLimits.fileBytes||!hex(file.sha256)||typeof file.base64!=='string'||file.base64.length>Math.ceil(ciLimits.fileBytes/3)*4)throw Error('Invalid CI file metadata');
    if(/(?:^|\/)(?:node_modules|\.git|\.ssh|\.npmrc|\.env(?:\.[^/]*)?|bytelight\.ya?ml|auth\.json|credentials(?:\.[^/]*)?|memory-vault|vault)(?:\/|$)|\.(?:node|so(?:\.[0-9]+)*|dll|dylib|exe|a|o)$/i.test(file.path))throw Error('CI native/dependency/private payload forbidden');
    const decoded=Buffer.from(file.base64,'base64');
    if(decoded.toString('base64')!==file.base64||decoded.length!==file.bytes||ciSha(decoded)!==file.sha256)throw Error('CI file bytes/hash mismatch');
    if(decoded.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))||decoded.subarray(0,2).toString()==='MZ'||['feedface','feedfacf','cefaedfe','cffaedfe','cafebabe'].includes(decoded.subarray(0,4).toString('hex')))throw Error('CI native executable bytes forbidden');
    bytes+=decoded.length;if(bytes>ciLimits.decodedBytes)throw Error('CI decoded-byte limit');seen.add(file.path);populated.add(root);
  }
  if(populated.size!==ciOutputRoots.length)throw Error('CI output root missing');
}
export function validateCIReceipt(value:unknown,payload:CIPackage,packageBytes:Buffer,expected:CIExpected):asserts value is CIReceipt {
  keys(value,['schema','jobId','owner','planSha256','source','workflow'],'receipt');
  if(value.schema!==1||value.jobId!==expected.job.id||value.planSha256!==ciSha(JSON.stringify(expected.plan)))throw Error('CI job/admitted plan mismatch');
  same(value.owner,{thread:expected.job.ownerThread,session:expected.job.ownerSession,audience:'owner'},'owner provenance');same(value.source,expectedCISource(expected),'receipt source');
  keys(value.workflow,['repositoryId','path','commit','runId','runAttempt','artifactId','artifactSha256','packageSha256'],'receipt workflow');
  const {artifactId,artifactSha256,packageSha256,...run}=value.workflow;
  same(run,payload.workflow,'receipt run/attempt');
  if(!decimal(artifactId)||!hex(artifactSha256)||packageSha256!==ciSha(packageBytes))throw Error('CI artifact/package digest mismatch');
}
export function loadAdmittedCI(expected:CIExpected):VerifiedCI {
  const {config,job}=expected;if(!/^[a-f0-9]{32}$/.test(job.id))throw Error('Invalid CI job id');
  privateDirectory(config.inbox);const dir=join(config.inbox,job.id);privateDirectory(dir);
  const packageBytes=privateBytes(join(dir,'package.json'),ciLimits.packageBytes),receiptBytes=privateBytes(join(dir,'receipt.json'),64*1024);
  const payload:unknown=JSON.parse(packageBytes.toString('utf8'));validateCIPackage(payload,expected);
  const receipt:unknown=JSON.parse(receiptBytes.toString('utf8'));validateCIReceipt(receipt,payload,packageBytes,expected);
  return {payload,receipt,packageBytes,receiptBytes};
}
/** Evidence becomes release-local and cannot be affected by later inbox pruning. */
export function freezeCIProof(dir:string,ci:VerifiedCI,bundleSha256:string):CIPin {
  privateDirectory(dir);if(!hex(bundleSha256))throw Error('CI proof needs sealed local bundle');
  writeExclusive(join(dir,'ci-package.json'),ci.packageBytes);writeExclusive(join(dir,'ci-receipt.json'),ci.receiptBytes);
  return {schema:1,receiptSha256:ciSha(ci.receiptBytes),packageSha256:ciSha(ci.packageBytes),bundleSha256,policySha256:policySha(),artifactSha256:ci.receipt.workflow.artifactSha256,runId:ci.payload.workflow.runId,runAttempt:ci.payload.workflow.runAttempt};
}
export function verifyFrozenCI(dir:string,pin:CIPin,bundleSha256:string):void {
  keys(pin,['schema','receiptSha256','packageSha256','bundleSha256','policySha256','artifactSha256','runId','runAttempt'],'proof pin');
  if(pin.schema!==1||pin.bundleSha256!==bundleSha256||pin.policySha256!==policySha()||![pin.receiptSha256,pin.packageSha256,pin.artifactSha256].every(hex)||!decimal(pin.runId)||!Number.isSafeInteger(pin.runAttempt)||pin.runAttempt<1)throw Error('CI proof pin mismatch');
  privateDirectory(dir);
  if(ciSha(privateBytes(join(dir,'ci-package.json'),ciLimits.packageBytes))!==pin.packageSha256||ciSha(privateBytes(join(dir,'ci-receipt.json'),64*1024))!==pin.receiptSha256)throw Error('Frozen CI proof changed');
}
/** Only data files in fresh fixed roots, with no archive formats or destination links. */
export function importCIOutputs(stage:string,ci:VerifiedCI):void {
  if(realpathSync(stage)!==stage||!lstatSync(stage).isDirectory())throw Error('Unsafe CI stage');
  for(const root of ciOutputRoots){let parent=stage;for(const part of root.split('/').slice(0,-1)){parent=join(parent,part);const st=lstatSync(parent);if(!st.isDirectory()||st.isSymbolicLink())throw Error('Unsafe CI destination ancestor');}
    const target=join(stage,root);try{lstatSync(target);throw Error('CI output destination exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}mkdirSync(target,{mode:0o755});}
  for(const file of ci.payload.files){const target=join(stage,file.path);mkdirSync(dirname(target),{recursive:true,mode:0o755});const fd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);try{writeFileSync(fd,Buffer.from(file.base64,'base64'));}finally{closeSync(fd);}}
}
/** New coordinator code may only arrive by explicit root maintenance, never CI artifacts. */
export function assertCIProtectedBytes(stage:string,production:string,paths:string[]):void {
  for(const path of paths){safePath(path);const trusted=join(production,path),candidate=join(stage,path);
    for(const root of [production,stage]){let cursor=root;for(const part of path.split('/')){cursor=join(cursor,part);const st=lstatSync(cursor);if(st.isSymbolicLink())throw Error('CI protected ancestor is a symlink');}}
    const a=lstatSync(trusted),b=lstatSync(candidate);
    if(!a.isFile()||a.uid!==0||a.nlink!==1||(a.mode&0o022)||!b.isFile()||b.uid!==0||b.nlink!==1||(a.mode&0o777)!==(b.mode&0o777)||!readFileSync(trusted).equals(readFileSync(candidate)))throw Error(`CI protected compiled bytes changed: ${path}`);
  }
}
