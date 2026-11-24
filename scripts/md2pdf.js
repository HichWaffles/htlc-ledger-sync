// scripts/md2pdf.js : Markdown (with Mermaid diagrams and images) -> A4 PDF, through headless Chromium.
// usage: node scripts/md2pdf.js docs/REPORT.md [out.pdf]
// needs Playwright once:  npm i --no-save playwright && npx playwright install chromium
// (or point PLAYWRIGHT to an existing install: PLAYWRIGHT=/path/to/node_modules/playwright)
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const src = path.resolve(process.argv[2] || 'docs/REPORT.md');
const out = path.resolve(process.argv[3] || src.replace(/\.md$/, '.pdf'));
const md = fs.readFileSync(src, 'utf8');

const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 18mm 16mm 18mm 16mm; }
  body { font: 10.5pt/1.45 "Segoe UI", system-ui, -apple-system, sans-serif; color: #1f2328; }
  h1 { font-size: 19pt; margin: 0 0 10pt; border-bottom: 1.5px solid #1f2328; padding-bottom: 6pt; }
  h2 { font-size: 13.5pt; margin: 18pt 0 6pt; break-after: avoid; }
  h3 { font-size: 11.5pt; margin: 12pt 0 4pt; break-after: avoid; }
  p, li { margin: 4pt 0; }
  ul, ol { padding-left: 18pt; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 9.5pt; break-inside: avoid; }
  th, td { border: 1px solid #d0d7de; padding: 4pt 6pt; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  code { font: 9pt ui-monospace, Consolas, monospace; background: #f6f8fa; padding: 0 3pt; border-radius: 3px; }
  pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 5px; padding: 8pt; overflow: hidden; break-inside: avoid; }
  pre code { background: none; padding: 0; font-size: 8.5pt; white-space: pre-wrap; }
  img { max-width: 100%; border: 1px solid #d0d7de; border-radius: 4px; margin: 6pt 0 2pt; break-inside: avoid; }
  figure { margin: 8pt 0; break-inside: avoid; }
  figcaption { font-size: 8.5pt; color: #57606a; margin-top: 2pt; }
  .mermaid { text-align: center; margin: 8pt 0; break-inside: avoid; }
  .mermaid svg { max-width: 100%; height: auto; }
  a { color: #0969da; text-decoration: none; word-break: break-all; }
  em { color: #57606a; }
</style></head><body><main id="doc"></main>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
<script>
  const md = ${JSON.stringify(md)};
  const r = new marked.Renderer();
  const code = r.code.bind(r);
  r.image = (href, title, text) => '<figure><img src="' + href + '" alt="' + text.replace(/"/g, '&quot;') + '"><figcaption>' + text + '</figcaption></figure>';
  r.code = (text, lang) => lang === 'mermaid' ? '<div class="mermaid">' + text.replace(/</g, '&lt;') + '</div>' : code(text, lang);
  document.getElementById('doc').innerHTML = marked.parse(md, { renderer: r });
  mermaid.initialize({ startOnLoad: false, theme: 'neutral', flowchart: { useMaxWidth: true }, sequence: { useMaxWidth: true } });
  mermaid.run().then(() => { document.title = 'ready'; }).catch((e) => { document.title = 'error: ' + e.message; });
</script></body></html>`;

(async () => {
  const tmp = path.join(path.dirname(src), `.${path.basename(src)}.html`);   // next to the .md so images resolve
  fs.writeFileSync(tmp, html);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(tmp).href);
    await page.waitForFunction(() => document.title === 'ready' || document.title.startsWith('error'), null, { timeout: 60000 });
    const title = await page.title();
    if (title !== 'ready') throw new Error(`Mermaid ${title}`);
    await page.evaluate(() => { document.title = (document.querySelector('h1') || {}).textContent || 'Report'; });   // PDF title metadata
    await page.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((ok) => { i.onload = i.onerror = ok; })))));
    await page.pdf({ path: out, format: 'A4', printBackground: true, displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8pt;color:#888;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
    console.log(`wrote ${path.relative(process.cwd(), out)}`);
  } finally {
    await browser.close();
    fs.rmSync(tmp, { force: true });
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
