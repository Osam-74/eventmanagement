import { describe, it, expect } from 'vitest';
import { TABLE_MAX_LENGTH } from '@/lib/invitation/tableLimits';
import { setTableSchema } from '@/lib/validation/schemas';

describe('table length limit', () => {
  const base = { eventId: 'event-1', invitationIds: ['a'] };

  it('the request schema never rejects what the service would accept', () => {
    expect(setTableSchema.safeParse({ ...base, table: 'x'.repeat(TABLE_MAX_LENGTH) }).success).toBe(true);
  });
  it('fits a tag covering 20 tables', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1).join(', ');
    expect(setTableSchema.safeParse({ ...base, table: twenty }).success).toBe(true);
    expect(twenty.length).toBeLessThanOrEqual(TABLE_MAX_LENGTH);
  });
  it('null still clears the table', () => {
    expect(setTableSchema.safeParse({ ...base, table: null }).success).toBe(true);
  });
});
