import type { Firestore, Query } from 'firebase-admin/firestore';
import { normalizeSerial } from '@/lib/invitation/serial';

/**
 * "Contains" search for the invitations table. Firestore cannot do substring
 * queries, so when the admin types part of a serial (00042) or a tag (VIP) we
 * walk the event's invitations in serial order, in pages, and filter here.
 *
 * - Matching ignores case, hyphens and spaces, so "iswed 42", "ISWED-00042"
 *   and "wed00042" all find ISWED00042 (and legacy ISWED-00042 docs).
 * - Reads only the fields it needs; stops after SCAN_CAP documents so a huge
 *   event can never turn one keystroke into an unbounded read. When the cap is
 *   hit the result says so (`truncated`) instead of silently under-reporting.
 */
export const SCAN_PAGE = 500;
export const SCAN_CAP = 20000;

export type SearchFilters = {
  eventId: string;
  text: string;
  status?: 'unused' | 'used' | 'revoked' | '';
  /** '' = any, '__tagged__' = has a tag, '__untagged__' = no tag, otherwise an exact tag (case-insensitive) */
  tag?: string;
};

export const norm = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function matchesText(doc: { serialNumber?: unknown; tag?: unknown }, text: string): boolean {
  const needle = norm(text);
  if (!needle) return true;
  return norm(doc.serialNumber).includes(needle) || norm(doc.tag).includes(needle);
}

export function matchesTag(doc: { tag?: unknown }, tag: string | undefined): boolean {
  if (!tag) return true;
  const t = typeof doc.tag === 'string' ? doc.tag.trim() : '';
  if (tag === '__tagged__') return t !== '';
  if (tag === '__untagged__') return t === '';
  return t.toUpperCase() === tag.trim().toUpperCase();
}

/** Every matching doc id + snapshot data, in serial order, plus whether the scan was cut short. */
export async function scanInvitations(
  firestore: Firestore,
  f: SearchFilters
): Promise<{ docs: { id: string; data: Record<string, unknown> }[]; truncated: boolean }> {
  let base: Query = firestore.collection('invitations').where('eventId', '==', f.eventId);
  if (f.status) base = base.where('status', '==', f.status);
  base = base.orderBy('serialNumber', 'asc');

  const out: { id: string; data: Record<string, unknown> }[] = [];
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let scanned = 0;
  for (;;) {
    let page = base.limit(SCAN_PAGE);
    if (last) page = page.startAfter(last);
    const snap = await page.get();
    if (snap.empty) return { docs: out, truncated: false };
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      if (matchesText(data, f.text) && matchesTag(data, f.tag)) out.push({ id: d.id, data });
    }
    scanned += snap.size;
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < SCAN_PAGE) return { docs: out, truncated: false };
    if (scanned >= SCAN_CAP) return { docs: out, truncated: true };
  }
}

/** Distinct tags used in this event (for the Tag dropdown), capped and sorted. */
export async function listTags(firestore: Firestore, eventId: string): Promise<string[]> {
  const tags = new Set<string>();
  let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let scanned = 0;
  for (;;) {
    let q = firestore.collection('invitations').where('eventId', '==', eventId).orderBy('serialNumber', 'asc').select('serialNumber', 'tag').limit(SCAN_PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const d of snap.docs) { const t = d.get('tag'); if (typeof t === 'string' && t.trim()) tags.add(t.trim()); }
    scanned += snap.size;
    if (snap.size < SCAN_PAGE || scanned >= SCAN_CAP) break;
    last = snap.docs[snap.docs.length - 1];
  }
  return [...tags].sort((a, b) => a.localeCompare(b)).slice(0, 100);
}

export { normalizeSerial };
