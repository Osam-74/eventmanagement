#!/usr/bin/env node
/**
 * Generates a PLACEHOLDER QR-ready template (1070x1470) that matches the
 * approved geometry: gold frame in the lower-center area with a clean white
 * interior for the QR. For LOCAL PIPELINE TESTING ONLY — replace it with the
 * real approved artwork by uploading it on the Templates page.
 */
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const W = 1070, H = 1470;
// approved QR frame (spec §4): outer gold frame ~x403..663, y963..1209
const FX = 403, FY = 963, FS = 260;

const svg = `
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#faf7f2"/>
  <rect x="60" y="60" width="${W - 120}" height="${H - 120}" fill="none" stroke="#b08d3f" stroke-width="3"/>
  <rect x="72" y="72" width="${W - 144}" height="${H - 144}" fill="none" stroke="#b08d3f" stroke-width="1"/>
  <circle cx="${W / 2}" cy="420" r="150" fill="none" stroke="#b08d3f" stroke-width="2"/>
  <text x="${W / 2}" y="430" font-family="DejaVu Sans, sans-serif" font-size="60" fill="#b08d3f" text-anchor="middle">I &amp; S</text>
  <text x="${W / 2}" y="640" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#5a5347" text-anchor="middle">03 October 2026</text>
  <rect x="${FX}" y="${FY}" width="${FS}" height="${FS}" fill="#ffffff" stroke="#b08d3f" stroke-width="4"/>
  <rect x="${FX + 12}" y="${FY + 12}" width="${FS - 24}" height="${FS - 24}" fill="none" stroke="#b08d3f" stroke-width="1"/>
  <text x="${W / 2}" y="${FY + FS + 45}" font-family="DejaVu Sans, sans-serif" font-size="24" fill="#8a7a5c" text-anchor="middle">Access code</text>
</svg>`;

mkdirSync('public/assets', { recursive: true });
await sharp(Buffer.from(svg)).png().toFile('public/assets/sample-template.png');
console.log('Wrote public/assets/sample-template.png (sample only — not the approved artwork).');
