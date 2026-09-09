# Production Deployment Plan — africa-south1

**App:** Wedding Invitation QR Access System, FROZEN at v1.1.0 (commit `aa05486b1fc5af48010b0742fce9cfd00cfedac3`)
**Region (approved):** africa-south1 — Johannesburg, South Africa
**Decided without comparative benchmarks; do not revisit unless a serious problem appears.**

---

## 1. Architecture check: where Vercel executes (FINDING — needs owner approval)

**Observed:** The repo contains no `vercel.json`. On Vercel, all serverless/API-route
functions therefore run in the project's **default region, iad1 (Washington DC, US)**.
Every Firebase Admin SDK call (Firestore reads/writes, Storage) made by the scan,
admin, and generation routes would cross US ↔ Johannesburg:

- ~200 ms+ network RTT per Firestore round trip.
- A scan transaction makes several sequential round trips (3 reads + writes + commit).
- Expected avoidable latency: roughly 1–2 s added to EVERY scan, plus the same on
  admin/dashboard and generation calls.

**Proposed fix (deployment config only — no feature change):** add a root `vercel.json`:

```json
{ "regions": ["cpt1"] }
```

`cpt1` is Vercel's Cape Town region — its only African region. Cape Town ↔ Johannesburg
is ~25–40 ms, so Admin SDK calls would execute ~150 ms+ closer to Firestore than iad1.

**Status: APPROVED by owner (Sept 9, 2026) and applied in v1.1.1** — `vercel.json`
now pins Functions to `cpt1`. Firestore remains africa-south1. Verify the actual
runtime region from Vercel's deployment/runtime info after the first deploy —
do not rely only on the presence of vercel.json.

**Mobile clients note:** usher phones scan client-side and call the API route; the
phone → Vercel edge and Vercel → Firestore legs are separate. Nigerian phones hitting
cpt1 vs iad1 both route through Vercel's CDN/edge; the main win of cpt1 is the
server-side Firestore leg (Johannesburg ≈ 25–40 ms from Cape Town vs ≈ 200 ms+ from DC).

## 2. Owner setup steps (in order, when ready)

### A. Firebase console (owner performs — no secrets shared with anyone)

1. Firebase Console → project `event-management-b5999`.
2. **Firestore Database → Create database.** When prompted for location, select
   **africa-south1 (Johannesburg)**. **Verify the location shown before confirming** —
   this choice is PERMANENT for the project. (If the console does not offer
   africa-south1, STOP and report — do not pick a different region.)
3. **Storage → Get started.** If location can be chosen, align it with the Firestore
   location / Johannesburg infrastructure where permitted and compatible. Verify the
   exact location shown before confirming.
4. Enable Firebase Authentication → Email/Password provider (if not already).
5. Download the service-account key **only into Vercel** (next step) — the JSON file
   itself never goes into chat, GitHub, or docs.

### B. Vercel (owner performs; secrets entered directly in Vercel UI)

1. Import the GitHub repo `Osam-74/eventmanagement`, production branch `main`.
2. Set Environment Variables (Production and Preview) — all entered by the owner
   directly in Vercel, never pasted anywhere else:

```
NEXT_PUBLIC_FIREBASE_API_KEY=<from Firebase console, client config>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=event-management-b5999.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=event-management-b5999
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=event-management-b5999.firebasestorage.app
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=690920844020
NEXT_PUBLIC_FIREBASE_APP_ID=1:690920844020:web:5aab6143dd0147be90cca1

FIREBASE_PROJECT_ID=event-management-b5999
FIREBASE_CLIENT_EMAIL=<service-account client_email>          # from the service-account JSON
FIREBASE_PRIVATE_KEY=<service-account private_key>            # real newlines; "\n" also tolerated
FIREBASE_STORAGE_BUCKET=event-management-b5999.firebasestorage.app

QR_TOKEN_HMAC_KEY=<openssl rand -hex 32>                      # generate fresh
USHER_PIN_PEPPER=<openssl rand -hex 32>                       # generate fresh, separate
USHER_SESSION_SECRET=<openssl rand -hex 32>                   # generate fresh, separate
```

