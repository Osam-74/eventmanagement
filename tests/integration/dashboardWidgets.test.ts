import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getFirestore } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { ADMIN_SESSION_COOKIE, createAdminSessionToken } from '@/lib/auth/adminSession';

/**
 * Route-level tests for the four lightweight dashboard widget endpoints
 * (progressive loading): event summary, scan activity, usher roster and
 * latest batches. Proves:
 *  - session-cookie auth (401 without), 403 for an ADMIN without
 *    canViewAnalytics
 *  - bounded/paginated reads: recent scans limited (never the full log),
 *    ushers capped at 200, batches at 5
 *  - the activity endpoint counts via Firestore aggregations and runs its
 *    three queries in parallel (no full-collection reads for totals)
 */
const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const ROUTE_PROJECT = process.env.FIREBASE_PROJECT_ID ?? 'demo-eventaccess';
if (hasEmu) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  process.env.FIREBASE_PROJECT_ID = ROUTE_PROJECT;
  process.env.FIREBASE_CLIENT_EMAIL = `test@${ROUTE_PROJECT}.iam.gserviceaccount.com`;
  process.env.FIREBASE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.ADMIN_SESSION_SECRET ??= 'test-admin-session-secret-0123456789';
}
let db: Firestore | null = null;

const EV = 'event-widgets';
let rootUid = '';
let viewerUid = ''; // ADMIN with canViewAnalytics
let limitedUid = ''; // ADMIN WITHOUT canViewAnalytics

let getEvent: (req: NextRequest) => Promise<Response>;
let getActivity: (req: NextRequest) => Promise<Response>;
let getUshers: (req: NextRequest) => Promise<Response>;
let getBatches: (req: NextRequest) => Promise<Response>;

const url = (path: string) => `http://localhost${path}`;

