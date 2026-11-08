import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess({ script: true }),
  kit: {
    // Where classic is served. '' while it still owns the front door; the
    // flip sets '/classic' (React takes '/'). Every link reads it through
    // `base` from $app/paths, so the move is this one value.
    paths: { base: '' },
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html',
      precompress: false,
      strict: false
    })
  }
};

export default config;
