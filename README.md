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
- **Usher PIN access** — ushers sign in with name + 6-digit PIN (hashed
  with a server-only pepper, never plaintext; rate-limited with temporary
  lockout). Short-lived signed HttpOnly session, event-scoped, revocable
  instantly by disabling the usher.
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
| Gate scanner (phone) | `/scan` |

## Security model (summary)

- QR payload is an opaque random token; a copied/scanned-by-camera token
  admits nobody by itself. Only the authenticated server can consume it.
- Firestore & Storage rules deny ALL client access; everything goes
  through Next.js API routes using the Firebase Admin SDK.
- Invitation lookups use HMAC-SHA256 digests of tokens, never raw tokens.
- Scan consumption, rescan release and revocation run in atomic Firestore
  transactions.
- No raw credentials are ever logged.

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
