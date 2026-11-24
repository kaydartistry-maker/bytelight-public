import { apiFetch } from '../../bytelight';
export interface StyleReference { id: string; filename: string; name: string; url: string }
export interface SavedStyle { id: string; title: string; prompt: string; references: StyleReference[]; revision: number }
export interface StyleLibrary { styles: SavedStyle[]; defaultChatStyleId: string | null }
export interface ImageModel { id: string; label: string; backend: string; metered: boolean }
export interface ImageSettings {
  settings: { enabled: boolean; quality: string; hasOpenaiKey: boolean; hasOpenRouterKey: boolean; monthlyBudgetUsd: number };
  models: ImageModel[]; allowMeteredImages: boolean; chatImageModel: string; monthlySpendUsd: number;
}
export async function studioRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const form = body instanceof FormData;
  const r = await apiFetch(`/api/studio/${path}`, { method, ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body), headers: form ? undefined : { 'Content-Type': 'application/json' } }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Studio could not complete that request.');
  return data as T;
}
export function stylePromptPreview(scene: string, style?: SavedStyle) {
  return style?.prompt.trim() ? `${style.prompt}\n\nScene: ${scene.trim()}` : scene.trim();
}
