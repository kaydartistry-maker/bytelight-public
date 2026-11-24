# BL internal coding and guarded deployment

User speaks to Gemini/Argon in Bytelight. Argon calls `delegate_code` to send one task to Codex CLI using her ChatGPT subscription. The existing inspect/edit modes, `codex/*` branch creation, dirty-workspace refusal, `continue_existing`, process mutex, safety prompt and 20 minute timeout remain. New tasks start from **local** main; delegation performs no fetch or merge. Updating that baseline is administrator maintenance.

The edit report includes branch, report, status, diff stat, bounded diff and `diff_sha256`. The fingerprint covers the complete binary Git patch from HEAD to the working tree, including staged, deleted and untracked nonignored files. The temporary index does not change the real index. Binary patch payloads are omitted from the model report. Committed HEAD is the trusted public baseline, including private-looking example filenames. Changed private paths are rejected; HEAD and pending symlinks/gitlinks are refused.

After explaining the exact pending diff, Argon must wait for User's live owner message: `deploy`, `Lets deploy!` (straight, curly or no apostrophe accepted), `ship it`, `put it live` or `push it live`. The phrase must stand alone, apart from punctuation/whitespace. Negation, cancellation, waiting, guests and autonomous wakes cannot authorize deployment. Argon calls `deploy_code(branch,diff_sha256,confirmation:"DEPLOY")`; model arguments alone cannot approve anything. The handler receives raw current message text and autonomy state from the live agent turn.

Deployment returns pending only after a root-owned atomic ready handshake from the reparented real worker. Bootstrap failure or handshake timeout persists failure and removes only the matching coordinator-owned starting lock. A detached launcher exits and reparents the root worker before deployment, so PM2 process-tree cleanup cannot kill it during restart. On the next BL turn, Argon calls `deploy_code_status(branch,diff_sha256)` to retrieve the durable result. Status never starts deployment and needs no fresh approval. Deployment does **not commit, push or merge**, invoke another agent, use a webhook, or provide an arbitrary shell tool.

## Administrator setup (outside this implementation task)

Use dedicated, distinct non-root Codex and builder users/groups. The BL coordinator and compiled worker must run as root from root-owned compiled application code. The development checkout must be owned by Codex and physically outside `/root/production`; use a traversable location such as `/srv/bytelight-dev`. Provision subscription authentication separately under Codex's HOME; no BL credentials are passed to the CLI.

Configure these BL service environment settings:

| Variable | Meaning |
| --- | --- |
| `BYTELIGHT_CODE_DELEGATION_ENABLED=true` | Enable coding delegation |
| `BYTELIGHT_CODE_DEPLOYMENT_ENABLED=true` | Owner kill switch for starting guarded deployment; status remains readable |
| `BYTELIGHT_CODE_WORKSPACE` | Absolute canonical development checkout; delegate default `/srv/bytelight-dev`; required explicitly for deploy |
| `BYTELIGHT_CODEX_UID`, `BYTELIGHT_CODEX_GID` | Positive numeric non-root Codex identity |
| `BYTELIGHT_CODEX_HOME` | Absolute canonical mode-0700 Codex HOME, owned by the configured Codex UID/GID and disjoint from privileged deployment paths |
| `BYTELIGHT_BUILD_UID`, `BYTELIGHT_BUILD_GID` | Separate positive numeric non-root builder identity |
| `BYTELIGHT_CODE_PRODUCTION` | Absolute canonical production checkout |
| `BYTELIGHT_CODE_STATE_DIR` | Root-owned mode 0700 durable state, default `/var/lib/bytelight-code` |
| `BYTELIGHT_CODE_STAGING_DIR` | Root-owned staging parent, traversable by builder, e.g. `/var/lib/bytelight-staging` mode 0755 |
| `BYTELIGHT_CODE_BACKUP_DIR` | Root-owned backup parent, preferably mode 0700 |
| `BYTELIGHT_CODE_SQLITE_PATH` | Fixed absolute production SQLite database path within production |
| `BYTELIGHT_CODE_HEALTH_URL` | Fixed `http://127.0.0.1:PORT/api/health` endpoint |
| `BYTELIGHT_CODE_PM2_APP` | Fixed PM2 application name, letters/digits/underscore/hyphen only |

Provision these directories beforehand. Development, production, staging, backup and state must be disjoint and non-nested. Privileged directories and their ancestry must be root-owned and protected from other writers. Root-owned sticky temporary ancestors are allowed for fixtures. State must never be inside `.git` or a Codex/builder writable directory. Requests, patches, results and the deployment lock are protected by the root-only state directory.

