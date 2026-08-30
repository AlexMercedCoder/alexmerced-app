/**
 * Turning a deck into pixels, into a PDF, and into one standalone HTML file.
 * Kept apart from the editor so the same layout rules serve all three.
 */
import { PdfDocument, hexToRgb, measureText, wrapText, type StandardFont } from '../../lib/pdf/write';
import { slideDimensions, themeOf, type Block, type Deck, type Slide } from './model';

/** Renders one slide into a container as absolutely positioned elements. */
export function renderSlide(slide: Slide, deck: Deck, into: HTMLElement, images: Map<string, string>): void {
  const theme = themeOf(deck);
  into.innerHTML = '';
  into.style.background = slide.background ?? theme.background;
  into.style.color = theme.text;
  into.dataset.layout = slide.layout;
  into.style.setProperty('--slide-accent', theme.accent);
  into.style.fontFamily = theme.mono ? 'var(--mono)' : 'var(--sans)';

  const content = document.createElement('div');
  content.className = 'rs-slide__content';

  for (const block of slide.blocks) {
    if (block.type === 'divider') {
      const rule = document.createElement('hr');
      rule.className = 'rs-b rs-b--divider';
      content.appendChild(rule);
      continue;
    }

    if (block.type === 'image') {
      const url = block.imageId ? images.get(block.imageId) : undefined;
      const figure = document.createElement('div');
      figure.className = 'rs-b rs-b--image';
      if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = block.text || '';
        figure.appendChild(img);
      } else {
        figure.textContent = 'Image not on this device';
        figure.dataset.missing = 'true';
      }
      content.appendChild(figure);
      continue;
    }

    const element = document.createElement(block.type === 'bullet' ? 'li' : block.type === 'code' ? 'pre' : 'p');
    element.className = `rs-b rs-b--${block.type}`;
    element.textContent = block.text;
    content.appendChild(element);
  }

  into.appendChild(content);
}

// --------------------------------------------------------------------- PDF

const FONT_FOR: Record<string, StandardFont> = {
  title: 'Helvetica-Bold',
  subtitle: 'Helvetica',
  bullet: 'Helvetica',
  text: 'Helvetica',
  quote: 'Helvetica-Oblique',
  code: 'Courier',
};

const SIZE_FOR: Record<string, number> = {
  title: 44, subtitle: 26, bullet: 22, text: 22, quote: 26, code: 16,
};

/**
 * One page per slide. Text is laid out with the same measured wrapping the PDF
 * writer uses, so what comes out matches what the slide says.
 */
export async function toPdf(deck: Deck, images: Map<string, Uint8Array>): Promise<Uint8Array> {
  const { width, height } = slideDimensions(deck.ratio);
  const theme = themeOf(deck);
  const doc = new PdfDocument({ title: deck.title, creator: 'Rostrum on alexmerced.app' });

  const margin = width * 0.09;
  const measure = width - margin * 2;

  for (const slide of deck.slides) {
    const page = doc.addPage(width, height);
    const background = hexToRgb(slide.background ?? theme.background);
    const text = hexToRgb(theme.text);
    const accent = hexToRgb(theme.accent);

    page.rect(0, 0, width, height, { fill: background });

    const centred = slide.layout === 'title' || slide.layout === 'centered' || slide.layout === 'statement';

    // Measure first so a centred slide can be positioned vertically.
    let totalHeight = 0;
    const measured = slide.blocks.map((block) => {
      if (block.type === 'divider') return { block, lines: [] as string[], size: 0, height: 26 };
      if (block.type === 'image') return { block, lines: [] as string[], size: 0, height: height * 0.4 };
      const size = SIZE_FOR[block.type] ?? 22;
      const font = FONT_FOR[block.type] ?? 'Helvetica';
      const prefix = block.type === 'bullet' ? '•  ' : '';
      const lines = wrapText(prefix + block.text, font, size, measure);
      const blockHeight = lines.length * size * 1.35 + size * 0.55;
      return { block, lines, size, height: blockHeight };
    });
    for (const entry of measured) totalHeight += entry.height;

    let cursor = centred ? Math.max(margin, (height - totalHeight) / 2) : margin;

    for (const entry of measured) {
      const { block, lines, size } = entry;

      if (block.type === 'divider') {
        page.line(margin, cursor + 12, width - margin, cursor + 12, { color: accent, width: 2 });
        cursor += entry.height;
        continue;
      }

      if (block.type === 'image') {
        const bytes = block.imageId ? images.get(block.imageId) : undefined;
        if (bytes && bytes[0] === 0xff && bytes[1] === 0xd8) {
          try {
            const { jpegImage } = await import('../../lib/pdf/write');
            const resource = jpegImage(bytes);
            const scale = Math.min(measure / resource.width, entry.height / resource.height);
            const drawWidth = resource.width * scale;
            const drawHeight = resource.height * scale;
            page.image(resource, (width - drawWidth) / 2, cursor, drawWidth, drawHeight);
          } catch { /* an image that cannot be embedded is simply left out */ }
        }
        cursor += entry.height;
        continue;
      }

      const font = FONT_FOR[block.type] ?? 'Helvetica';
      const color = block.type === 'title' || block.type === 'quote' ? accent : text;

      for (const line of lines) {
        const x = centred ? margin + (measure - measureText(line, font, size)) / 2 : margin;
        page.text(line, x, cursor, { font, size, color });
        cursor += size * 1.35;
      }
      cursor += size * 0.55;
    }
  }

  return doc.build();
}

