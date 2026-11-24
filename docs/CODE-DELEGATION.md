# Gemini → Codex coding delegation

Virelle can keep an OpenRouter model (for example Gemini 4 Argon) as the conversational companion while delegating bounded software work to Codex CLI.

## Operator setup

1. Install Codex CLI on the server: `npm install -g @openai/codex`
2. Authenticate once: `codex login --device-auth`
3. Create a clean development clone separate from production, for example `/srv/bytelight-workspace`.
4. Set these environment variables for the backend:

```bash
BYTELIGHT_CODE_DELEGATION_ENABLED=true
BYTELIGHT_CODE_WORKSPACE=/srv/bytelight-workspace
```

Restart Bytelight after changing its environment.

## Behavior

The OpenRouter/API-model tool belt exposes `delegate_code`:

- `mode: inspect` asks Codex to investigate with a read-only sandbox.
- `mode: edit` creates a `codex/<timestamp>-<task>` branch in the development clone, allows workspace writes, and returns Codex's report plus Git status and diff.
- `continue_existing: true` permits requested revisions to the currently pending Codex branch.

The tool never operates on the production checkout. Its operating contract forbids reading secret-bearing paths and forbids commits, pushes, merges, deployments, production restarts, and remote changes. A new edit fails closed while an earlier branch still contains unreviewed changes.

Set `BYTELIGHT_CODE_DELEGATION_ENABLED=false` and restart to remove the coding hand immediately.

## Consent boundary

Read-only inspection may be delegated when useful. File edits require a clear owner request to implement, fix, or change code. Deployment and publication remain separate, owner-approved actions.
