import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { chmodSync, chownSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DependencyCache, dependencyKey, removePublishedDependencies } from './builder-release-dependencies.js';
import { copyReleaseTree } from './builder-deployment.js';
function fixture() {
  const root = mkdtempSync(join(process.cwd(), '.dependency-test-'));
  const stage = join(root, 'stage'); mkdirSync(stage); mkdirSync(join(stage, 'node_modules'));
  writeFileSync(join(stage, 'node_modules', 'index.js'), 'trusted install');
  symlinkSync('index.js', join(stage, 'node_modules', 'bin'));
  const cache = new DependencyCache(join(root, 'cache'), copyReleaseTree);
  const key = dependencyKey([['package-lock.json', 'lock'], ['package.json', 'manifest']], ['native@1']);
  const target = join(root, 'target'); mkdirSync(target);
  return { root, stage, cache, key, target, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test('key invalidates exact locks, all manifests, script/policy inputs and runtime identities', () => {
  const runtime = { node: 'v22', platform: 'linux', arch: 'x64', abi: '127', versions: {} } as any;
  const inputs: [string, string][] = [['lock', 'one'], ['packages/a/package.json', 'two'], ['scripts/install', 'three']];
  const base = dependencyKey(inputs, ['native@1'], runtime);
  for (let i = 0; i < inputs.length; i++) assert.notEqual(base, dependencyKey(inputs.map((p, j) => j === i ? [p[0], p[1] + '!'] : p), ['native@1'], runtime));
  for (const field of ['node', 'platform', 'arch', 'abi', 'versions']) assert.notEqual(base, dependencyKey(inputs, ['native@1'], { ...runtime, [field]: 'changed' }));
  assert.notEqual(base, dependencyKey(inputs, ['native@2'], runtime));
  assert.equal(base, dependencyKey([...inputs].reverse(), ['native@1'], runtime));
});
test('verified hit clones independent inodes; stage writes never reach artifact; duplicate publishers do not overwrite', () => {
  const f = fixture(); try {
    f.cache.publish(f.key, f.stage); f.cache.publish(f.key, f.stage);
    assert.ok(f.cache.restore(f.key, f.target, { uid: process.getuid!(), gid: process.getgid!() }));
    const cached = join(f.root, 'cache', f.key, 'tree/node_modules/index.js');
    assert.notEqual(lstatSync(cached).ino, lstatSync(join(f.target, 'node_modules/index.js')).ino);
    writeFileSync(join(f.target, 'node_modules/index.js'), 'modified');
    assert.equal(readFileSync(cached, 'utf8'), 'trusted install');
    assert.ok(!readdirSync(join(f.root, 'cache')).some(n => n.startsWith('.pending')));
  } finally { f.cleanup(); }
});
for (const kind of ['bytes', 'symlink', 'hardlink', 'mode', 'owner', 'manifest'] as const) test(`artifact ${kind} poisoning fails closed before restoring`, { skip: kind === 'owner' && process.getuid!() !== 0 ? 'requires root to change ownership' : false }, () => {
  const f = fixture(); try {
    f.cache.publish(f.key, f.stage);
    const path = join(f.root, 'cache', f.key, 'tree/node_modules/index.js');
    if (kind === 'hardlink') linkSync(path, join(f.root,'alias'));
    if (kind === 'bytes') writeFileSync(path, 'poison');
    if (kind === 'symlink') { rmSync(path); symlinkSync('/outside', path); }
    if (kind === 'mode') chmodSync(path, 0o666);
    if (kind === 'owner') { if (process.getuid!() !== 0) return; chownSync(path, 12345, 12345); }
    if (kind === 'manifest') { const m = join(f.root, 'cache', f.key, 'manifest.json'); rmSync(m); symlinkSync('tree/node_modules/index.js', m); }
    assert.throws(() => f.cache.restore(f.key, f.target, { uid: process.getuid!(), gid: process.getgid!() }));
    assert.ok(!existsSync(join(f.target, 'node_modules')));
  } finally { f.cleanup(); }
});
test('failed publication removes pending artifact; miss leaves target untouched; escaping links refused', () => {
  const f = fixture(); try {
    assert.equal(f.cache.restore(f.key, f.target, { uid: process.getuid!(), gid: process.getgid!() }), undefined);
    symlinkSync('/outside', join(f.stage, 'node_modules/escape'));
    assert.throws(() => f.cache.publish(f.key, f.stage));
    assert.deepEqual(readdirSync(join(f.root, 'cache')), []);
  } finally { f.cleanup(); }
});
test('bounded retention preserves current and one previous artifact', () => {
 const f=fixture();try {
  const keys=['1','2','3'].map(n=>n.repeat(64));for(const key of keys)f.cache.publish(key,f.stage);
  f.cache.retain(keys[2]);assert.equal(readdirSync(join(f.root,'cache')).length,2);
  assert.ok(existsSync(join(f.root,'cache',keys[2])));
 }finally{f.cleanup();}
});

test('concurrent trusted publishers atomically select one complete verified artifact', async () => {
 const f=fixture();try {
  const code = `import { DependencyCache } from ${JSON.stringify(new URL('./builder-release-dependencies.ts',import.meta.url).href)};
  import { copyReleaseTree } from ${JSON.stringify(new URL('./builder-deployment.ts',import.meta.url).href)};
  new DependencyCache(${JSON.stringify(join(f.root,'cache'))},copyReleaseTree).publish(${JSON.stringify(f.key)},${JSON.stringify(f.stage)});`;
  const outcomes=await Promise.allSettled([1,2].map(()=>promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),timeout:30000})));
  for(const outcome of outcomes)assert.equal(outcome.status,'fulfilled',outcome.status==='rejected'?String(outcome.reason):'');
  assert.ok(f.cache.restore(f.key,f.target,{uid:process.getuid!(),gid:process.getgid!()}));
  assert.deepEqual(readdirSync(join(f.root,'cache')),[f.key]);
 }finally{f.cleanup();}
});

