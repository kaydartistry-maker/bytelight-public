/** One-time operator state machine. Adapters own fixed paths; no model inputs. */
export async function activate(io, plan) {
  const receipt = { version: 1, target: plan.target, tree: plan.tree, status: 'preflight', phases: [], rollback: null };
  let locked = false, stopAttempted = false, promoted = false;
  const trace = (name, fn) => io.effect ? io.effect(name, fn, { safety: /^(rollback|recovery)\./.test(name) }) : fn();
  const step = async (name, fn) => { receipt.phases.push(name); await io.record(receipt); return trace(name, fn); };
  await io.preflight(plan);
  try {
    await io.lock(plan); locked = true;
    await step('stage', () => io.stage(plan));
    await step('backup', () => io.backup(plan));
    // A failed stop can still have stopped the app: attempt restoration from here.
    stopAttempted = true;
    await step('stop', () => io.stop());
    await step('final-snapshot', () => io.snapshot());
    promoted = true; // set BEFORE the first potentially partial filesystem effect
    await step('promote', () => io.promote(plan));
    await step('source', () => io.source(plan));
    await step('config', () => io.configure(plan));
    await step('restart', () => io.restart());
    await step('health', () => io.health(plan));
    await step('persist', () => io.persist());
    receipt.status = 'activated';
    await io.record(receipt);
    await io.unlock(); locked = false;
  } catch {
    receipt.error = `Activation failed during ${receipt.phases.at(-1) || 'lock'}`;
    if (stopAttempted) {
      try {
        await trace('rollback.stop', () => io.stop());
        await trace('rollback.snapshot', () => io.safetySnapshot());
        if (promoted) await trace('rollback.restore', () => io.restore(plan));
        await trace('rollback.restart', () => io.restartPrior());
        await trace('rollback.health', () => io.healthPrior());
        await trace('rollback.persist', () => io.persist());
        receipt.status = 'rolled_back'; receipt.rollback = { healthy: true, database: 'Live database preserved; no main migration in bootstrap.' };
      } catch {
        receipt.status = 'recovery_required'; receipt.rollback = { healthy: false };
        try { await trace('rollback.fence-stop', () => io.stop()); } catch { /* retain lock and receipt */ }
      }
    } else receipt.status = 'failed_before_stop';
    await io.record(receipt);
    if (locked && receipt.status !== 'recovery_required') { await io.unlock(); locked = false; }
  }
  return receipt;
}

/** Resume rollback only; never resume promotion after an interruption. */
export async function recover(io) {
  const receipt = await io.loadRecovery();
  const trace = (name, fn) => io.effect ? io.effect(name, fn, { safety: /^(rollback|recovery)\./.test(name) }) : fn();
  try {
    if (!receipt.phases.some(p => ['stop','final-snapshot','promote','source','config','restart','health','persist'].includes(p))) {
      await trace('recovery.verify', () => io.verifyUntouched()); receipt.status = 'failed_before_stop';
    } else {
      await trace('recovery.stop', () => io.stop()); await trace('recovery.snapshot', () => io.safetySnapshot()); await trace('recovery.restore', () => io.restore());
      await trace('recovery.restart', () => io.restartPrior()); await trace('recovery.health', () => io.healthPrior()); await trace('recovery.persist', () => io.persist());
      receipt.status = 'rolled_back'; receipt.rollback = { healthy: true };
    }
    await io.record(receipt); await io.unlock();
  } catch {
    receipt.status = 'recovery_required'; receipt.rollback = { healthy: false };
    try { await trace('recovery.fence-stop', () => io.stop()); } catch { /* retain lock */ }
    await io.record(receipt);
  }
  return receipt;
}
