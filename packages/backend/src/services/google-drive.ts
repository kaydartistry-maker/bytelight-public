import { randomUUID } from 'node:crypto';
import { deleteSecret, getSecret, setSecret } from './secrets.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_URL = 'https://www.googleapis.com/drive/v3';
const DOCS_URL = 'https://docs.googleapis.com/v1';
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/documents',
];

type PendingLogin = { redirectUri: string; expiresAt: number };
const pending = new Map<string, PendingLogin>();
let access: { token: string; expiresAt: number } | null = null;

export class GoogleDriveError extends Error {
  constructor(message: string, public readonly status = 500) { super(message); }
}

function credentials(): { clientId: string; clientSecret: string } {
  const clientId = getSecret('google_drive_client_id');
  const clientSecret = getSecret('google_drive_client_secret');
  if (!clientId || !clientSecret) throw new GoogleDriveError('Google OAuth client ID and secret are required first.', 409);
  return { clientId, clientSecret };
}

async function tokenRequest(body: URLSearchParams): Promise<any> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as any;
  if (!res.ok) throw new GoogleDriveError(data.error_description || data.error || `Google token request failed (${res.status}).`, 502);
  return data;
}

export function googleDriveConfigured(): boolean {
  return Boolean(getSecret('google_drive_client_id') && getSecret('google_drive_client_secret'));
}

export function googleDriveConnected(): boolean {
  return Boolean(getSecret('google_drive_refresh_token'));
}

export function beginGoogleDriveLogin(redirectUri: string): string {
  const { clientId } = credentials();
  const state = randomUUID();
  pending.set(state, { redirectUri, expiresAt: Date.now() + 10 * 60_000 });
  for (const [key, value] of pending) if (value.expiresAt < Date.now()) pending.delete(key);
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  }).toString();
  return url.toString();
}

export async function finishGoogleDriveLogin(state: string, code: string): Promise<void> {
  const login = pending.get(state);
  pending.delete(state);
  if (!login || login.expiresAt < Date.now()) throw new GoogleDriveError('This Google sign-in expired. Start it again.', 400);
  const { clientId, clientSecret } = credentials();
  const data = await tokenRequest(new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: login.redirectUri,
    grant_type: 'authorization_code',
  }));
  if (!data.refresh_token) throw new GoogleDriveError('Google did not return a refresh token. Revoke the old grant and connect again.', 502);
  setSecret('google_drive_refresh_token', String(data.refresh_token));
  access = data.access_token ? { token: String(data.access_token), expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 } : null;
}

export async function disconnectGoogleDrive(): Promise<void> {
  const token = getSecret('google_drive_refresh_token');
  if (token) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch { /* local disconnect must still succeed if Google is unreachable */ }
  }
  deleteSecret('google_drive_refresh_token');
  access = null;
}

async function accessToken(): Promise<string> {
  if (access && access.expiresAt > Date.now() + 60_000) return access.token;
  const refreshToken = getSecret('google_drive_refresh_token');
  if (!refreshToken) throw new GoogleDriveError('Google Drive is not connected.', 409);
  const { clientId, clientSecret } = credentials();
  const data = await tokenRequest(new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  }));
  access = { token: String(data.access_token), expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return access.token;
}

async function googleJson(url: string, init: RequestInit = {}): Promise<any> {
  const token = await accessToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    signal: init.signal || AbortSignal.timeout(25_000),
  });
  const data = await res.json().catch(() => ({})) as any;
  if (!res.ok) {
    const message = data?.error?.message || `Google request failed (${res.status}).`;
    throw new GoogleDriveError(message, res.status === 401 ? 409 : 502);
  }
  return data;
}

