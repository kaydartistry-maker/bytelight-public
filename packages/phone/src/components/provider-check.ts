import { apiFetch } from '../bytelight';

type EditableProvider = 'ollama' | 'openai';
type FixedProvider = 'openrouter' | 'groq' | 'xai';

export type ProviderCheckInput =
  | { provider: EditableProvider; baseUrl: string; apiKey: string }
  | { provider: FixedProvider; apiKey: string };

export type ProviderCheckResult =
  | { kind: 'success'; models: number }
  | { kind: 'failure'; error: string };

export type ProviderCheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'complete'; result: ProviderCheckResult };

const FIXED_BASE_URLS: Record<FixedProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
};

export function providerCheckBody(input: ProviderCheckInput): { provider: string; base_url: string; api_key?: string } {
  const baseUrl = 'baseUrl' in input ? input.baseUrl : FIXED_BASE_URLS[input.provider];
  return { provider: input.provider, base_url: baseUrl, ...(input.apiKey && !input.apiKey.startsWith('•') ? { api_key: input.apiKey } : {}) };
}

export async function checkProvider(input: ProviderCheckInput): Promise<ProviderCheckResult> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await apiFetch('/api/models/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(providerCheckBody(input)),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object') return { kind: 'failure', error: `Check failed (${response.status})` };
    const record = payload as Record<string, unknown>;
    if (response.ok && record.ok === true) return { kind: 'success', models: typeof record.models === 'number' ? record.models : 0 };
    return { kind: 'failure', error: typeof record.error === 'string' ? record.error : `Check failed (${response.status})` };
  } catch (cause) {
    return { kind: 'failure', error: cause instanceof DOMException && cause.name === 'AbortError' ? 'Timed out after 8s' : cause instanceof Error ? cause.message : 'Check failed' };
  } finally {
    window.clearTimeout(timeout);
  }
}
