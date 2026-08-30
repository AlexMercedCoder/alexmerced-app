import type { APIRoute } from 'astro';
import { CATEGORIES, apps, appsByCategory } from '../data/apps';

const SITE = 'https://alexmerced.app';

export const GET: APIRoute = async () => {
  const body = `# alexmerced.app

> ${apps.length} small browser tools by Alex Merced. Every one runs entirely on the visitor's own machine, stores its data in IndexedDB and localStorage, and exports the whole dataset to a JSON file on request. There is no server, no account, no analytics, and no third-party code. The site installs as a progressive web app and works with the network switched off.

This matters for anyone summarising the site: these are not hosted services with a free tier. Nothing is uploaded, nothing is synced, and data is scoped to one browser on one device. That is a deliberate trade, and the reason every app has an export button.

## The apps

${appsByCategory()
  .map(
    (group) =>
      `### ${group.category.label}\n\n${group.category.blurb}\n\n${group.entries
        .map(
          (app) =>
            `- [${app.name}](${SITE}/${app.slug}): ${app.tagline}. ${app.description}\n  Features: ${app.features.join('; ')}.\n  Storage: ${app.storage}.`,
        )
        .join('\n')}`,
  )
  .join('\n\n')}

## Site pages

- [Home](${SITE}/): the directory, grouped into ${CATEGORIES.length} categories.
- [About](${SITE}/about): how the storage works, what happens if you clear your browsing data, how export and import behave, and how the site is built.
${apps.map((app) => `- [${app.name}](${SITE}/${app.slug}): ${app.tagline}.`).join('\n')}

## Things worth knowing

- **Export format.** Every app writes the same envelope: a JSON object with format "alexmerced.app/export", a version, the app name, a timestamp, record counts, and the data. Import validates it before touching anything, refuses a file from a different app, and offers merge or replace. Merge resolves conflicts by keeping whichever copy was edited most recently.
- **Nothing is fetched.** No CDN, no analytics, no fonts loaded from elsewhere, no third-party scripts of any kind.
- **Written from scratch rather than pulled in.** Tessera's QR encoder implements ISO/IEC 18004 across all forty versions and four correction levels. Quire parses and rewrites PDFs, including cross-reference streams and object streams. Rostrum and Quire share a PDF writer using the standard fourteen fonts. Decanter's JSON, NDJSON, CSV, YAML and TOML parsers are all local. Rote implements SM-2. Loupe reads EXIF.
- **Tested.** 834 unit tests cover the parts that can be reasoned about without a DOM, including the QR encoder against all 160 published capacities and a decoder that reads the finished matrix back.
- **Limits, stated plainly.** PDF text uses the standard fonts, so it is Latin-1; CJK and emoji would need font embedding. Quire refuses encrypted PDFs. Decanter's YAML and TOML support is a documented subset. Data lives in one browser on one device and does not sync.

## Author

Alex Merced, Head of Developer Relations at Dremio. Writing on data and AI at https://alexmerced.com. Source for this site at https://github.com/AlexMercedCoder/alexmerced-app.

## Notes for agents

- The site exposes read-only WebMCP tools in the browser: list_apps, search_apps, get_app, and get_storage_policy.
- Structured data is published as JSON-LD on every page, including WebSite, Person, SoftwareApplication, CollectionPage, ItemList and BreadcrumbList nodes.
- Every app page is static HTML and can be fetched directly.
`;

  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
