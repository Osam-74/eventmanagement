'use client';

import { signOut } from 'firebase/auth';
import { getFirebaseAuth } from '@/lib/firebase/client';
import { clearAdminSessionCache } from '@/lib/client/useAdmin';
import { beginSignOutIntent } from '@/lib/client/api';

/**
 * Full logout: clears the SERVER session cookie first (the authority),
 * then the Firebase client state, then redirects. A logout leaves NO
 * residue in either auth state.
 */
export async function signOutAdmin(redirectTo?: () => void): Promise<void> {
  // Suppress adminJson's automatic 401->/login redirect the moment sign-out
  // begins: in-flight widget requests WILL 401 once the cookie is revoked,
  // and redirecting would bounce the user off the post-logout landing page.
  beginSignOutIntent();
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
