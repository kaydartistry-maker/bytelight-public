import { writable } from 'svelte/store';
import { BuilderController, createBuilderApi } from './builder-client.js';
export const builder = new BuilderController(createBuilderApi());
export const builderView = writable<{ open: boolean; jobId: string | null }>({ open: false, jobId: null });
export function openBuilder(id?: string | null) { builderView.set({ open: true, jobId: id || null }); if (id) builder.select(id); }
export function closeBuilder() { builderView.update(view => ({ ...view, open: false })); }
