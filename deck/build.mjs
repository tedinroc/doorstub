#!/usr/bin/env node
// npm run deck: prints deck/deck.html to app/public/deck.pdf (seven 1920x1080
// pages, the short presentation the BLAZE banner links to) and saves a PNG
// preview of every page to .cache/deck/png/page-N.png.
//
// Before printing it checks the page: every font and picture loaded, no text
// under 34 px (code under 24 px), nothing outside its slide, and the code card
// equal to contracts/Escrow.cash lines 120 to 131. After printing it sets the
// PDF's title and author with pypdf and checks the pages, links and fonts.
// One headless Chrome, closed before the script ends. Offline: nothing is fetched.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SLIDES = 7;
const W = 1920;
const H = 1080;

const root = fileURLToPath(new URL('..', import.meta.url));
const html = join(root, 'deck', 'deck.html');
const out = join(root, 'app', 'public', 'deck.pdf');
const pngDir = join(root, '.cache', 'deck', 'png');
const tmp = mkdtempSync(join(tmpdir(), 'doorstub-deck-'));
const rawPdf = join(tmp, 'deck.raw.pdf');

const fail = (problems) => {
  rmSync(tmp, { recursive: true, force: true });
  console.error(`deck build FAILED (${problems.length}):\n  ${problems.join('\n  ')}`);
  process.exit(1);
};

// The code card must be the contract's own lines 120 to 131, minus the common 8-space indent.
const contract = readFileSync(join(root, 'contracts', 'Escrow.cash'), 'utf8').split('\n');
const codeLines = contract.slice(119, 131).map((line) => line.replace(/^ {8}/, '').replace(/\s+$/, ''));

let browser;
let report;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate', '--disable-background-networking', '--disable-sync'],
  });
  const page = await browser.newPage();
  // Offline: the deck loads only its own files.
  await page.setRequestInterception(true);
  page.on('request', (req) => (req.url().startsWith('file:') || req.url().startsWith('data:') ? req.continue() : req.abort()));
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  report = await page.evaluate(({ W, H, SLIDES, codeLines }) => {
    const problems = [];
    const faces = [...document.fonts];
    for (const f of faces) if (f.status !== 'loaded') problems.push(`font ${f.family} ${f.weight} did not load (${f.status})`);
    if (faces.length !== 6) problems.push(`expected 6 font faces, found ${faces.length}`);
    for (const img of document.images) if (!img.complete || img.naturalWidth === 0) problems.push(`picture ${img.getAttribute('src')} did not load`);

    const slides = [...document.querySelectorAll('.slide')];
    if (slides.length !== SLIDES) problems.push(`expected ${SLIDES} slides, found ${slides.length}`);
    slides.forEach((slide, i) => {
      const box = slide.getBoundingClientRect();
      if (box.width !== W || box.height !== H || box.top !== i * H) problems.push(`slide ${i + 1} is not ${W}x${H} at y ${i * H}`);
      const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent.trim() === '') continue;
        const el = node.parentElement;
        const size = parseFloat(getComputedStyle(el).fontSize);
        const min = el.closest('.code') ? 24 : 34;
        if (size < min) problems.push(`slide ${i + 1}: "${node.textContent.trim().slice(0, 40)}" is ${size}px (minimum ${min}px)`);
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          if (r.left < box.left + 40 || r.right > box.right - 40 || r.top < box.top + 30 || r.bottom > box.bottom - 30) {
            problems.push(`slide ${i + 1}: "${node.textContent.trim().slice(0, 40)}" runs into the page edge`);
          }
        }
      }
    });

    const shown = [...document.querySelectorAll('.code .ln')].map((ln) => {
      const c = ln.cloneNode(true);
      c.querySelector('.n')?.remove();
      return c.textContent;
    });
    if (JSON.stringify(shown) !== JSON.stringify(codeLines)) problems.push('the code card differs from contracts/Escrow.cash lines 120 to 131');

    const links = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    for (const href of links) if (!/^https:\/\//.test(href ?? '')) problems.push(`link ${href} is not an absolute https link`);
    return { problems, links, faces: faces.map((f) => `${f.family} ${f.weight}`) };
  }, { W, H, SLIDES, codeLines });
  // Stop here on a problem; the browser is closed below before the script exits.
  if (report.problems.length > 0) throw Object.assign(new Error('page check'), { problems: report.problems });

  await page.pdf({ path: rawPdf, width: `${W}px`, height: `${H}px`, printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });

  mkdirSync(pngDir, { recursive: true });
  for (let i = 0; i < SLIDES; i += 1) {
    await page.screenshot({ path: join(pngDir, `page-${i + 1}.png`), clip: { x: 0, y: i * H, width: W, height: H }, captureBeyondViewport: true });
  }
} catch (err) {
  await browser?.close();
  browser = undefined;
  fail(err.problems ?? [String(err?.stack ?? err)]);
} finally {
  await browser?.close();
}

