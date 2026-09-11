import { describe, expect, it } from 'vitest';
import { shouldSubmitToken, shouldSleepFromInactivity, DUPLICATE_WINDOW_MS, INACTIVITY_SLEEP_MS, type SubmitGateState } from '@/lib/client/scanClient';

const fresh = (over: Partial<SubmitGateState> = {}): SubmitGateState => ({
  busy: false,
  lastToken: '',
  lastAt: 0,
  ...over,
});

const T0 = 1_000_000;

describe('scanner submit gate', () => {
  it('accepts a fresh token when idle', () => {
    expect(shouldSubmitToken(fresh(), 'IS26.abc', T0)).toBe(true);
  });

  it('rejects duplicate camera detections of the same QR within the window', () => {
    const state = fresh({ lastToken: 'IS26.abc', lastAt: T0 });
    expect(shouldSubmitToken(state, 'IS26.abc', T0 + 500)).toBe(false);
    expect(shouldSubmitToken(state, 'IS26.abc', T0 + DUPLICATE_WINDOW_MS - 1)).toBe(false);
  });

  it('rejects double taps while a scan is in flight', () => {
    const state = fresh({ busy: true });
    expect(shouldSubmitToken(state, 'IS26.abc', T0)).toBe(false);
    expect(shouldSubmitToken(state, 'IS26.other', T0)).toBe(false);
  });

  it('allows the same token again after the duplicate window (e.g. a genuine re-scan attempt)', () => {
    const state = fresh({ lastToken: 'IS26.abc', lastAt: T0 });
    expect(shouldSubmitToken(state, 'IS26.abc', T0 + DUPLICATE_WINDOW_MS + 1)).toBe(true);
  });

  it('allows a different token immediately after the previous one', () => {
    const state = fresh({ lastToken: 'IS26.abc', lastAt: T0 });
    expect(shouldSubmitToken(state, 'IS26.def', T0 + 100)).toBe(true);
  });
});

describe('scanner inactivity auto-sleep (owner request, 2026-09-11)', () => {
  it('stays awake before the inactivity window elapses', () => {
    expect(shouldSleepFromInactivity(T0, T0 + INACTIVITY_SLEEP_MS - 1, false)).toBe(false);
  });

  it('sleeps once the inactivity window has fully elapsed with no scan processed', () => {
    expect(shouldSleepFromInactivity(T0, T0 + INACTIVITY_SLEEP_MS, false)).toBe(true);
    expect(shouldSleepFromInactivity(T0, T0 + INACTIVITY_SLEEP_MS + 60_000, false)).toBe(true);
  });

  it('never sleeps while a scan is in flight, even past the window', () => {
    expect(shouldSleepFromInactivity(T0, T0 + INACTIVITY_SLEEP_MS + 60_000, true)).toBe(false);
  });
});
