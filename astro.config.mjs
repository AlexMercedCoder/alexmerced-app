// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { EnumChangefreq } from 'sitemap';

export default defineConfig({
  site: 'https://alexmerced.app',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  integrations: [
    sitemap({
      // The directory is the entry point; the app pages are the substance.
      serialize(item) {
        const path = new URL(item.url).pathname;
        item.changefreq = EnumChangefreq.MONTHLY;
        item.priority = path === '/' ? 1 : path === '/about/' ? 0.5 : 0.8;
        return item;
      },
    }),
  ],
});
