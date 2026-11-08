import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess({ script: true }),
  kit: {
    // Where classic is served. The phone app owns the front door now, so
    // classic lives at /classic. Every link reads it through `base` from
    // $app/paths, so the move was this one value.
    paths: { base: '/classic' },
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
