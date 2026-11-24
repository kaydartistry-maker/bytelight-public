import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { appendGoogleDoc, createGoogleDoc, readGoogleDoc, searchGoogleDocs } from './google-drive.js';
import { errMessage } from '../util/errors.js';

const ok = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true });

export function getGoogleDocsMcpServer(context: { isAutonomous: boolean; ownerMessage: string }): McpSdkServerConfigWithInstance {
  const explicitCreate = /\b(create|make|write|save|put|add)\b[\s\S]{0,80}\b(doc|docs|drive|second brain)\b/i.test(context.ownerMessage);
  const explicitAppend = /\b(append|add|update|write|save|put)\b[\s\S]{0,80}\b(doc|docs|drive|second brain|it)\b/i.test(context.ownerMessage);
  const writable = (explicit: boolean) => !context.isAutonomous && explicit;

  return createSdkMcpServer({
    name: 'google-docs', version: '1.0.0', tools: [
      tool('google_docs_search', 'Search the connected Google Drive for native Google Docs by title or content. Read-only.', {
        query: z.string(), limit: z.number().int().min(1).max(25).optional(),
      }, async ({ query, limit }) => {
        try { return ok({ files: await searchGoogleDocs(query, limit ?? 10) }); } catch (e) { return fail(errMessage(e)); }
      }),
      tool('google_docs_read', 'Read a native Google Doc returned by google_docs_search. Read-only.', {
        document_id: z.string(),
      }, async ({ document_id }) => {
        try { return ok({ document: await readGoogleDoc(document_id) }); } catch (e) { return fail(errMessage(e)); }
      }),
      tool('google_docs_create', 'Create a native Google Doc only when the owner explicitly requested it in this interactive turn. Autonomous wakes cannot write.', {
        title: z.string(), content: z.string().optional(),
      }, async ({ title, content }) => {
        if (!writable(explicitCreate)) return fail('Google Docs writes require an explicit request in the current interactive owner message.');
        try { return ok({ document: await createGoogleDoc(title, content ?? '') }); } catch (e) { return fail(errMessage(e)); }
      }),
      tool('google_docs_append', 'Append text to a native Google Doc only when the owner explicitly requested it in this interactive turn. Autonomous wakes cannot write.', {
        document_id: z.string(), text: z.string(),
      }, async ({ document_id, text }) => {
        if (!writable(explicitAppend)) return fail('Google Docs writes require an explicit request in the current interactive owner message.');
        try { return ok({ document: await appendGoogleDoc(document_id, text) }); } catch (e) { return fail(errMessage(e)); }
      }),
    ],
  });
}
