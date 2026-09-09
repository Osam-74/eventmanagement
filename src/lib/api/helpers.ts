import { NextRequest, NextResponse } from 'next/server';
import { auth, db } from '@/lib/firebase/admin';
import { ADMIN_SESSION_COOKIE, verifyAdminSessionToken } from '@/lib/auth/adminSession';
import { ALL_PERMISSIONS, type Permission } from '@/lib/types';

export type AdminContext = {
  uid: string;
  email: string;
  accountType: 'ROOT_ADMIN' | 'ADMIN';
  permissions: Record<string, boolean>;
  displayName: string;
};

export function badRequest(message: string, code = 'SERVER_ERROR') {
  return NextResponse.json({ ok: false, code, message }, { status: 400 });
}

export function unauthorized(message = 'UNAUTHORIZED') {
  return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message }, { status: 401 });
}

export function forbidden(message = 'Forbidden') {
  return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message }, { status: 403 });
}

export function serverError(message = 'Unexpected error') {
  return NextResponse.json({ ok: false, code: 'SERVER_ERROR', message }, { status: 500 });
}

/**
 * Resolves the calling admin, by EITHER:
 *  1. the server-established admin_session HttpOnly cookie (production UI
 *     sessions — created only by /api/auth/session after full validation),
 *     or
 *  2. a Firebase ID token in the Authorization header (kept for tooling and
 *     tests; equivalent authority).
 *
 * Both paths then load the users/{uid} record from Firestore, so every
 * request re-confirms the admin is active and has the permission —
 * sessions are pointers, not proof.
 */
export async function getAdminContext(req: NextRequest): Promise<AdminContext | null> {
  let uid: string | null = null;

  const header = req.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer (.+)$/);
  if (match) {
    try {
      uid = (await auth().verifyIdToken(match[1], true)).uid;
    } catch {
      return null;
    }
  } else {
    const session = verifyAdminSessionToken(req.cookies.get(ADMIN_SESSION_COOKIE)?.value);
    if (!session) return null;
    uid = session.uid;
  }

  const snap = await db().collection('users').doc(uid).get();
  if (!snap.exists) return null;
  const data = snap.data() as Record<string, unknown>;
  if (!snap.exists || data.active === false) return null;
  if (data.accountType !== 'ROOT_ADMIN' && data.accountType !== 'ADMIN') return null;

  return {
    uid,
    email: String(data.email ?? ''),
    displayName: String(data.displayName ?? ''),
    accountType: data.accountType,
    permissions: (data.permissions as Record<string, boolean>) ?? {},
  };
}

export async function requirePermission(
  req: NextRequest,
  permission: Permission
): Promise<{ admin: AdminContext } | { error: NextResponse }> {
  const admin = await getAdminContext(req);
  if (!admin) return { error: unauthorized() };
  if (admin.accountType === 'ROOT_ADMIN') return { admin };
  if (!admin.permissions?.[permission]) return { error: forbidden(`Missing permission: ${permission}`) };
  return { admin };
}

export function hasPermission(admin: AdminContext, permission: Permission): boolean {
  if (admin.accountType === 'ROOT_ADMIN') return true;
  return Boolean(admin.permissions?.[permission]);
}

export function emptyPermissions(): Record<Permission, boolean> {
  return Object.fromEntries(ALL_PERMISSIONS.map((p) => [p, false])) as Record<Permission, boolean>;
}
