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

/**
 * Battery-saving auto-sleep (owner request, 2026-09-11): if the camera has
 * been running with no scan actually PROCESSED (accepted or denied — a
 * genuine attempt) for INACTIVITY_SLEEP_MS, the scanner should pause
 * itself exactly as if the usher had tapped "Pause scanner". This is
 * deliberately keyed off real scan attempts, not mere decode-loop frames
 * (those land continuously regardless of whether anyone is actually being
 * checked in) and not merely "the page is open" — a quiet stretch between
 * arrivals is the whole point of sleeping the camera.
 */
export const INACTIVITY_SLEEP_MS = 5 * 60 * 1000; // 5 minutes

export function shouldSleepFromInactivity(lastActivityAt: number, now: number, busy: boolean): boolean {
  if (busy) return false; // never sleep out from under an in-flight scan
  return now - lastActivityAt >= INACTIVITY_SLEEP_MS;
}