export async function googleDriveStatus(): Promise<{ configured: boolean; connected: boolean; account?: string }> {
  const configured = googleDriveConfigured();
  const connected = googleDriveConnected();
  if (!connected) return { configured, connected };
  try {
    const data = await googleJson(`${DRIVE_URL}/about?fields=user(displayName,emailAddress)`);
    return { configured, connected, account: data.user?.emailAddress || data.user?.displayName };
  } catch {
    return { configured, connected };
  }
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function searchGoogleDocs(query: string, limit = 10): Promise<Array<Record<string, unknown>>> {
  const clean = query.trim();
  if (!clean) throw new GoogleDriveError('A search query is required.', 400);
  const q = `mimeType = 'application/vnd.google-apps.document' and trashed = false and fullText contains '${escapeDriveQuery(clean)}'`;
  const params = new URLSearchParams({
    q,
    pageSize: String(Math.max(1, Math.min(25, Math.floor(limit)))),
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,modifiedTime,webViewLink,parents,description)',
  });
  const data = await googleJson(`${DRIVE_URL}/files?${params}`);
  return Array.isArray(data.files) ? data.files : [];
}

function textFromStructuralElements(elements: any[] | undefined): string {
  if (!Array.isArray(elements)) return '';
  let out = '';
  for (const element of elements) {
    if (element.paragraph?.elements) {
      for (const part of element.paragraph.elements) out += part.textRun?.content || '';
    }
    if (element.table?.tableRows) {
      for (const row of element.table.tableRows) for (const cell of row.tableCells || []) out += textFromStructuralElements(cell.content);
    }
    if (element.tableOfContents?.content) out += textFromStructuralElements(element.tableOfContents.content);
  }
  return out;
}

export async function readGoogleDoc(documentId: string): Promise<{ id: string; title: string; text: string; revisionId?: string }> {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(documentId)) throw new GoogleDriveError('A valid Google document ID is required.', 400);
  const doc = await googleJson(`${DOCS_URL}/documents/${encodeURIComponent(documentId)}?includeTabsContent=true`);
  let text = textFromStructuralElements(doc.body?.content);
  if (Array.isArray(doc.tabs)) {
    const walk = (tabs: any[]) => {
      for (const tab of tabs) {
        text += textFromStructuralElements(tab.documentTab?.body?.content);
        if (Array.isArray(tab.childTabs)) walk(tab.childTabs);
      }
    };
    walk(doc.tabs);
  }
  return { id: doc.documentId, title: doc.title || 'Untitled', text: text.slice(0, 120_000), revisionId: doc.revisionId };
}

export async function createGoogleDoc(title: string, content = ''): Promise<{ id: string; title: string; url: string }> {
  const cleanTitle = title.trim();
  if (!cleanTitle) throw new GoogleDriveError('A document title is required.', 400);
  const doc = await googleJson(`${DOCS_URL}/documents`, { method: 'POST', body: JSON.stringify({ title: cleanTitle }) });
  if (content) await googleJson(`${DOCS_URL}/documents/${encodeURIComponent(doc.documentId)}:batchUpdate`, {
    method: 'POST', body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }),
  });
  return { id: doc.documentId, title: doc.title || cleanTitle, url: `https://docs.google.com/document/d/${doc.documentId}/edit` };
}

export async function appendGoogleDoc(documentId: string, text: string): Promise<{ id: string; title: string; appendedCharacters: number }> {
  if (!text) throw new GoogleDriveError('Text to append is required.', 400);
  const doc = await googleJson(`${DOCS_URL}/documents/${encodeURIComponent(documentId)}?fields=documentId,title,body.content.endIndex`);
  const content = Array.isArray(doc.body?.content) ? doc.body.content : [];
  const endIndex = Math.max(1, Number(content.at(-1)?.endIndex || 2) - 1);
  await googleJson(`${DOCS_URL}/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
    method: 'POST', body: JSON.stringify({ requests: [{ insertText: { location: { index: endIndex }, text } }] }),
  });
  return { id: doc.documentId, title: doc.title || 'Untitled', appendedCharacters: text.length };
}

export function resetGoogleDriveForTest(): void { access = null; pending.clear(); }
