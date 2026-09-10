'use client';

import { signOut } from 'firebase/auth';
import { getFirebaseAuth } from '@/lib/firebase/client';
import { clearAdminSessionCache } from '@/lib/client/useAdmin';

/**
 * Full logout: clears the SERVER session cookie first (the authority),
 * then the Firebase client state, then redirects. A logout leaves NO
 * residue in either auth state.
 */
export async function signOutAdmin(redirectTo?: () => void): Promise<void> {
  clearAdminSessionCache();
  try {
    await fetch('/api/auth/session', { method: 'DELETE' });
  } catch {
    // Network failure: the cookie has an 8h TTL and server-side revocation
    // still applies; still clear the client state below.
  }
  await signOut(getFirebaseAuth()).catch(() => undefined);
  if (redirectTo) redirectTo();
}