test('cache entry symlink and existing staging dependency root are refused', () => {
 const f=fixture();try {
  f.cache.publish(f.key,f.stage);
  const entry=join(f.root,'cache',f.key),moved=join(f.root,'relocated');
  copyReleaseTree(entry,moved);rmSync(entry,{recursive:true});symlinkSync(moved,entry);
  assert.throws(()=>f.cache.restore(f.key,f.target,{uid:process.getuid!(),gid:process.getgid!()}));
  rmSync(entry);rmSync(moved,{recursive:true});f.cache.publish(f.key,f.stage);
  symlinkSync(join(f.stage,'node_modules'),join(f.target,'node_modules'));
  assert.throws(()=>f.cache.restore(f.key,f.target,{uid:process.getuid!(),gid:process.getgid!()}),/destination/);
 }finally{f.cleanup();}
});

test('chained symlink escape and cycles are rejected before publication', () => {
  for (const cycle of [false, true]) {
    const f = fixture(); try {
      mkdirSync(join(f.stage, 'node_modules/deep'));
      symlinkSync(cycle ? 'chain' : 'deep/..', join(f.stage, 'node_modules/chain'));
      symlinkSync('chain/../../outside', join(f.stage, 'node_modules/escape'));
      assert.throws(() => f.cache.publish(f.key, f.stage), /symlink/i);
      assert.deepEqual(readdirSync(join(f.root, 'cache')), []);
    } finally { f.cleanup(); }
  }
});

test('copy refuses destination symlinks and hardlinked source files', () => {
  const f = fixture(); try {
    symlinkSync(f.stage, join(f.root, 'redirect'));
    assert.throws(() => copyReleaseTree(f.stage, join(f.root, 'redirect/new')), /destination/);
    assert.throws(() => copyReleaseTree(f.stage, join(f.root, 'redirect')));
    linkSync(join(f.stage, 'node_modules/index.js'), join(f.root, 'alias'));
    assert.throws(() => copyReleaseTree(f.stage, join(f.root, 'copy')), /Special/);
  } finally { f.cleanup(); }
});

test('dangling cache entry symlink is corruption, not a cache miss', () => {
 const f=fixture();try {
  symlinkSync(join(f.root,'missing'),join(f.root,'cache',f.key));
  assert.throws(()=>f.cache.restore(f.key,f.target,{uid:process.getuid!(),gid:process.getgid!()}));
  assert.deepEqual(readdirSync(f.target),[]);
 }finally{f.cleanup();}
});