3. Deploy. Verify the functions' region in Vercel dashboard (see §1).
4. Deploy Firestore security rules: `firebase deploy --only firestore:rules`
   (repo `firestore.rules` — the deny-all rules tested in CI).
5. **Deploy Firestore composite indexes:** `firebase deploy --only firestore:indexes`
   (repo `firestore.indexes.json`). **This step is easy to miss because the Firestore
   emulator (what CI runs against) does not enforce composite indexes — a compound
   query like batches' `where eventId == … orderBy createdAt` can pass every test and
   still fail in real production Firestore with a "query requires an index" error
   until this is deployed.** Confirm in the Firebase console → Firestore → Indexes
   that all indexes show status "Enabled" (not "Building") before relying on any
   admin list page (Batches, Scan logs, Invitations, Ushers).

### C. Bootstrap (once, after deploy)

1. Owner runs locally with production env: `npm run bootstrap:root-admin` with the
   chosen **Root Admin email** → creates the single root admin account.
2. Owner logs in as root admin via the admin UI, creates admin + usher accounts,
   sets usher PINs.
3. Upload the final QR-ready invitation master artwork (PNG, highest resolution,
   gold frame + "Access code" label, NO QR inside), approve placement.

## 3. Never commit (re-verified at freeze): FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL
where unnecessary, QR_TOKEN_HMAC_KEY, PIN pepper, usher session secret,
service-account JSON, .env production files. Git history scanned clean at v1.1.0.

## 4. Production readiness test plan (execute from NIGERIA, real devices)

Run each scenario **multiple attempts (≥5)**; record average and approximate slowest.
All tests after production Firestore is provisioned. No mass record creation.

### A. Latency checklist
| # | Scenario | Metric |
|---|----------|--------|
| 1 | Normal QR validation response time | avg + slowest |
| 2 | Successful one-time admission transaction | avg + slowest |
| 3 | Repeated/duplicate scan response | avg + slowest + correct ALREADY_USED outcome |
| 4 | Event inactive response (scanning off) | avg + slowest + correct EVENT_NOT_OPEN |
| 5 | Revoked-card response | avg + slowest + correct REVOKED |
| 6 | Allow Rescan → then another successful scan | completes + latency |
| 7 | Multiple scanners simultaneously (2–4 usher phones) | no errors, counters exact |
| 8 | Dashboard / realtime analytics responsiveness | perceived smoothness + load time |
| 9 | Invitation lookup (serial search) responsiveness | avg + slowest |
| 10 | Usher login / PIN responsiveness | avg + slowest |
| 11 | Invitation generation + Storage ops (small batch, share profile) | completes + duration |

### B. Gate-opening load test (small, controlled)
- A handful of test invitations (≤10) scanned near-simultaneously from multiple
  usher phones, mobile data included. Verify all admitted once, counters exact,
  no lock timeouts surfaced to users. **Do NOT create hundreds/thousands of records.**

### C. Real-device rehearsal (full script, some runs on mobile data)
1. Admin activates scanning.
2. Valid card → GRANTED.
3. Same card again → REJECTED (already used).
4. Revoked card → REJECTED (revoked).
5. Deactivate scanning → scan valid unused card → EVENT NOT OPEN.
6. Reactivate → valid scan → GRANTED.
7. Allow Rescan on a used card → scan again → GRANTED.
8. Several usher phones scanning simultaneously throughout.
9. Confirm serial search shows scanned-by / time / gate for every scan.

### D. Acceptance
- If africa-south1 performs normally → ACCEPT and proceed. No comparative tests
  against European regions.
- If a serious latency/availability/compatibility/routing problem appears → STOP,
  report measured numbers before proposing any region change.

## 5. Production readiness report (to be produced after tests)
Template: per-scenario table of attempts, average, slowest, pass/fail; load-test
observations; rehearsal checklist results; mobile-data vs Wi-Fi comparison notes;
verdict: EVENT-READY / ISSUES FOUND.
