'use client';

/**
 * Pure decision logic for the scanner's submit gate — duplicated camera
 * detections of the same QR, double taps and multi-frame reads must not
 * spam the server. Destructive scans are NEVER auto-retried: a network
 * failure surfaces as an error the usher must act on (the serial-number
 * lookup + Allow Rescan workflow is the recovery path).
 */
export type SubmitGateState = {
  busy: boolean;
  lastToken: string;
  lastAt: number; // epoch ms of the last submitted token
};

export const DUPLICATE_WINDOW_MS = 5000;

export function shouldSubmitToken(state: SubmitGateState, token: string, now: number): boolean {
  if (state.busy) return false;
  if (state.lastToken === token && now - state.lastAt < DUPLICATE_WINDOW_MS) return false;
  return true;
}