test('native Make hardlink outputs publish as independent files with restore isolation', () => {
  const f = fixture(); try {
    const paths = ['node_modules/better-sqlite3/build/Release/obj.target/better_sqlite3.node',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node'];
    for (const path of paths) mkdirSync(join(f.stage, path, '..'), { recursive: true });
    const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]);
    writeFileSync(join(f.stage, paths[0]), bytes);
    linkSync(join(f.stage, paths[0]), join(f.stage, paths[1]));
    assert.equal(lstatSync(join(f.stage, paths[0])).nlink, 2);
    assert.throws(() => copyReleaseTree(f.stage, join(f.root, 'strict')), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Special file in release: path="node_modules\/better-sqlite3\/.*\.node" type=regular nlink=2/);
      assert.ok(!error.message.includes(f.root)); return true;
    });
    f.cache.publish(f.key, f.stage);
    const cached = paths.map(path => join(f.root, 'cache', f.key, 'tree', path));
    assert.equal(new Set(cached.map(path => lstatSync(path).ino)).size, 2);
    for (const path of cached) {
      assert.equal(lstatSync(path).nlink, 1);
      assert.notEqual(lstatSync(path).ino, lstatSync(join(f.stage, paths[0])).ino);
      assert.deepEqual(readFileSync(path), bytes);
    }
    writeFileSync(join(f.stage, paths[1]), 'source changed');
    assert.ok(f.cache.restore(f.key, f.target, { uid: process.getuid!(), gid: process.getgid!() }));
    assert.equal(new Set(paths.map(path => lstatSync(join(f.target, path)).ino)).size, 2);
    for (const path of paths) {
      assert.equal(lstatSync(join(f.target, path)).nlink, 1);
      assert.deepEqual(readFileSync(join(f.target, path)), bytes);
      assert.notEqual(lstatSync(join(f.target, path)).ino, lstatSync(cached[0]).ino);
    }
    writeFileSync(join(f.target, paths[0]), 'restored changed');
    assert.deepEqual(readFileSync(join(f.target, paths[1])), bytes);
    for (const path of cached) assert.deepEqual(readFileSync(path), bytes);
    linkSync(cached[0], join(f.root, 'poison-alias'));
    const fresh = join(f.root, 'fresh'); mkdirSync(fresh);
    assert.throws(() => f.cache.restore(f.key, fresh, { uid: process.getuid!(), gid: process.getgid!() }), /type\/link count/);
    assert.deepEqual(readdirSync(fresh), []);
  } finally { f.cleanup(); }
});


test('cold removal rejects symlink roots and ancestors before deleting any admitted root', () => {
 for (const kind of ['stage', 'ancestor', 'root', 'traversal']) {
  const f = fixture(); try {
    mkdirSync(join(f.stage, 'packages/backend/node_modules'), { recursive: true });
    writeFileSync(join(f.stage, 'packages/backend/node_modules/keep'), 'keep');
    const published = f.cache.publish(f.key, f.stage);
    if (kind === 'stage') { const moved = join(f.root, 'moved'); copyReleaseTree(f.stage, moved); rmSync(f.stage, {recursive:true}); symlinkSync(moved, f.stage); }
    if (kind === 'ancestor') { rmSync(join(f.stage, 'packages/backend'), {recursive:true}); symlinkSync(f.target, join(f.stage, 'packages/backend')); }
    if (kind === 'root') { rmSync(join(f.stage, 'packages/backend/node_modules'), {recursive:true}); symlinkSync(f.target, join(f.stage, 'packages/backend/node_modules')); }
    if (kind === 'traversal') published.paths.push('../target/node_modules');
    assert.throws(() => removePublishedDependencies(f.stage, published.paths), /Unsafe dependency/);
    assert.equal(readFileSync(join(f.stage, 'node_modules/index.js'), 'utf8'), 'trusted install');
    assert.deepEqual(readdirSync(f.target), []);
  } finally { f.cleanup(); }
 }
});
test('cold removal and strict restore normalize native aliases and request build ownership', () => {
 const f = fixture(); try {
  linkSync(join(f.stage, 'node_modules/index.js'), join(f.stage, 'node_modules/alias.js'));
  const published = f.cache.publish(f.key, f.stage);
  removePublishedDependencies(f.stage, published.paths);
  assert.ok(!existsSync(join(f.stage, 'node_modules')));
  const owned: string[] = [];
  assert.ok(f.cache.restore(f.key, f.stage, { uid: 1002, gid: 1003 }, (path, uid, gid) => {
    assert.equal(uid, 1002); assert.equal(gid, 1003); owned.push(path);
  }));
  for (const name of ['index.js', 'alias.js']) {
    const path = join(f.stage, 'node_modules', name);
    assert.ok(owned.includes(path)); assert.equal(lstatSync(path).nlink, 1);
  }
  assert.notEqual(lstatSync(join(f.stage, 'node_modules/index.js')).ino, lstatSync(join(f.stage, 'node_modules/alias.js')).ino);
 } finally { f.cleanup(); }
});