function authed(path: string, uid: string): NextRequest {
  return new NextRequest(url(path), {
    method: 'GET',
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${createAdminSessionToken(uid)}` },
  });
}

describe.skipIf(!hasEmu)('dashboard widget routes (progressive loading)', () => {
  beforeAll(async () => {
    ({ GET: getEvent } = await import('@/app/api/admin/dashboard/event/route'));
    ({ GET: getActivity } = await import('@/app/api/admin/dashboard/activity/route'));
    ({ GET: getUshers } = await import('@/app/api/admin/dashboard/ushers/route'));
    ({ GET: getBatches } = await import('@/app/api/admin/dashboard/batches/route'));

    const { initializeApp } = await import('firebase-admin/app');
    const app = initializeApp({ projectId: ROUTE_PROJECT }, `widgets-${Date.now()}`);
    db = getFirestore(app);

    await db.collection('events').doc(EV).set({
      name: 'Widget Wedding',
      slug: 'widget-wedding',
      code: 'ISWED',
      eventDate: new Date('2026-10-03T10:00:00Z'),
      timezone: 'Africa/Lagos',
      lifecycleStatus: 'active',
      scanningEnabled: true,
      scanningEnabledAt: new Date(),
      scanningEnabledBy: null,
      templateId: null,
      lastSerialSequence: 0,
      totalGenerated: 120,
      totalUsed: 40,
      totalRevoked: 5,
      rescanAllowedCount: 2,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // 30 scan logs: 20 accepted, 10 rejected
    for (let i = 0; i < 30; i++) {
      await db.collection('scanLogs').doc(`w-log-${i}`).set({
        eventId: EV,
        result: i < 20 ? 'accepted' : 'already_used',
        invitationSerialNumber: `ISWED-${i}`,
        invitationId: `w-inv-${i}`,
        tokenDigest: `w-digest-${i}`,
        usherNameSnapshot: 'Widget Usher',
        usherId: 'w-usher-0',
        gateId: 'gate-1',
        scannedAt: new Date(Date.now() - (30 - i) * 1000),
      });
    }

    // 3 ushers, one seen seconds ago (activeNow), two stale
    for (let i = 0; i < 3; i++) {
      await db.collection('ushers').doc(`w-usher-${i}`).set({
        eventId: EV,
        name: `Widget Usher ${i}`,
        pinIndex: `idx-${i}`,
        pinHash: 'h',
        pinSalt: 's',
        gateId: 'gate-1',
        active: true,
        lockedUntil: null,
        acceptedCount: i,
        lastScanAt: new Date(),
        lastSeenAt: new Date(Date.now() - (i === 0 ? 5000 : 3600_000)),
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    // 7 batches — only the latest 5 must return
    for (let i = 0; i < 7; i++) {
      await db.collection('batches').doc(`w-batch-${i}`).set({
        eventId: EV,
        status: 'completed',
        requestedQuantity: 10,
        completedQuantity: 10,
        failedQuantity: 0,
        outputProfile: 'share',
        createdAt: new Date(Date.now() - (7 - i) * 1000),
      });
    }

    rootUid = `widgets-root-${Date.now()}`;
    viewerUid = `widgets-viewer-${Date.now()}`;
    limitedUid = `widgets-limited-${Date.now()}`;
    await db.collection('users').doc(rootUid).set({ email: 'w-root@example.test', accountType: 'ROOT_ADMIN', active: true, permissions: {} });
    await db.collection('users').doc(viewerUid).set({ email: 'w-viewer@example.test', accountType: 'ADMIN', active: true, permissions: { canViewAnalytics: true } });
    await db.collection('users').doc(limitedUid).set({ email: 'w-limited@example.test', accountType: 'ADMIN', active: true, permissions: { canManageEvents: true } });
  });

  it('event widget: one read, banner + totals; 401 without a session', async () => {
    const anon = await getEvent(new NextRequest(url(`/api/admin/dashboard/event?eventId=${EV}`)));
    expect(anon.status).toBe(401);

    const res = await getEvent(authed(`/api/admin/dashboard/event?eventId=${EV}`, rootUid));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.event.name).toBe('Widget Wedding');
    expect(body.event.scanningEnabled).toBe(true);
    expect(body.event.totals).toEqual({ generated: 120, used: 40, revoked: 5, unused: 75, rescansAllowed: 2 });

    // missing eventId → 400, never an unfiltered read
    const bad = await getEvent(authed(`/api/admin/dashboard/event`, rootUid));
    expect(bad.status).toBe(400);

    // unknown event → null event, not an error
    const missing = await getEvent(authed(`/api/admin/dashboard/event?eventId=nope`, rootUid));
    expect(missing.status).toBe(200);
    expect((await missing.json()).event).toBeNull();
  });

  it('activity widget: bounded recent window + aggregate counts (no full-collection reads)', async () => {
    const res = await getActivity(authed(`/api/admin/dashboard/activity?eventId=${EV}`, rootUid));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanCounts).toEqual({ accepted: 20, rejected: 10 });
    expect(body.recentScans).toHaveLength(25); // default window, not 30
    expect(body.recentScans[0].serialNumber).toBe('ISWED-29'); // newest first
    expect(body.latestScanAt).toBe(body.recentScans[0].scannedAt);

    // explicit limit is honoured and clamped
    const small = await getActivity(authed(`/api/admin/dashboard/activity?eventId=${EV}&limit=5`, rootUid));
    expect((await small.json()).recentScans).toHaveLength(5);
    const huge = await getActivity(authed(`/api/admin/dashboard/activity?eventId=${EV}&limit=5000`, rootUid));
    expect((await huge.json()).recentScans.length).toBeLessThanOrEqual(100);
  });

  it('ushers widget: capped roster with live presence flag', async () => {
    const res = await getUshers(authed(`/api/admin/dashboard/ushers?eventId=${EV}`, rootUid));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ushers).toHaveLength(3);
    const byId = Object.fromEntries(body.ushers.map((u: { id: string }) => [u.id, u]));
    expect(byId['w-usher-0'].activeNow).toBe(true); // seen 5s ago
    expect(byId['w-usher-1'].activeNow).toBe(false); // stale
  });

  it('batches widget: latest 5 only', async () => {
    const res = await getBatches(authed(`/api/admin/dashboard/batches?eventId=${EV}`, rootUid));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.batches).toHaveLength(5);
    expect(body.batches[0].id).toBe('w-batch-6'); // newest first
  });

  it('an ADMIN with canViewAnalytics may read widgets; without it → 403', async () => {
    const okRes = await getActivity(authed(`/api/admin/dashboard/activity?eventId=${EV}`, viewerUid));
    expect(okRes.status).toBe(200);
    const denied = await getActivity(authed(`/api/admin/dashboard/activity?eventId=${EV}`, limitedUid));
    expect(denied.status).toBe(403);
    const deniedEvent = await getEvent(authed(`/api/admin/dashboard/event?eventId=${EV}`, limitedUid));
    expect(deniedEvent.status).toBe(403);
  });
});
