#!/usr/bin/env node
// Draw Doorstub's icons and share image from SVG (no external assets):
//   app/public/favicon.svg, app/public/icon.png (512, the WizardConnect dapp icon),
//   app/public/bcmr/icon.png (256, the token icon in BCMR-aware wallets), app/public/og.png (1200x630).
// Run: node scripts/make-icons.js   (uses sharp, already installed as a wrangler dependency)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'public');
mkdirSync(join(root, 'bcmr'), { recursive: true });

const VERMILION = '#cf3b20';
const PAPER = '#f3ece0';
const INK = '#1d1813';

// A ticket stub with two notches and a perforation, on a rounded square.
const mark = ({ size, bg = PAPER, radius = 0.22 }) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  ${bg ? `<rect width="32" height="32" rx="${32 * radius}" fill="${bg}"/>` : ''}
  <g transform="translate(16 16) rotate(-8) translate(-16 -16)">
    <path d="M4 8.5a2.5 2.5 0 0 1 2.5-2.5h19a2.5 2.5 0 0 1 2.5 2.5v4.2a3.4 3.4 0 0 0 0 6.6v4.2a2.5 2.5 0 0 1-2.5 2.5h-19A2.5 2.5 0 0 1 4 23.5v-4.2a3.4 3.4 0 0 0 0-6.6z" fill="${VERMILION}"/>
    <path d="M21 7.6v16.8" stroke="${PAPER}" stroke-width="1.4" stroke-dasharray="1.8 1.9" stroke-linecap="round"/>
    <path d="M8.2 12.4h8.4M8.2 16h6M8.2 19.6h7.6" stroke="${PAPER}" stroke-width="1.8" stroke-linecap="round"/>
  </g>
</svg>`;

writeFileSync(join(root, 'favicon.svg'), mark({ size: 32, bg: null }));
await sharp(Buffer.from(mark({ size: 512 }))).png().toFile(join(root, 'icon.png'));
await sharp(Buffer.from(mark({ size: 256 }))).png().toFile(join(root, 'bcmr', 'icon.png'));

const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${PAPER}"/>
  <g opacity="0.07" fill="none" stroke="${VERMILION}">
    ${Array.from({ length: 40 }, (_, i) => `<circle cx="1260" cy="-80" r="${60 + i * 22}"/>`).join('')}
  </g>
  <rect x="0" y="0" width="1200" height="14" fill="${VERMILION}"/>
  <g transform="translate(80 92)">${mark({ size: 84, bg: null }).replace(/<\/?svg[^>]*>/g, '').replace('<g transform', '<g transform="scale(2.6)"><g transform').replace(/<\/g>\s*$/, '</g></g>')}</g>
  <text x="78" y="300" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="bold" font-size="96" letter-spacing="-1" fill="${INK}">TICKETS THAT</text>
  <text x="78" y="406" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="bold" font-size="96" letter-spacing="-1" fill="${INK}"><tspan fill="${VERMILION}">REFUND</tspan> THEMSELVES<tspan fill="${VERMILION}">.</tspan></text>
  <text x="82" y="488" font-family="'Avenir Next'" font-weight="500" font-size="32" fill="#594d42">The organiser is paid for each guest who walks in.</text>
  <text x="82" y="530" font-family="'Avenir Next'" font-weight="500" font-size="32" fill="#594d42">Every other ticket refunds.</text>
  <text x="82" y="592" font-family="Menlo, monospace" font-weight="700" font-size="24" fill="#85776a" letter-spacing="3">DOORSTUB · BITCOIN CASH</text>
</svg>`;
await sharp(Buffer.from(og)).png().toFile(join(root, 'og.png'));
console.log('wrote favicon.svg, icon.png, bcmr/icon.png, og.png');