// --------------------------------------------------------------------- HTML

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/**
 * A single file that runs anywhere, with the images inlined as data URIs and
 * no network access of any kind. Useful on a machine that is not yours.
 */
export function toStandaloneHtml(deck: Deck, images: Map<string, string>): string {
  const theme = themeOf(deck);
  const { width, height } = slideDimensions(deck.ratio);

  const slideHtml = deck.slides.map((slide) => {
    const blocks = slide.blocks.map((block: Block) => {
      if (block.type === 'divider') return '<hr class="b b--divider" />';
      if (block.type === 'image') {
        const url = block.imageId ? images.get(block.imageId) : undefined;
        return url
          ? `<div class="b b--image"><img src="${url}" alt="${escapeHtml(block.text)}" /></div>`
          : '<div class="b b--image" data-missing>Image not included</div>';
      }
      const tag = block.type === 'bullet' ? 'li' : block.type === 'code' ? 'pre' : 'p';
      return `<${tag} class="b b--${block.type}">${escapeHtml(block.text)}</${tag}>`;
    }).join('\n');

    return `<section class="slide" data-layout="${slide.layout}"${slide.background ? ` style="background:${slide.background}"` : ''}>
  <div class="content">${blocks}</div>
  <div class="notes" hidden>${escapeHtml(slide.notes)}</div>
</section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(deck.title)}</title>
<style>
  :root {
    --bg: ${theme.background};
    --fg: ${theme.text};
    --accent: ${theme.accent};
    --w: ${width};
    --h: ${height};
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #000; color: var(--fg);
    font-family: ${theme.mono ? 'var(--mono)' : 'var(--sans)'}; overflow: hidden; }
  #stage { position: fixed; inset: 0; display: grid; place-items: center; }
  .slide {
    width: ${width}px; height: ${height}px; background: var(--bg); color: var(--fg);
    display: none; padding: 8% 9%; position: relative;
    transform-origin: center; flex-direction: column; justify-content: flex-start;
  }
  .slide.is-current { display: flex; }
  .content { display: flex; flex-direction: column; gap: 0.5em; width: 100%; }
  .slide[data-layout='title'] .content,
  .slide[data-layout='centered'] .content,
  .slide[data-layout='statement'] .content { justify-content: center; text-align: center; height: 100%; }
  .slide[data-layout='two-column'] .content { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5em 2em; align-content: start; }
  .b { margin: 0; }
  .b--title { font-size: 44px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; color: var(--accent); }
  .b--subtitle { font-size: 26px; opacity: .85; }
  .b--bullet { font-size: 22px; line-height: 1.5; margin-left: 1.2em; }
  .b--text { font-size: 22px; line-height: 1.5; }
  .b--quote { font-size: 26px; font-style: italic; color: var(--accent); border-left: 4px solid var(--accent); padding-left: 0.6em; }
  .b--code { font-family: var(--mono); font-size: 16px; line-height: 1.5; background: rgba(127,127,127,.16); padding: 0.7em 0.9em; border-radius: 6px; white-space: pre-wrap; }
  .b--divider { border: 0; border-top: 2px solid var(--accent); width: 100%; opacity: .6; }
  .b--image img { max-width: 100%; max-height: ${Math.round(height * 0.55)}px; object-fit: contain; }
  .b--image[data-missing] { opacity: .5; font-size: 18px; }
  #hud { position: fixed; bottom: 12px; right: 16px; font: 13px var(--mono); color: #888; }
  #help { position: fixed; bottom: 12px; left: 16px; font: 12px var(--mono); color: #666; }
</style>
</head>
<body>
<div id="stage">
${slideHtml}
</div>
<div id="hud"></div>
<div id="help">arrows or space to move · f for fullscreen</div>
<script>
  const slides = [...document.querySelectorAll('.slide')];
  const hud = document.getElementById('hud');
  const stage = document.getElementById('stage');
  let current = 0;

  function fit() {
    const scale = Math.min(window.innerWidth / ${width}, window.innerHeight / ${height});
    for (const slide of slides) slide.style.transform = 'scale(' + scale + ')';
  }

  function show(index) {
    current = Math.max(0, Math.min(slides.length - 1, index));
    slides.forEach((slide, i) => slide.classList.toggle('is-current', i === current));
    hud.textContent = (current + 1) + ' / ' + slides.length;
    location.hash = String(current + 1);
  }

  addEventListener('keydown', (event) => {
    if (['ArrowRight', 'ArrowDown', ' ', 'PageDown'].includes(event.key)) { event.preventDefault(); show(current + 1); }
    if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); show(current - 1); }
    if (event.key === 'Home') show(0);
    if (event.key === 'End') show(slides.length - 1);
    if (event.key === 'f') document.documentElement.requestFullscreen?.();
  });

  addEventListener('resize', fit);
  addEventListener('hashchange', () => show(Number(location.hash.slice(1)) - 1 || 0));
  stage.addEventListener('click', (event) => show(current + (event.clientX > window.innerWidth / 2 ? 1 : -1)));

  fit();
  show(Number(location.hash.slice(1)) - 1 || 0);
</script>
</body>
</html>`;
}
