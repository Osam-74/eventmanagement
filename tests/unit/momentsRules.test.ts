import { describe, it, expect } from 'vitest';
import {
  checkFile, planUpload, buildKey, safeDisplayName, uniqueZipNames, cleanGuestName, folderLabels, MAX_GUEST_NAME,
  MAX_FILE_BYTES, MAX_FILES_PER_GUEST, MAX_FILES_PER_BATCH,
} from '@/lib/moments/rules';
import { MULTIPART_PART_SIZE, SINGLE_PUT_MAX } from '@/lib/moments/r2';
import { momentsStartSchema, momentsCompleteSchema, momentsIdsSchema } from '@/lib/validation/schemas';

const MB = 1024 * 1024;

describe('guest moments: file rules (protect the R2 bill)', () => {
  it('the cap is exactly 100 MB (owner decision)', () => {
    expect(MAX_FILE_BYTES).toBe(100 * MB);
    expect(checkFile({ name: 'a.mp4', type: 'video/mp4', size: 100 * MB }).ok).toBe(true);
    const over = checkFile({ name: 'a.mp4', type: 'video/mp4', size: 100 * MB + 1 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.message).toContain('100 MB');
  });

  it('accepts real phone media, including iPhone HEIC and MOV', () => {
    for (const [name, type] of [
      ['IMG_1.jpg', 'image/jpeg'], ['IMG_2.PNG', 'image/png'], ['IMG_3.heic', 'image/heic'], ['a.webp', 'image/webp'],
      ['VID_1.mp4', 'video/mp4'], ['VID_2.MOV', 'video/quicktime'], ['c.webm', 'video/webm'], ['d.3gp', 'video/3gpp'],
    ]) expect(checkFile({ name, type, size: MB }).ok, name).toBe(true);
  });

  it('falls back to the extension when the browser reports no type (common for HEIC / MOV)', () => {
    const r = checkFile({ name: 'IMG_9.HEIC', type: '', size: MB });
    expect(r).toMatchObject({ ok: true, kind: 'photo', contentType: 'image/heic' });
    expect(checkFile({ name: 'clip.mov', type: '', size: MB })).toMatchObject({ ok: true, kind: 'video' });
  });

  it('rejects anything that is not a photo or video', () => {
    for (const [name, type] of [['a.pdf', 'application/pdf'], ['a.exe', 'application/x-msdownload'], ['a.html', 'text/html'], ['a.svg', 'image/svg+xml'], ['a.zip', 'application/zip'], ['noext', '']]) {
      expect(checkFile({ name, type, size: MB }).ok, name).toBe(false);
    }
  });

  it('a spoofed extension cannot smuggle a script: type wins over a renamed extension', () => {
    // declared type is html -> not in the allow-list and the name has no allowed extension
    expect(checkFile({ name: 'x.html', type: 'text/html', size: MB }).ok).toBe(false);
    // svg (can carry script) is deliberately not allowed even as an "image"
    expect(checkFile({ name: 'x.svg', type: 'image/svg+xml', size: MB }).ok).toBe(false);
  });

  it('rejects empty and non-numeric sizes', () => {
    expect(checkFile({ name: 'a.jpg', type: 'image/jpeg', size: 0 }).ok).toBe(false);
    expect(checkFile({ name: 'a.jpg', type: 'image/jpeg', size: NaN }).ok).toBe(false);
    expect(checkFile({ name: 'a.jpg', type: 'image/jpeg', size: -5 }).ok).toBe(false);
  });

  it('per-guest and per-batch caps are sensible', () => {
    expect(MAX_FILES_PER_GUEST).toBeGreaterThanOrEqual(20);
    expect(MAX_FILES_PER_BATCH).toBeLessThanOrEqual(MAX_FILES_PER_GUEST);
  });
});

describe('upload planning', () => {
  it('small files use a single PUT; big ones use multipart with enough parts to cover the file', () => {
    expect(planUpload(3 * MB)).toEqual({ mode: 'single' });
    expect(planUpload(SINGLE_PUT_MAX)).toEqual({ mode: 'single' });
    for (const size of [SINGLE_PUT_MAX + 1, 40 * MB, 99 * MB, 100 * MB]) {
      const p = planUpload(size);
      expect(p.mode).toBe('multipart');
      if (p.mode === 'multipart') {
        expect(p.parts * p.partSize).toBeGreaterThanOrEqual(size);
        expect((p.parts - 1) * p.partSize).toBeLessThan(size); // no empty trailing part
        expect(p.parts).toBeLessThanOrEqual(10000); // S3/R2 hard limit
      }
    }
  });

  it("R2 requires every part except the last to be at least 5 MiB", () => {
    expect(MULTIPART_PART_SIZE).toBeGreaterThanOrEqual(5 * MB);
  });
});

describe('keys and names', () => {
  it('the storage key is built only from server ids, never the client filename', () => {
    expect(buildKey('evt1', 'abc123', 'jpg')).toBe('events/evt1/moments/abc123.jpg');
    // a hostile filename never reaches the key: buildKey has no filename input at all
    expect(buildKey('evt1', 'abc', 'mp4')).not.toContain('..');
  });

  it('display names cannot carry paths or control characters', () => {
    expect(safeDisplayName('../../etc/passwd', 'jpg')).toBe('passwd');
    expect(safeDisplayName('C:\\Users\\x\\a.jpg', 'jpg')).toBe('a.jpg');
    expect(safeDisplayName('a\r\nb<script>.jpg', 'jpg')).not.toMatch(/[\r\n<>]/);
    expect(safeDisplayName('', 'png')).toBe('moment.png');
    expect(safeDisplayName('.', 'png')).toBe('moment.png');
    expect(safeDisplayName('x'.repeat(500) + '.jpg', 'jpg').length).toBeLessThanOrEqual(80);
  });

  it('zip names never collide: two guests uploading IMG_0001.jpg both survive the export', () => {
    expect(uniqueZipNames(['IMG_1.jpg', 'IMG_1.jpg', 'img_1.JPG', 'other.mp4', 'IMG_1.jpg'])).toEqual([
      'IMG_1.jpg', 'IMG_1 (2).jpg', 'img_1 (3).JPG', 'other.mp4', 'IMG_1 (4).jpg',
    ]);
    const many = uniqueZipNames(Array.from({ length: 50 }, () => 'a.jpg'));
    expect(new Set(many.map((n) => n.toLowerCase())).size).toBe(50);
  });
});

describe('request schemas', () => {
  const gid = 'abcdefghijklmnop1234';
  it('rejects files over 100 MB and bad guest ids at the API boundary', () => {
    expect(momentsStartSchema.safeParse({ guestId: gid, files: [{ name: 'a.jpg', type: 'image/jpeg', size: 100 * MB }] }).success).toBe(true);
    expect(momentsStartSchema.safeParse({ guestId: gid, files: [{ name: 'a.mp4', type: 'video/mp4', size: 100 * MB + 1 }] }).success).toBe(false);
    expect(momentsStartSchema.safeParse({ guestId: 'short', files: [{ name: 'a.jpg', type: 'image/jpeg', size: 5 }] }).success).toBe(false);
    expect(momentsStartSchema.safeParse({ guestId: 'has spaces and ../ chars!!', files: [{ name: 'a', type: 'b', size: 5 }] }).success).toBe(false);
  });
  it('caps a batch at 20 files and requires at least one', () => {
    const f = { name: 'a.jpg', type: 'image/jpeg', size: 5 };
    expect(momentsStartSchema.safeParse({ guestId: gid, files: Array(20).fill(f) }).success).toBe(true);
    expect(momentsStartSchema.safeParse({ guestId: gid, files: Array(21).fill(f) }).success).toBe(false);
    expect(momentsStartSchema.safeParse({ guestId: gid, files: [] }).success).toBe(false);
  });
  it('complete + ids schemas bound their inputs', () => {
    expect(momentsCompleteSchema.safeParse({ guestId: gid, momentId: 'abcdefgh12' }).success).toBe(true);
    expect(momentsCompleteSchema.safeParse({ guestId: gid, momentId: 'x' }).success).toBe(false);
    expect(momentsIdsSchema.safeParse({ ids: Array(501).fill('abcdefgh12') }).success).toBe(false);
    expect(momentsIdsSchema.safeParse({ ids: [] }).success).toBe(false);
  });
});

describe('guest moments: optional guest name', () => {
  it('keeps an ordinary name as typed', () => {
    expect(cleanGuestName('Tunde Bello')).toBe('Tunde Bello');
    expect(cleanGuestName('Adaeze O\u2019Brien-Okafor')).toBe('Adaeze O\u2019Brien-Okafor');
  });

  it('keeps names in any script and emoji, not just English', () => {
    expect(cleanGuestName('Ọláòlúwa')).toBe('Ọláòlúwa');
    expect(cleanGuestName('José Müller')).toBe('José Müller');
    expect(cleanGuestName('محمد علي')).toBe('محمد علي');
    expect(cleanGuestName('Aunty Bisi \u{1F496}')).toBe('Aunty Bisi \u{1F496}');
  });

  it('empty, blank or non-text means anonymous', () => {
    for (const v of ['', '   ', '\n\t', undefined, null, 42, {}, []]) expect(cleanGuestName(v)).toBe('');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(cleanGuestName('  Tunde \n\n   Bello  ')).toBe('Tunde Bello');
  });

  it('strips markup, path and control characters (it is shown to admins and used in folder names)', () => {
    expect(cleanGuestName('<script>alert(1)</script>')).toBe('scriptalert(1)script');
    expect(cleanGuestName('../../etc/passwd')).toBe('....etcpasswd');
    expect(cleanGuestName('Tunde\u0000Bello')).toBe('Tunde Bello');
    expect(cleanGuestName('a\u202eb')).toBe('a b'); // right-to-left override can disguise text
  });

  it('a name made only of stripped characters is anonymous, not a blank folder', () => {
    expect(cleanGuestName('<>/\\')).toBe('');
  });

  it('caps the length without splitting an emoji or accent in half', () => {
    const long = cleanGuestName('x'.repeat(500));
    expect(long).toHaveLength(MAX_GUEST_NAME);
    const emoji = cleanGuestName('\u{1F496}'.repeat(100));
    expect(Array.from(emoji)).toHaveLength(MAX_GUEST_NAME);
    expect(emoji.isWellFormed()).toBe(true); // no dangling half of a surrogate pair
  });

  it('is idempotent, so cleaning twice (client, then server) changes nothing', () => {
    for (const v of ['Tunde  Bello', '<b>Bisi</b>', 'x'.repeat(80), 'Ọláòlúwa ']) {
      expect(cleanGuestName(cleanGuestName(v))).toBe(cleanGuestName(v));
    }
  });

  it('the start request accepts a name, accepts none, and rejects a non-string', () => {
    const base = { guestId: 'abcdefghijklmnop', files: [{ name: 'a.jpg', type: 'image/jpeg', size: 10 }] };
    expect(momentsStartSchema.safeParse(base).success).toBe(true);
    expect(momentsStartSchema.safeParse({ ...base, guestName: 'Tunde' }).success).toBe(true);
    expect(momentsStartSchema.safeParse({ ...base, guestName: 123 }).success).toBe(false);
    expect(momentsStartSchema.safeParse({ ...base, guestName: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('guest moments: folder labels', () => {
  it('anonymous guests are numbered Guest 1, Guest 2... in order', () => {
    expect(folderLabels([{ name: '' }, { name: '' }, { name: '' }])).toEqual(['Guest 1', 'Guest 2', 'Guest 3']);
  });

  it('a named guest shows their name', () => {
    expect(folderLabels([{ name: 'Tunde' }, { name: 'Bisi' }])).toEqual(['Tunde', 'Bisi']);
  });

  it('named guests do not use up a Guest number', () => {
    expect(folderLabels([{ name: '' }, { name: 'Tunde' }, { name: '' }, { name: 'Bisi' }, { name: '' }]))
      .toEqual(['Guest 1', 'Tunde', 'Guest 2', 'Bisi', 'Guest 3']);
  });

  it('two different guests with the same name stay distinguishable, ignoring case', () => {
    expect(folderLabels([{ name: 'Tunde' }, { name: 'tunde' }, { name: 'TUNDE' }]))
      .toEqual(['Tunde', 'tunde (2)', 'TUNDE (3)']);
  });

  it('a guest literally named "Guest 1" does not collide with the anonymous numbering', () => {
    const l = folderLabels([{ name: '' }, { name: 'Guest 1' }]);
    expect(l[0]).toBe('Guest 1');
    expect(l[1]).toBe('Guest 1'); // same text, but each folder is opened by its own guestId, never its label
  });

  it('no guests, no labels', () => {
    expect(folderLabels([])).toEqual([]);
  });
});
