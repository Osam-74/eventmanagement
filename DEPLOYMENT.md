# Deployment guide

## 1. Firebase console (one-time, project owner)

1. Create/use the Firebase project (already created: `event-management-b5999`).
2. **Authentication** → Sign-in method → enable **Email/Password**.
3. **Firestore Database** → Create database. **Choose the region deliberately
   before any production data is created.** For an event in Nigeria, prefer
   `europe-west` (Belgium/Netherlands) or the lowest-latency supported
   region you measure from Lagos. This is a one-way decision — ask the owner
   to confirm before creating.
4. **Storage** → same region as Firestore.
5. **Project settings → Service accounts → Generate new private key**. You
   will paste its 3 values into Vercel env vars (NOT the JSON file).
6. In **Authentication → Settings → Authorized domains**, add your
   production domain (and the Vercel preview domain if you test there).
7. Deploy the security rules and indexes:
   - `firestore.rules`, `storage.rules`, `firestore.indexes.json`
   - With the Firebase CLI: `firebase deploy --only firestore:rules,firestore:indexes,storage`
   - Or paste them in the console (Firestore → Rules/Index tabs).
   The first query after deployment shows a console link if an index is
   still missing — indexes can also be created by clicking that link.

## 2. Generate the three server secrets

```bash
openssl rand -hex 32   # → QR_TOKEN_HMAC_KEY
openssl rand -hex 32   # → → USHER_PIN_PEPPER
openssl rand -hex 32   # → → USHER_SESSION_SECRET
```

Keep these values. If `QR_TOKEN_HMAC_KEY` changes after invitations are
generated, existing credentials stop validating — never rotate it mid-event.

## 3. Vercel

1. Import the GitHub repo into Vercel; production branch `main`.
2. Environment variables (Production and Preview separately):

```
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=event-management-b5999.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=event-management-b5999
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=event-management-b5999.firebasestorage.app
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=690920844020
NEXT_PUBLIC_FIREBASE_APP_ID=1:690920844020:web:5aab6143dd0147be90cca1

FIREBASE_PROJECT_ID=event-management-b5999
FIREBASE_CLIENT_EMAIL=...           # from the service-account JSON
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"  # real newlines also work
FIREBASE_STORAGE_BUCKET=event-management-b5999.firebasestorage.app

QR_TOKEN_HMAC_KEY=...
USHER_PIN_PEPPER=...
USHER_SESSION_SECRET=...

# Guest photo/video uploads (Cloudflare R2). Optional: without these the
# "Guest moments" feature is simply switched off. See section 3a.
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=...
```

3. Server routes run on the Node runtime (already configured per-route).
   The batch-generate and ZIP-download routes declare `maxDuration = 300`;
   on plans that cap at 60s, keep batches ≤ 50 share-profile cards and
   expect HQ batches to run smaller.
4. Deploy and confirm HTTPS.

## 3a. Guest moments: Cloudflare R2 (photos and videos from guests)

Guests open `/moments/<event-slug>` (no sign-in), pick photos/videos from their
phone gallery, and the files upload **straight to Cloudflare R2**. They never
touch Firebase Storage (where the invitation cards live) and never pass through
a Vercel function. Max **100 MB per file**; each guest can add up to 40 files.

**One-time setup (Cloudflare dashboard):**

1. R2 > **Create bucket** (e.g. `event-moments`). Keep it **private** (no public access).
2. R2 > **Manage R2 API Tokens** > Create API token > permission
   **Object Read & Write**, limited to that one bucket. Copy the
   *Access Key ID* and *Secret Access Key* (shown once), and note your
   *Account ID* (R2 overview page).
3. Bucket > Settings > **CORS policy**: browsers upload directly, so R2 must allow it.
   `ExposeHeaders: ETag` is **required**: large videos are uploaded in parts and
   the page needs each part's ETag to finish them.

```json
[
  {
    "AllowedOrigins": ["https://YOUR-SITE-DOMAIN"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

4. Add the four `R2_*` variables in Vercel (Production) and redeploy.
5. Deploy the new Firestore indexes: `firebase deploy --only firestore:indexes`
   (the `moments` collection needs them; the emulator does not).

**Using it:** Admin > **Guest moments** shows the guest link for the selected
event (copy it, or turn it into a QR code), a grid of everything uploaded, and
**Export selected** / **Export all** (zip) / **Delete marked**.

**Cost notes:** R2 has no download (egress) fees and a free tier of 10 GB stored
per month. Deleting media after you have exported it brings the ongoing cost to
zero. Set a Cloudflare billing notification if you want an early warning.

## 4. Bootstrap the single Root Admin

Run locally (with the service-account env vars + secrets exported):

```bash
npm run bootstrap:root-admin -- \
  --email your-root-admin@example.com \
  --password 'choose-a-long-strong-password'
```

Then sign in at `/login`. Every other administrator is created from the
Admins page with explicit capabilities. Never share the Root Admin login.

## 5. Configure the event

1. `/admin/events` → Create event (name, slug, date). e.g. I & S Wedding,
   `is-wedding-2026` (serial prefix `ISWED`), 2026-10-03.
2. `/admin/templates` → upload the **final QR-ready master artwork**
   (PNG preferred, highest resolution, containing the approved design and
   the gold **Access code** frame but NO QR inside). The app derives the QR
   box from the approved normalized ratios (0.390654 / 0.663265 / 0.220561).
3. Assign the template on the Events page.
4. `/admin/ushers` → create each gate official (auto 6-digit PIN shown once).
5. `/admin/generate` → generate a small test batch and verify the QR decodes
   and the serial number prints cleanly before generating for real guests.

## 6. Pre-event verification checklist

- Print one generated card; scan it with a normal phone camera — it should
  show only the opaque `IS26.…` text.
- Scanner page (`/scan`) on each gate phone: sign in, scan test card →
  ACCESS GRANTED; scan again → ALREADY USED with the first-use time.
- With scanning deactivated, confirm a valid unused card is rejected and
  remains unused.
- On `/admin/invitations`, search the test serial → verify status,
  scanned-by and time; test **Allow rescan** and confirm the card validates
  again.
- Revoke a test card → confirm rejection at the gate.
- Delete/revoke all rehearsal cards before the event.

See EVENT_DAY_RUNBOOK.md for the day-of procedure.
