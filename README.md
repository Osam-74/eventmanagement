# Event Access Control — Wedding Invitation QR System

Secure invitation access-control web app: staff generate unique invitation
cards on demand; gate officials validate each invitation exactly once on
event day. Reusable for multiple events; first event: the I & S wedding
(03 October 2026).

## What it does

- **On-demand generation** — admins generate invitation batches (1–50 per
  batch, share/HQ output profiles). Each card gets a cryptographically
  random QR credential (`IS26.<32 random bytes>`), composited into the
  approved artwork at the exact approved coordinates. No guest names, no
  PII, ever.
- **Traceable serial number on every card** — each invitation has a human
  reference like `ISWED-00042` printed on the card (position configurable
  per template). Admins can search by serial (or by a pasted scanned QR
  credential) and instantly see status, who scanned it, at what time and
  from which gate.
- **Allow rescan** — if a scan succeeded server-side but the scanner
  response was lost (network issue), the usher sees ALREADY USED at the
  gate. An admin searches the serial, verifies the scan was made moments
  ago, and presses **Allow rescan** — the invitation is atomically released
  back to `unused` with a mandatory reason, full history on the invitation
  and an audit-log entry.
- **One-time check-in** — the first valid scan wins a Firestore transaction;
  every other simultaneous attempt gets `ALREADY_USED`. Proven by the
  concurrency test in the handover spec.
- **Explicit scan activation** — scanning is off by default. Root Admin /
  authorized admin flips the ACTIVATE SCANNING switch (with confirmation)
  on event day. Server enforces it on every scan; open scanners immediately
  show EVENT NOT OPEN when it is turned off.
- **Capability-based admins** — one Root Admin; other admins get granular
  permissions (`canManageAdmins`, `canManageEvents`, `canGenerateInvites`,
  `canManageInvites`, `canManageUshers`, `canViewAnalytics`) enforced
  server-side with anti-escalation.
- **Usher PIN-only access** — the usher enters ONLY their 6-digit PIN on
  a full-screen PIN pad. The PIN alone identifies the usher server-side
  and resolves their admin-assigned event; the browser never submits a
  name or event. See "PIN-only identification" below for the exact
  implementation. Rate-limited with temporary lockout; short-lived signed
  HttpOnly session, revocable instantly by disabling the usher.
- **Realtime dashboard** — scanning status, totals (generated / unused /
  admitted / revoked / rescans allowed), per-usher activity, recent scan
  feed, CSV export.

## Routes

| Area | Path |
|---|---|
| Admin sign-in | `/login` |
| Control center | `/admin` (dashboard + scanning toggle) |
| Events / Templates / Generate / Batches | `/admin/events`, `/admin/templates`, `/admin/generate`, `/admin/batches` |
| **Invitations (search / trace / allow-rescan / revoke)** | `/admin/invitations` |
| Ushers / Admins / Scan logs | `/admin/ushers`, `/admin/admins`, `/admin/logs` |
| Usher PIN pad | `/usher/login` |
| Gate scanner (phone) | `/scan` |

## PIN-only identification (exact implementation)

The PIN alone identifies the usher. Two keyed HMAC-SHA256 derivations share
one server-only secret (`USHER_PIN_PEPPER`, an env var never baked into
client code):

1. **`pinLookupIndex(pin)` = HMAC(pepper, "pin-index:" + pin)** — the
   deterministic, non-reversible index used for lookup. It is the DOCUMENT
   ID in the `pinRegistry` collection: `{ usherId }`. Because Firestore
   document-ID creation is atomic, two ACTIVE ushers can never hold the
   same PIN — concurrent admin creates are serialized by the transaction
   (worst case, a retry). Plaintext PINs are never stored anywhere.
2. **`pinVerifier(usherId, pin)` = HMAC(pepper, usherId + ":" + pin)** —
   the per-account confirmation key stored on the usher document and
   compared timing-safely (constant-time `safeEqual`) AFTER the lookup.

Sign-in flow: index lookup in `pinRegistry` → resolve `usherId` → load the
usher record → check active state → check lockout → confirm with
`pinVerifier` → clear failure counters → issue the signed usher session
carrying `{ usherId, eventId (from the record), exp }`. Unassigned PINs
get a uniform "Invalid PIN." and a small fixed delay to slow blind
guessing. Active usher PINs are globally unique across the deployment.
Disabling an usher RELEASES the PIN index; re-enabling re-claims it, and
if another usher took the PIN in the meantime the admin must reset it.
PIN resets run the same atomic uniqueness check. Ushers created before
v1.3.0 have no index yet and are flagged `needsPinMigration` — an admin
PIN reset migrates them.

## Admin session (why login is deterministic)

The production v1.2.0 flow had no server-established admin session: /login
redirected to /admin on Firebase client state alone and each page
re-validated with a Bearer ID token, producing two auth states that could
disagree (observed as login/logout ping-pong, with aborted fetches
surfacing as NS_BINDING_ABORTED). v1.3.0 makes the server session the
single authority: `POST /api/auth/session` (verify ID token → verify
admin record → set HttpOnly signed `admin_session` cookie) is the only
path to /admin; every admin API accepts the cookie and re-checks the
`users/{uid}` record per request, so disabling an admin or changing
permissions applies immediately. Logout deletes the cookie server-side
first, then the Firebase client state. The client Firebase session alone
never renders authenticated UI.

## Security model (summary)

- QR payload is an opaque random token; a copied/scanned-by-camera token
  admits nobody by itself. Only the authenticated server can consume it.
- Firestore & Storage rules deny ALL client access; everything goes
  through Next.js API routes using the Firebase Admin SDK.
- Invitation lookups use HMAC-SHA256 digests of tokens, never raw tokens.
- Scan consumption, rescan release and revocation run in atomic Firestore
  transactions.
- No raw credentials are ever logged.

## Testing

```bash
npm run test:emulator    # full suite — starts the Firestore emulator (needs JDK 21+)
npm test                 # unit tests only (no emulator required)
npm run bench:generation # opt-in card-render benchmark (RUN_BENCH=1)
```

98 tests: unit (credentials, serials, geometry, sessions, permissions),
integration (races, lockout, escalation, storm, counters, audit, routes) and
Firestore security-rules enforcement. See `docs/DEPENDENCIES.md` → "Testing
strategy" for details and for the production bugs the suite caught.

## Local setup

```bash
npm install
cp .env.example .env.local   # fill in values (see DEPLOYMENT.md)
npm run dev
```

Bootstrap the single Root Admin (one-time):

```bash
npm run bootstrap:root-admin -- --email you@example.com --password 'a-long-password'
```

Optional: generate a placeholder template for local testing:

```bash
npm run make:sample-template
```

Deploy: GitHub → Vercel. Full instructions in **DEPLOYMENT.md**.
Event-day operations: **EVENT_DAY_RUNBOOK.md**.
Library decisions: **docs/DEPENDENCIES.md**.
