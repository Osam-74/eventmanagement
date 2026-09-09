/**
 * Serial numbers are human-traceable references printed on the card.
 * They are NOT the credential: knowing a serial grants nothing.
 * Format: <EVENTCODE>-<5 digits>, e.g. ISWED-00042
 */
export function normalizeSerial(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}

export function formatSerial(eventCode: string, sequence: number): string {
  return `${eventCode.toUpperCase()}-${String(sequence).padStart(5, '0')}`;
}

export function eventCodeFromSlug(slug: string): string {
  const letters = slug.replace(/[^a-zA-Z]/g, '').toUpperCase();
  return (letters || 'EVT').slice(0, 5);
}