// Title and author, then a look at what was printed: pages, links and fonts.
const PY = String.raw`
import json, sys
from pypdf import PdfReader, PdfWriter
src, dst = sys.argv[1], sys.argv[2]
writer = PdfWriter(clone_from=PdfReader(src))
writer.add_metadata({'/Title': 'Doorstub', '/Author': 'Ted Chen', '/Subject': 'Doorstub, a BCH BLAZE 2026 entry: tickets that refund themselves.'})
writer.compress_identical_objects()
with open(dst, 'wb') as f:
    writer.write(f)
r = PdfReader(dst)
uris, fonts, sizes = [], set(), set()
for p in r.pages:
    sizes.add((round(float(p.mediabox.width)), round(float(p.mediabox.height))))
    for a in p.get('/Annots') or []:
        a = a.get_object()
        act = a.get('/A')
        if act is not None and act.get_object().get('/URI'):
            uris.append(str(act.get_object()['/URI']))
    res = p.get('/Resources') or {}
    for f in (res.get('/Font') or {}).values():
        fonts.add(str(f.get_object().get('/BaseFont')))
print(json.dumps({'pages': len(r.pages), 'sizes': sorted(sizes), 'uris': uris, 'fonts': sorted(fonts), 'title': r.metadata.title, 'author': r.metadata.author}))
`;
const py = spawnSync('python3', ['-c', PY, rawPdf, out], { encoding: 'utf8' });
rmSync(tmp, { recursive: true, force: true });
if (py.status !== 0) fail([`pypdf step failed (needs python3 with pypdf): ${py.stderr.trim().split('\n').pop()}`]);
const pdf = JSON.parse(py.stdout);

const problems = [];
if (pdf.pages !== SLIDES) problems.push(`the PDF has ${pdf.pages} pages, not ${SLIDES}`);
// 1920x1080 CSS px print as 1440x810 pt.
if (pdf.sizes.length !== 1 || pdf.sizes[0][0] !== 1440 || pdf.sizes[0][1] !== 810) problems.push(`page size ${JSON.stringify(pdf.sizes)} is not 1440x810 pt (1920x1080 px)`);
for (const uri of pdf.uris) if (!/^https:\/\//.test(uri)) problems.push(`PDF link ${uri} is not https`);
if (new Set(pdf.uris).size !== new Set(report.links).size) problems.push(`the PDF has links ${JSON.stringify([...new Set(pdf.uris)])}, the page ${JSON.stringify([...new Set(report.links)])}`);
const stray = pdf.fonts.filter((f) => !/Barlow|InterDisplay|JetBrains/.test(f));
if (stray.length > 0) problems.push(`fallback fonts in the PDF (a glyph is missing from the deck fonts): ${stray.join(', ')}`);
if (pdf.title !== 'Doorstub' || pdf.author !== 'Ted Chen') problems.push('the PDF title or author is not set');
const bytes = statSync(out).size;
if (bytes > 4 * 1024 * 1024) problems.push(`the PDF is ${(bytes / 1024 / 1024).toFixed(2)} MB (limit 4 MB)`);
if (problems.length > 0) fail(problems);

console.log(`deck built: app/public/deck.pdf, ${pdf.pages} pages of ${W}x${H}, ${(bytes / 1024).toFixed(0)} KiB`);
console.log(`  fonts: ${pdf.fonts.join(', ')}`);
console.log(`  links: ${[...new Set(pdf.uris)].join(', ')}`);
console.log(`  previews: .cache/deck/png/page-1.png to page-${SLIDES}.png`);