Install `/usr/bin/setpriv` (used to clear supplementary groups and set no-new-privileges before dropping identity) and `/usr/bin/bwrap` for Codex's workspace sandbox. On Ubuntu hosts with `kernel.apparmor_restrict_unprivileged_userns=1`, add a narrow AppArmor profile for `/usr/bin/bwrap` granting `userns` instead of disabling the system-wide restriction. Verify a Codex-user `workspace-write` smoke edit before enabling deployment. Also install and the fixed executables `/usr/bin/git`, `/usr/bin/tar`, `/bin/chown`, `/usr/bin/npm`, `/usr/bin/node`, `/usr/bin/sqlite3`, `/usr/bin/pm2`; `codex` must resolve through `/usr/local/bin:/usr/bin:/bin`. PM2 must manage the fixed app through root's normal PM2 home, as the current root-run BL application, which also hosts the root coordinator. The whole BL runtime is privileged; only Codex and the builder are isolated non-root identities. No separate privilege bridge is required or implemented. No executable path or command is supplied by model arguments.

Codex receives only HOME, PATH, USER/LOGNAME, locale and terminal settings. Builder commands receive the same allowlist plus an isolated npm cache under a disposable staging HOME. Neither inherits BL's environment or secrets. Do not put secrets in the dev checkout, builder HOME or tracked source. Filesystem permissions must prevent these identities from reading production credentials.

## Worker pipeline and recovery

The worker constructs staging from `git archive HEAD` plus the exact canonical patch. Because upstream intentionally ignores `package-lock.json` while deployment forbids manifest/lockfile edits, it copies the regular root-owned, non-writable production lockfile into staging. It executes `npm ci --ignore-scripts`, the trusted lockfile-pinned `better-sqlite3`/`esbuild` rebuild, focused deployment tests and `npm run build`, all as builder. Manifest, shrinkwrap, lockfile, shell script, workflow, build config, generated dist and privileged coordinator source changes require manual maintenance. Builder-produced coordinator JavaScript modules are replaced with the trusted installed modules before promotion; this tool cannot upgrade its own privileged implementation. It rechecks the original development fingerprint after building. Artifacts are sealed into root-only state through descriptor-anchored traversal that rejects symlinks and special/hardlinked files.

After baseline health, matching clean production HEAD and `git apply --check`, the worker creates a timestamped root-only backup containing a SQLite online backup, affected source with nonexistence markers, and the current `packages/shared/dist`, `packages/backend/dist`, `packages/frontend/build` and `packages/phone/dist` artifacts. It stops the fixed app, applies the exact source patch and promotes only those built directories. It runs no production npm, build or test command. It restarts only the configured PM2 app and requires three consecutive bounded health checks with exactly one matching online PM2 app, a positive integer PID and nonnegative integer restart count, with the same PID and restart count across all three reads, both before deployment and after restart or rollback.

On failure after touching production, it requires the app to stop before restoring source (deleting formerly nonexistent files), artifacts and SQLite, then restarts and health-checks the prior app. Results contain deployed/rolled_back/recovery_required, branch/hash, backup location, validation/build/restart/health/rollback details and next guidance. A rollback failure retains the lock.

Locks contain PID, request fingerprint and state. Locks are never automatically discarded as stale: an absent PID does not prove production is coherent. Status reports worker liveness without mutating state. An administrator must inspect durable request/result, backup, source, artifacts, database and PM2 state, restore a coherent version if needed, and only then recover a stale lock. Do not blindly remove a lock or initiate concurrent deployment. A previously requested fingerprint is never replayed automatically. Secret-free staging and sealed artifacts are removed after deployment, ordinary failure, or successful rollback; they are retained only for `recovery_required` so an administrator can diagnose and recover safely. Durable request, patch, ready-handshake and result records remain in root-owned state for audit.

## Validation

Run `node --import tsx packages/backend/src/services/code-deployment.test.ts` directly (the sandboxed Node test-runner wrapper can hide child test output), the existing chat-tool-belt and turn-audience tests, MCP belt transport tests, backend check/build, and `git diff --check`. All deployment fixtures use temporary paths and injected process/health/promotion boundaries. The real Git canonical-patch fixture needs a runner permitting child processes; transport tests need loopback sockets. No test should access production.

The injected deployment suite also covers partial promotion, restart and health failure, PM2 state, PID, duplicate-app and restart instability refusal, unsafe artifact links, rollback stop/SQLite failure, preserved privileged modules, launcher spawn failure and reparenting. Root-owned boundary fixtures skip under the unprivileged staging test runner. Actual process-tree survival and Git binary-patch subprocess behavior require unrestricted integration CI; no real PM2 or production process is exercised by these fixtures.
