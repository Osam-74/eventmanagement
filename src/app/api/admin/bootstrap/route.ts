import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db, auth } from '@/lib/firebase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * TEMPORARY one-time Root Admin bootstrap route — will be removed in the
 * very next commit after use. No local Node/npm tooling is required; it
 * runs entirely server-side with the production service-account credentials
 * already configured in Vercel.
 *
 * Safety properties (mirrors scripts/bootstrap-root-admin.mjs):
 *  - requires a strong secret header compared constant-time against the
 *    server-side-only BOOTSTRAP_SECRET env var (never in code, chat, or Git);
 *  - works exactly once: an atomic Firestore transaction claims the
 *    system/bootstrapRootAdmin marker before anything is modified;
 *  - promotes ONLY the pre-specified existing Firebase Auth user
 *    (amusanolamide74@gmail.com) — it never creates an Auth user and never
 *    touches the existing password;
 *  - refuses to run if any ROOT_ADMIN already exists;
 *  - leaves a ROOT_ADMIN_BOOTSTRAPPED audit record.
 */
const ROOT_ADMIN_EMAIL = 'amusanolamide74@gmail.com';

function secretMatches(provided: string | null): boolean {
  const expected = process.env.BOOTSTRAP_SECRET;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!process.env.BOOTSTRAP_SECRET) {
    return NextResponse.json({ ok: false, message: 'Bootstrap not configured.' }, { status: 503 });
  }
  if (!secretMatches(req.headers.get('x-bootstrap-secret'))) {
    return NextResponse.json({ ok: false, message: 'Not authorized.' }, { status: 401 });
  }

  const database = db();

  // Atomic one-time gate FIRST: claim the marker in a transaction, refusing
  // if already used. Once consumed, the route is permanently disabled.
  const marker = database.doc('system/bootstrapRootAdmin');
  try {
    await database.runTransaction(async (tx) => {
      const snap = await tx.get(marker);
      if (snap.exists) {
        throw new Error('ALREADY_USED');
      }
      tx.create(marker, { consumedAt: FieldValue.serverTimestamp(), email: ROOT_ADMIN_EMAIL });
    });
  } catch (e) {
    const alreadyUsed = e instanceof Error && e.message === 'ALREADY_USED';
    return NextResponse.json(
      {
        ok: false,
        message: alreadyUsed
          ? 'Bootstrap already used; route is permanently disabled.'
          : 'Bootstrap failed; nothing was modified.',
      },
      { status: alreadyUsed ? 410 : 500 }
    );
  }

  // Refuse if a ROOT_ADMIN already exists (e.g. bootstrapped by the local
  // script) — release the marker so nothing is consumed by a refused call.
  const existingRoot = await database
    .collection('users')
    .where('accountType', '==', 'ROOT_ADMIN')
    .limit(2)
    .get();

  if (!existingRoot.empty) {
    await marker.delete().catch(() => undefined);
    return NextResponse.json(
      { ok: false, message: `A ROOT_ADMIN already exists (${existingRoot.docs.map((d) => d.data().email).join(', ')}).` },
      { status: 409 }
    );
  }

  // Claim succeeded — promote the existing Auth user (never create).
  try {
    const user = await auth().getUserByEmail(ROOT_ADMIN_EMAIL);

    await database.collection('users').doc(user.uid).set(
      {
        email: ROOT_ADMIN_EMAIL,
        displayName: ROOT_ADMIN_EMAIL,
        accountType: 'ROOT_ADMIN',
        active: true,
        permissions: {
          canManageAdmins: true,
          canManageEvents: true,
          canGenerateInvites: true,
          canManageInvites: true,
          canManageUshers: true,
          canViewAnalytics: true,
        },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: 'bootstrap-route',
      },
      { merge: true }
    );

    await auth().setCustomUserClaims(user.uid, { admin: true });

    await database.collection('auditLogs').add({
      action: 'ROOT_ADMIN_BOOTSTRAPPED',
      actor: user.uid,
      actorType: 'bootstrap-route',
      detail: { email: ROOT_ADMIN_EMAIL, via: 'one-time protected production route' },
      at: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ ok: true, message: 'ROOT_ADMIN ready.', email: ROOT_ADMIN_EMAIL, uid: user.uid });
  } catch (e) {
    // Compensation: release the marker so a retry is possible after a
    // transient failure (nothing admin-related was granted yet if the Auth
    // lookup itself failed).
    await marker.delete().catch(() => undefined);
    console.error('Bootstrap promotion failed:', e);
    return NextResponse.json({ ok: false, message: 'Promotion failed; nothing was granted. Retry is possible.' }, { status: 500 });
  }
}
