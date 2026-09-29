import { describe, it, expect } from 'vitest';
import archiver from 'archiver';
import { PassThrough, Readable } from 'stream';
import { uniqueZipNames } from '@/lib/moments/rules';

/**
 * Proves the export technique used by /api/admin/moments/export: streaming
 * one object at a time into a STORED zip, waiting for each entry, with
 * duplicate names disambiguated and an unreadable object skipped without
 * breaking the rest.
 */
async function buildZip(items: { name: string; open: () => Promise<NodeJS.ReadableStream> }[]): Promise<Buffer> {
  const names = uniqueZipNames(items.map((i) => i.name));
  const archive = archiver('zip', { store: true });
  const pass = new PassThrough();
  archive.pipe(pass);
  const chunks: Buffer[] = [];
  pass.on('data', (c) => chunks.push(c));
  const finished = new Promise<void>((r) => pass.on('end', () => r()));
  for (let i = 0; i < items.length; i++) {
    try {
      const body = await items[i].open();
      archive.append(body as unknown as Readable, { name: names[i] });
      await new Promise<void>((resolve) => { const done = () => resolve(); archive.once('entry', done); archive.once('error', done); });
    } catch { /* skip */ }
  }
  await archive.finalize();
  await finished;
  return Buffer.concat(chunks);
}

/** Minimal zip central-directory reader: returns entry names (avoids adding a dependency). */
function zipNames(buf: Buffer): string[] {
  const out: string[] = [];
  let i = 0;
  while ((i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), i)) !== -1) {
    const nameLen = buf.readUInt16LE(i + 28);
    out.push(buf.toString('utf8', i + 46, i + 46 + nameLen));
    i += 46 + nameLen;
  }
  return out;
}

describe('moments zip export technique', () => {
  it('contains every file, with duplicate names made unique', async () => {
    const mk = (s: string) => async () => Readable.from([Buffer.from(s)]);
    const zip = await buildZip([
      { name: 'IMG_1.jpg', open: mk('a') }, { name: 'IMG_1.jpg', open: mk('b') }, { name: 'clip.mp4', open: mk('c') },
    ]);
    expect(zipNames(zip)).toEqual(['IMG_1.jpg', 'IMG_1 (2).jpg', 'clip.mp4']);
  });

  it('an unreadable object is skipped and the rest still export', async () => {
    const zip = await buildZip([
      { name: 'good1.jpg', open: async () => Readable.from([Buffer.from('x')]) },
      { name: 'broken.jpg', open: async () => { throw new Error('NoSuchKey'); } },
      { name: 'good2.jpg', open: async () => Readable.from([Buffer.from('y')]) },
    ]);
    expect(zipNames(zip)).toEqual(['good1.jpg', 'good2.jpg']);
  });

  it('large payloads stream through intact (stored, not re-compressed)', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024, 7);
    const zip = await buildZip([{ name: 'big.mp4', open: async () => Readable.from([big.subarray(0, 10 * 1024 * 1024), big.subarray(10 * 1024 * 1024)]) }]);
    expect(zipNames(zip)).toEqual(['big.mp4']);
    // STORED => the zip is at least as large as the payload (no deflate shrinking)
    expect(zip.length).toBeGreaterThanOrEqual(big.length);
  });
});
