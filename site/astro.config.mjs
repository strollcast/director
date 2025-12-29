import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import auth from 'auth-astro';

export default defineConfig({
  site: 'https://strollcast.com',
  output: 'server',
  adapter: cloudflare({
    platformProxy: {
      enabled: true,
    },
  }),
  integrations: [auth()],
});
