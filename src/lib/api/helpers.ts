import { NextRequest, NextResponse } from 'next/server';
import { auth, db } from '@/lib/firebase/admin';
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
 * Verifies the Firebase ID token in the Authorization header and loads the
 * admin profile from Firestore. Returns null when the caller is not an
 * active administrator.
 */
export async function getAdminContext(req: NextRequest): Promise<AdminContext | null> {
  const header = req.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return null;

  let decoded;
  try {
    decoded = await auth().verifyIdToken(match[1], true);
  } catch {
    return null;
  }

  const snap = await db().collection('users').doc(decoded.uid).get();
  if (!snap.exists) return null;
  const data = snap.data() as Record<string, unknown>;
  if (data.active === false) return null;
  if (data.accountType !== 'ROOT_ADMIN' && data.accountType !== 'ADMIN') return null;

  return {
    uid: decoded.uid,
    email: String(data.email ?? decoded.email ?? ''),
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
