/**
 * Serial numbers are human-traceable references printed on the card.
 * They are NOT the credential: knowing a serial grants nothing.
 * Format: <EVENTCODE><5 digits>, one continuous token, e.g. ISWED00042
 * (owner decision: no hyphen — the event code and serial are together).
 * Legacy serials stored with a hyphen (ISWED-00042) remain valid: always
 * normalize through normalizeSerial() before comparing or querying.
 */
export function normalizeSerial(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatSerial(eventCode: string, sequence: number): string {
  return `${eventCode.toUpperCase()}${String(sequence).padStart(5, '0')}`;
}

/**
 * Rebuild the legacy hyphenated form of a NORMALIZED serial
 * ("ISWED00042" → "ISWED-00042") so lookups cover both stored shapes:
 * new cards print hyphenless serials, cards generated before the format
 * change keep "CODE-#####" in Firestore. Returns null for shapes that
 * carry no letter/digit split (nothing meaningful to hyphenate).
 *
 * When the event code itself ends in digits (e.g. "IS26"), "last
 * letter→digit boundary" is ambiguous — "IS2600042" could split as
 * "IS-2600042" or "IS26-00042". Returning a single guess silently picks
 * the wrong one and the lookup misses. hyphenateSerialCandidates() below
 * returns every plausible split so callers can query them all; this
 * function keeps the single-best-guess shape for callers that only need
 * a display string, not a lookup.
 */
export function hyphenateSerial(normalized: string): string | null {
  const candidates = hyphenateSerialCandidates(normalized);
  return candidates[0] ?? null;
}

/**
 * Every plausible hyphenation of a normalized serial, split at each
 * letter→digit boundary (rightmost first) where the tail is digits-only.
 * For "ISWED00042" (code has no trailing digits) there is exactly one:
 * ["ISWED-00042"]. For "IS2600042" (code "IS26" ends in digits) there are
 * two: ["IS-2600042", "IS26-00042"] — both must be tried since the
 * boundary can't be recovered from the string alone.
 */
export function hyphenateSerialCandidates(normalized: string): string[] {
  const out: string[] = [];
  const push = (v: string) => {
    if (!out.includes(v)) out.push(v);
  };
  // Serial sequences are ALWAYS 5 digits (formatSerial pads to 5), so the
  // single most plausible split is at the last 5 digits — this also finds
  // digit→digit boundaries (code "IS26") that no letter-scan can detect.
  const five = /^(.+)(\d{5})$/.exec(normalized);
  if (five) push(`${five[1]}-${five[2]}`);
  // Then every letter→digit boundary, for any other stored shape.
  for (let i = normalized.length - 1; i >= 0; i--) {
    if (/[A-Z]/.test(normalized[i])) {
      const tail = normalized.slice(i + 1);
      if (tail.length > 0 && /^\d+$/.test(tail)) {
        push(`${normalized.slice(0, i + 1)}-${tail}`);
      }
    }
  }
  return out;
}

export function eventCodeFromSlug(slug: string): string {
  const letters = slug.replace(/[^a-zA-Z]/g, '').toUpperCase();
  return (letters || 'EVT').slice(0, 5);
}
