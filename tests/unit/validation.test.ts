import { describe, expect, it } from 'vitest';
import {
  generateBatchSchema,
  allowRescanSchema,
  revokeInvitationSchema,
  scanSchema,
  usherSigninSchema,
  toggleScanningSchema,
  createAdminSchema,
  updateAdminSchema,
} from '@/lib/validation/schemas';

describe('batch generation limits', () => {
  it('accepts 50 share cards but caps HQ at 20', () => {
    expect(generateBatchSchema.safeParse({ eventId: 'event-1', quantity: 50, profile: 'share' }).success).toBe(true);
    const hq50 = generateBatchSchema.safeParse({ eventId: 'event-1', quantity: 50, profile: 'hq' });
    expect(hq50.success).toBe(false);
    expect(generateBatchSchema.safeParse({ eventId: 'event-1', quantity: 20, profile: 'hq' }).success).toBe(true);
    expect(generateBatchSchema.safeParse({ eventId: 'event-1', quantity: 51, profile: 'share' }).success).toBe(false);
  });
});

describe('allow-rescan requires a mandatory reason', () => {
  it('rejects missing or too-short reasons', () => {
    expect(allowRescanSchema.safeParse({}).success).toBe(false);
    expect(allowRescanSchema.safeParse({ reason: 'ab' }).success).toBe(false);
    expect(allowRescanSchema.safeParse({ reason: 'network failure at gate' }).success).toBe(true);
  });
  it('revoke allows an optional reason (fire-and-forget revocation)', () => {
    expect(revokeInvitationSchema.safeParse({}).success).toBe(true);
  });
});

describe('scan request shape', () => {
  it('requires a plausible credential and a client request id', () => {
    const ok = scanSchema.safeParse({ token: 'IS26.' + 'A'.repeat(43), clientRequestId: 'req-123456' });
    expect(ok.success).toBe(true);
    expect(scanSchema.safeParse({ token: 'short', clientRequestId: 'req-123456' }).success).toBe(false);
    expect(scanSchema.safeParse({ token: 'IS26.' + 'A'.repeat(43) }).success).toBe(false);
  });
});

describe('scanning toggle requires explicit confirmation', () => {
  it('rejects enabled without confirm literal', () => {
    expect(toggleScanningSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(toggleScanningSchema.safeParse({ enabled: true, confirm: true }).success).toBe(true);
    expect(toggleScanningSchema.safeParse({ enabled: false, confirm: true }).success).toBe(true);
  });
});

describe('usher sign-in shape', () => {
  it('requires event, name and a 6-10 digit pin', () => {
    expect(usherSigninSchema.safeParse({ eventId: 'event-1', name: 'Grace', pin: '123456' }).success).toBe(true);
    expect(usherSigninSchema.safeParse({ eventId: 'event-1', name: 'Grace', pin: '12345' }).success).toBe(false);
    expect(usherSigninSchema.safeParse({ eventId: 'event-1', name: 'Grace', pin: 'abcdefgh' }).success).toBe(false);
  });
});

describe('admin account shape', () => {
  it('requires a strong-enough password and valid email', () => {
    const base = { email: 'a@b.co', displayName: 'New Admin' };
    expect(createAdminSchema.safeParse({ ...base, password: 'short', permissions: {} }).success).toBe(false);
    expect(createAdminSchema.safeParse({ ...base, password: 'long-enough-pw', permissions: {} }).success).toBe(true);
    expect(updateAdminSchema.safeParse({ active: true, permissions: {} }).success).toBe(true);
  });
});
