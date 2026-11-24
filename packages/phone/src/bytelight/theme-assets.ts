import { apiFetch } from './api';

export interface ThemeAsset {
  id: string; name: string; kind: 'image' | 'font'; mime: string; bytes: number;
  url: string; createdAt: string; fontFamily?: string;
}
async function responseJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Theme asset request failed');
  return body;
}
export async function listThemeAssets(): Promise<ThemeAsset[]> {
  const body = await responseJson(await apiFetch('/api/theme-assets'));
  if (!Array.isArray(body?.assets)) throw new Error('Invalid theme asset response');
  return body.assets;
}
export async function uploadThemeAsset(file: File, kind: 'image' | 'font'): Promise<ThemeAsset> {
  const body = new FormData(); body.append('file', file); body.append('kind', kind);
  const result = await responseJson(await apiFetch('/api/theme-assets', { method: 'POST', body }));
  if (!result?.asset?.id) throw new Error('Invalid theme asset response');
  return result.asset;
}
export async function deleteThemeAsset(id: string): Promise<void> {
  await responseJson(await apiFetch(`/api/theme-assets/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}