test('permissive umask publication creates safe intermediate directories without changing caller directories', () => {
  const previous = process.umask(0o000);
  const f = fixture(); try {
    mkdirSync(join(f.stage, 'packages/backend/node_modules'), { recursive: true });
    writeFileSync(join(f.stage, 'packages/backend/node_modules/dep.js'), 'installed');
    chmodSync(f.target, 0o777);
    copyReleaseTree(join(f.stage, 'node_modules/index.js'), join(f.target, 'new/deep/index.js'));
    assert.equal(lstatSync(f.target).mode & 0o777, 0o777);
    for (const path of ['new', 'new/deep']) assert.equal(lstatSync(join(f.target, path)).mode & 0o777, 0o755);
    f.cache.publish(f.key, f.stage);
    for (const path of ['packages', 'packages/backend']) assert.equal(lstatSync(join(f.root, 'cache', f.key, 'tree', path)).mode & 0o777, 0o755);
    mkdirSync(join(f.target, 'packages/backend'), { recursive: true });
    assert.ok(f.cache.restore(f.key, f.target, { uid: process.getuid!(), gid: process.getgid!() }));
  } finally { process.umask(previous); f.cleanup(); }
});

test('root: generic copy normalizes foreign file ownership without following symlink targets', { skip: process.getuid!() !== 0 }, () => {
  const f = fixture(); try {
    const source = join(f.stage, 'node_modules/index.js');
    chownSync(source, 994, 985);
    copyReleaseTree(join(f.stage, 'node_modules'), join(f.target, 'copied'));
    const dest = lstatSync(join(f.target, 'copied/index.js'));
    assert.equal(dest.uid, process.getuid!()); assert.equal(dest.gid, process.getgid!());
    assert.equal(dest.mode & 0o777, 0o644); assert.equal(dest.nlink, 1);
    assert.notEqual(dest.ino, lstatSync(source).ino);
    assert.equal(lstatSync(source).uid, 994); assert.equal(lstatSync(source).gid, 985);
    assert.ok(lstatSync(join(f.target, 'copied/bin')).isSymbolicLink());
  } finally { f.cleanup(); }
});

test('root: foreign installed dependencies publish independent coordinator artifacts and restore build ownership; owner tampering rejects', { skip: process.getuid!() !== 0 }, () => {
  const f = fixture(); try {
    const paths = ['node_modules/index.js', 'node_modules/native.node', 'packages/backend/node_modules/dep.js'];
    mkdirSync(join(f.stage, 'packages/backend/node_modules'), { recursive: true });
    writeFileSync(join(f.stage, paths[2]), 'workspace dependency');
    linkSync(join(f.stage, paths[0]), join(f.stage, paths[1]));
    for (const path of paths) chownSync(join(f.stage, path), 994, 985);
    const published = f.cache.publish(f.key, f.stage);
    const artifacts = paths.map(path => join(f.root, 'cache', f.key, 'tree', path));
    for (let i = 0; i < artifacts.length; i++) {
      const st = lstatSync(artifacts[i]);
      assert.equal(st.uid, process.getuid!()); assert.equal(st.gid, process.getgid!());
      assert.equal(st.nlink, 1); assert.equal(st.mode & 0o777, 0o644);
      assert.notEqual(st.ino, lstatSync(join(f.stage, paths[i])).ino);
    }
    assert.notEqual(lstatSync(artifacts[0]).ino, lstatSync(artifacts[1]).ino);
    removePublishedDependencies(f.stage, published.paths);
    assert.ok(f.cache.restore(f.key, f.stage, { uid: 994, gid: 985 }));
    for (const path of paths) {
      const st = lstatSync(join(f.stage, path));
      assert.equal(st.uid, 994); assert.equal(st.gid, 985); assert.equal(st.nlink, 1);
    }
    chownSync(artifacts[0], 994, 985);
    assert.throws(() => f.cache.restore(f.key, f.target, { uid: 994, gid: 985 }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /path="node_modules\/index.js" actual uid=994 gid=985 mode=0644 expected uid=0 gid=\d+ mode=/);
      assert.ok(!error.message.includes(f.root)); return true;
    });
    assert.deepEqual(readdirSync(f.target), []);
  } finally { f.cleanup(); }
});

test('inventory ownership diagnostics escape relative paths and omit absolute paths', () => {
  const f = fixture(); try {
    f.cache.publish(f.key, f.stage);
    const tree = join(f.root, 'cache', f.key, 'tree');
    const name = 'bad\n"name'; writeFileSync(join(tree, name), 'fixture'); chmodSync(join(tree, name), 0o666);
    assert.throws(() => f.cache.restore(f.key, f.target, { uid: process.getuid!(), gid: process.getgid!() }), error => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`path=${JSON.stringify(name)}`));
      assert.match(error.message, /actual uid=\d+ gid=\d+ mode=0666 expected uid=\d+ gid=\d+ mode=/);
      assert.ok(!error.message.includes(f.root)); assert.ok(!error.message.includes('\n')); return true;
    });
  } finally { f.cleanup(); }
});
