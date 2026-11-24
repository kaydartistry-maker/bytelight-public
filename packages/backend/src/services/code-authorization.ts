/** Fail-closed authorization policy. Inputs come from the transport and canonical Git snapshot. */
import { createHash } from 'node:crypto';
import type { BeltContext } from './chat-tool-belt.js';
export const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');
export interface Authorization {
  authorization_id: string; origin_turn_id: string; origin_message_id: string; proposal_message_id: string; origin_digest: string; threadId: string; branch: string; head: string;
  diff_sha256: string; files: string[]; reasons: string[]; requires_fresh_approval: boolean;
}
export function liveOwner(ctx?: BeltContext): boolean {
  return !!ctx?.ownerMessageId && !!ctx?.proposalMessageId && !!ctx?.turnId && !!ctx.threadId && ctx.isAutonomous === false && ctx.audience?.kind === 'owner' && !!ctx.rawOwnerMessageText?.trim();
}
// Match complete words/identifiers, with explicit security vocabulary variants.
const sensitive = /\b(?:auth(?:entication|orization|orize[ds]?)?|permissions?|access|roles?|owner|guest|trust|policy|secur(?:e[ds]?|ity|ing)|secrets?|credentials?|tokens?|passwords?|sessions?|cookies?|encrypt\w*|api.?key|private.?key|vault|deployment|deploy(?:ment)?[- ](?:system|workflow|coordinator|authorization|pipeline|script|service)|code-(?:deployment(?:-worker)?|delegation|patch|authorization|checkpoint)|chat-tool-belt|(?:services\/)?agent\.(?:ts|js)|agent\/turn-input|turn-audience|runtimes\/codex-daemon|mcp|migrat(?:e[ds]?|ions?|ing)|schema|database|sql|delete|destroy|drop|remove|truncate|reset|overwrite|unlink|payments?|billing|financ(?:e[sd]?|ial|ing)|purchase|money|bank|transfer|refund|invoice|trade|buy|sell|webhook|email|send|notify|publish|upload|external|network|fetch|exec|spawn|eval)\b|\.env\b|https?:|\bprocess\./i;
const testModules = new Set(['node:test', 'node:assert/strict', 'node:fs', 'node:url']);
// Only literal accessibility attributes are exempt; role variables and policy
// code still match. Do not erase expressions or arbitrary attribute values.
const accessibility = /(<[A-Za-z][^<>\n]*\s)role\s*=\s*["'](?:status|button|dialog|listbox|option|alert|presentation|tab|tabpanel|search|combobox|list|listitem|menu|menuitem|tooltip|progressbar|img|region|group|navigation|heading|separator|checkbox|radio|switch)["']/g;
const effects = /\b(?:require|export\s*\*|XMLHttpRequest|WebSocket|EventSource|navigator|location|document|window|localStorage|sessionStorage|indexedDB|serviceWorkers?|storage|dangerouslySetInnerHTML|innerHTML|POST|PUT|PATCH|DELETE|http|https|net|child_process|writeFile\w*|appendFile\w*|createWriteStream|writeSync|write|mkdir\w*|rmdir\w*|rmSync|rename\w*|chmod\w*|chown\w*|truncate\w*|copyFile\w*|cpSync)\b|@html|\bservice\s+workers?\b/i;
export function classify(origin: string, files: string[], patch: Buffer): string[] {
  const reasons: string[] = [];
  if (!/\b(?:implement|fix|change|update|add|edit|correct|build|make|adjust|style|sort)\b/i.test(origin) || /[?`"'<>“”‘’]|\b(?:maybe|consider|investigate|inspect|could|whether|later|wait|hold|never|not|dont)\b/i.test(origin)) reasons.push('ambiguous originating request');
  if (sensitive.test(origin)) reasons.push('sensitive originating request');
  if (!files.length || !patch.length) reasons.push('empty edit');
  if (files.some(f => /(?:^|\/)(?:scripts|[^/]*config\.[^/]+|package[^/]*\.json)(?:\/|$)/i.test(f) || !/^(?:docs\/[\w/-]+\.md|packages\/(?:frontend|phone)\/src\/[\w/.-]+\.(?:svelte|tsx?|css))$/.test(f))) reasons.push('uncertain or sensitive file category');

  // Diff context is not edited code. Inspect additions and removals only,
  // including the removed side so disguising a dangerous operation is refused.
  let file = files.length === 1 ? files[0] : '';
  const changed: { line: string; file: string }[] = [];
  for (const line of patch.toString('utf8').split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) file = header[2];
    if (/^[+-]/.test(line) && !/^(?:---|\+\+\+)/.test(line)) changed.push({ line: line.slice(1), file });
  }
  let sensitivePatch = files.some(f => sensitive.test(f));
  let executable = false, imports = false;
  for (const edit of changed) {
    const isTest = /\.test\.tsx?$/.test(edit.file);
    // Resolve each import separately; a permitted import cannot hide another.
    const line = edit.line.replace(/\bimport\s*(?:\(\s*(['"])([^'"]+)\1\s*\)|(?:[^;'"()]*?\bfrom\s*)?(['"])([^'"]+)\3)/g, (statement, _q, dynamicModule, _q2, staticModule) => {
      const module = dynamicModule ?? staticModule;
      if (module === 'node:fs') {
        // Admit only explicit read-only bindings, never namespace/default or
        // computed access to the much larger writable filesystem API.
        const bindings = dynamicModule
          ? /\b(?:const|let)\s*\{([^}]+)\}\s*=\s*await\s*$/.exec(edit.line.slice(0, edit.line.indexOf(statement)))?.[1]
          : /^import\s*\{([^}]+)\}\s*from/.exec(statement)?.[1];
        if (!bindings || !bindings.split(',').every(binding => /^(?:readFileSync|readFile|readdirSync|readdir|statSync|stat|lstatSync|lstat|existsSync|realpathSync|realpath)(?:\s+as\s+[A-Za-z_$][\w$]*)?$/.test(binding.trim()))) executable = true;
      }
      if (sensitive.test(module)) sensitivePatch = true;
      const local = /^\.{1,2}\//.test(module);
      if (!local && !(isTest && testModules.has(module))) imports = true;
      return statement.replace(module, '').replace(/\bimport\b/, '');
    });
    if (/\bimport\b/.test(line.replace(/import\.meta\b/g, ''))) imports = true;
    let code = line.replace(accessibility, '$1');
    // Catalog source assertions describe markup; they do not assign a role.
    if (isTest) code = code.replace(/(\bassert\.match\([^,\n]+,\s*\/)role="status">/g, '$1>');
    if (sensitive.test(code)) sensitivePatch = true;
    if (effects.test(code) || /\bfs\b/.test(code)) executable = true;
  }
  if (sensitivePatch) reasons.push('sensitive patch');
  if (executable) reasons.push('uncertain executable effects');
  if (imports) reasons.push('uncertain import origin');
  if (patch.length > 64_000 || /GIT binary patch|deleted file mode|old mode|new mode|new file mode (?!100644)|rename from|copy from/.test(patch.toString())) reasons.push('uncertain reversibility');
  return reasons;
}
export function bindAuthorization(ctx: BeltContext | undefined, branch: string, head: string, snap: { files: string[]; patch: Buffer; diff_sha256: string }, failed: boolean): Authorization {
  if (!liveOwner(ctx)) throw new Error('Live owner originating request and thread required');
  const reasons = classify(ctx!.rawOwnerMessageText!, snap.files, snap.patch);
  if (failed) reasons.push('prior failed or incomplete validation on branch');
  const bound = { origin_message_id: ctx!.ownerMessageId!, proposal_message_id: ctx!.proposalMessageId!, origin_turn_id: ctx!.turnId!, origin_digest: digest(ctx!.rawOwnerMessageText!), threadId: ctx!.threadId!, branch, head, diff_sha256: snap.diff_sha256, files: snap.files };
  return { ...bound, authorization_id: digest(JSON.stringify(bound)), reasons, requires_fresh_approval: reasons.length > 0 };
}
export function freshApproval(ctx: BeltContext | undefined, auth: Authorization, unresolvedCount = 0): boolean {
  if (!liveOwner(ctx) || !auth.origin_turn_id || !auth.origin_message_id || !auth.proposal_message_id
    || auth.origin_turn_id === ctx!.turnId || auth.origin_message_id === ctx!.ownerMessageId
    || ctx!.threadId !== auth.threadId || digest(ctx!.rawOwnerMessageText!) === auth.origin_digest) return false;
  if (ctx!.replyToMessageId && ctx!.replyToMessageId !== auth.proposal_message_id) return false;
  const raw = ctx!.rawOwnerMessageText!;
  if (/[\r\n"`<>?“”‘’]/.test(raw)) return false;
  const text = raw.trim().replace(/[.!]$/, '').toLowerCase();
  const bare = /^(?:(?:yes|please)[, ]+)?(?:i )?(?:approve|deploy|go ahead|proceed|ship it|do it)$/;
  if (bare.test(text)) return ctx!.replyToMessageId === auth.proposal_message_id;
  const references = [auth.authorization_id, auth.diff_sha256].flatMap(id => [id.toLowerCase(), id.slice(0, 12).toLowerCase()]);
  const ref = references.find(id => text.endsWith(' ' + id));
  const wording = ref ? text.slice(0, -ref.length).trim() : text;
  if (!/^(?:(?:yes|please)[, ]+)?(?:i )?(?:approve|deploy|ship|proceed with|go ahead with) (?:the |this )?(?:pending change|patch|change)$/.test(wording)) return false;
  return !!ref || unresolvedCount === 1;
}
