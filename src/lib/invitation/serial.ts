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
 */
export function hyphenateSerial(normalized: string): string | null {
  // code part may itself contain digits (e.g. E2E, IS26) — split at the
  // LAST letter→digit boundary; the trailing digit run is the sequence.
  const m = /^(.*[A-Z])(\d+)$/.exec(normalized);
  return m ? `${m[1]}-${m[2]}` : null;
}

export function eventCodeFromSlug(slug: string): string {
  const letters = slug.replace(/[^a-zA-Z]/g, '').toUpperCase();
  return (letters || 'EVT').slice(0, 5);
}
