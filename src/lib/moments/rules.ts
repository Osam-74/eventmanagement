import { MULTIPART_PART_SIZE, SINGLE_PUT_MAX } from './r2';

/**
 * Guest "moments" upload rules. Pure functions (no I/O) so every limit that
 * protects the R2 bill is unit-tested. The SERVER enforces all of these when
 * it signs an upload; the browser checks are only a courtesy.
 */

/** Owner decision 2026-09-29: 100 MB max per file. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Cost guard: one guest can add at most this many files per event per day. */
export const MAX_FILES_PER_GUEST = 40;
/** Cost guard: how many files a single request batch may contain. */
export const MAX_FILES_PER_BATCH = 20;

/** Only photos and videos. Phones produce HEIC/HEIF (iPhone) and MOV/MP4. */
export const ALLOWED_TYPES: Record<string, { kind: 'photo' | 'video'; ext: string }> = {
  'image/jpeg': { kind: 'photo', ext: 'jpg' },
  'image/png': { kind: 'photo', ext: 'png' },
  'image/webp': { kind: 'photo', ext: 'webp' },
  'image/heic': { kind: 'photo', ext: 'heic' },
  'image/heif': { kind: 'photo', ext: 'heif' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/quicktime': { kind: 'video', ext: 'mov' },
  'video/webm': { kind: 'video', ext: 'webm' },
  'video/3gpp': { kind: 'video', ext: '3gp' },
};

export type FileCheck =
  | { ok: true; kind: 'photo' | 'video'; ext: string; contentType: string }
  | { ok: false; message: string };

/**
 * Validates one file's declared type and size. Browsers sometimes report an
 * empty type for HEIC or MOV, so the extension is used as a fallback and the
 * type is normalised to a known one.
 */
export function checkFile(input: { name: string; type: string; size: number }): FileCheck {
  const { name, size } = input;
  if (!Number.isFinite(size) || size <= 0) return { ok: false, message: `${shortName(name)} is empty.` };
  if (size > MAX_FILE_BYTES) {
    return { ok: false, message: `${shortName(name)} is too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB per file).` };
  }
  const type = normaliseType(input.type, name);
  const meta = type ? ALLOWED_TYPES[type] : undefined;
  if (!type || !meta) return { ok: false, message: `${shortName(name)} is not a photo or video.` };
  return { ok: true, kind: meta.kind, ext: meta.ext, contentType: type };
}

function normaliseType(type: string, name: string): string | null {
  const t = (type || '').toLowerCase().split(';')[0].trim();
  if (t in ALLOWED_TYPES) return t;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const byExt: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp',
  };
  return byExt[ext] ?? null;
}

function shortName(name: string): string {
  const n = (name || 'file').replace(/[\r\n]/g, ' ');
  return n.length > 40 ? `${n.slice(0, 37)}...` : n;
}

/** How to upload a file of this size: one PUT, or multipart with N parts. */
export function planUpload(size: number): { mode: 'single' } | { mode: 'multipart'; partSize: number; parts: number } {
  if (size <= SINGLE_PUT_MAX) return { mode: 'single' };
  return { mode: 'multipart', partSize: MULTIPART_PART_SIZE, parts: Math.ceil(size / MULTIPART_PART_SIZE) };
}

/** A safe display name for the admin grid / zip entry: no paths, no control chars. */
export function safeDisplayName(name: string, fallbackExt: string): string {
  const base = (name || '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\- ()]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned && cleaned !== '.' ? cleaned : `moment.${fallbackExt}`;
}

/**
 * The R2 object key. Built ONLY from server-generated ids, never from the
 * client's filename, so a hostile name can't traverse or overwrite anything.
 */
export function buildKey(eventId: string, momentId: string, ext: string): string {
  return `events/${eventId}/moments/${momentId}.${ext}`;
}

/**
 * Unique names inside the export zip: two guests both uploading IMG_0001.jpg
 * must not overwrite each other. Keeps the original name, adds " (2)", etc.
 */
export function uniqueZipNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const key = n.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 1) return n;
    const dot = n.lastIndexOf('.');
    return dot > 0 ? `${n.slice(0, dot)} (${count})${n.slice(dot)}` : `${n} (${count})`;
  });
}
