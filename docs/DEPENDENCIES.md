# Dependency decisions

Recorded per the library-first policy (spec §6). Versions are pinned via
`package-lock.json`; keep Dependabot/GitHub dependency updates enabled.

| Package | Version | License | Why chosen | Alternatives considered | Notes |
|---|---|---|---|---|---|
| next | 15.x (locked) | MIT | Required App Router + API routes + Vercel first-class support | Remix, Express+SPA | Runtime Node required for image/zip routes |
| firebase / firebase-admin | 11.x / 13.x (locked) | Apache-2.0 | Official SDKs; Auth, Firestore (transactions), Storage, signed URLs | Supabase | Admin SDK bypasses security rules (server-only) |
| qrcode (node-qrcode) | 1.5.4 | MIT | Mature encoder with error-correction control + buffer output | qr-code-styling (browser, unmaintained) | Server-side render at final pixel density, EC level Q |
| qr-scanner | 1.4.2 | MIT | Worker/WASM-based live decode (off main thread) + native BarcodeDetector when reliable; replaced html5-qrcode 2.3.8 after production reports of camera-on-but-never-decodes (native BarcodeDetector silently detecting nothing on some Android builds even after disabling it) | @zxing/browser | Swap is isolated to `src/app/scan/page.tsx` |
| sharp | 0.33.5 | Apache-2.0 | Standard compositing/resizing, fast, Vercel-supported | jimp (pure JS, slower), canvas | `serverExternalPackages` set in next.config |
| archiver | 7.0.1 | MIT | Streaming ZIP — never buffers a whole batch in RAM | zip.js (browser-focused) | Used in batch download route |
| zod | 3.24.1 | MIT | Schema validation on every API input | Yup | Strict typing + .safeParse pattern |
| tailwindcss | 3.4.17 | MIT | Styling without hand-rolled CSS systems | plain CSS | UI only |

## Testing stack (added in the v1.1 hardening pass)

| Package | Version | License | Why | Alternatives | Notes |
|---|---|---|---|---|---|
| vitest | 4.x | MIT | Test runner with TypeScript path-alias support out of the box | Jest | Runs unit, integration and rules suites |
| @firebase/rules-unit-testing | 4.x | Apache-2.0 | Proves the deny-all Firestore rules are actually enforced | manual review only | Emulator-backed |
| firebase-tools | latest 14.x | MIT | Firestore emulator for integration tests (JDK 21 required) | mocking Firestore (false confidence) | CI uses temurin 21 |
| jsqr | 1.4.0 | MIT | Decodes rendered invitation PNGs in tests — proves every generated QR is machine-readable | @zxing/library | Used by the opt-in generation benchmark |
| jsdom | 27.x | MIT | DOM environment for page component tests | — | |

## Testing strategy

Three tiers, all wired into CI (`npm test` locally runs against the emulator
via `firebase emulators:exec`):

1. **Unit** (`tests/unit`) — pure logic: QR credential generation (IS26 prefix,
   43-char base64url), HMAC digests, serial formatting, QR placement geometry
   (matches the approved 1070x1470 reference exactly), usher session token
   tamper/expiry rejection, PIN verifier, anti-escalation permission logic,
   batch-limit validation, scanner duplicate-submit gate.
2. **Integration** (`tests/integration`) — real Firestore transactions against
   the emulator: every scan outcome, concurrent scan/scan and scan/revoke and
   scan/allow-rescan races (exact single-admission proof over multiple
   rounds), counters after release-and-rescan cycles, audit entries never
   contain raw credentials, usher lockout (including correct-PIN-during-
   lockout and disabling a logged-in usher), admin escalation prevention,
   scanning toggle lifecycle guard, 50-session scanner storm in waves of 10,
   and route-level session-cookie enforcement.
3. **Rules** (`tests/rules`) — every collection denies unauthenticated and
   even authenticated-but-fake-admin clients; only the trusted server path
   (admin SDK) can read/write.

An opt-in benchmark (`npm run bench:generation`, `RUN_BENCH=1`) measures
card-render throughput and verifies rendered QRs decode.

### Production bugs this test suite caught (fixed in v1.1)

1. **`allowRescan`/`revokeInvitation` would always fail in production** —
   their transactions updated event/usher documents without reading them
   first (Firestore requires reads before writes, all reads before all
   writes).
2. **`allowRescan` would also fail** — `FieldValue.serverTimestamp()` cannot
   appear inside `arrayUnion` elements; replaced with `Timestamp.now()`.
3. **Admin account update wrote `undefined` Firestore values** into audit
   logs (would 500 the route); values are now conditionally built.

### Documented decisions

- **Batch caps**: share profile (3000px long edge) up to 50 cards/request;
  HQ profile (7680px) up to 20 cards/request — enforced in
  `src/lib/validation/schemas.ts` and tested. Benchmark observations (CI-class
  hardware is faster; sandbox figures): share ≈ 0.75s/card, HQ ≈ several
  seconds/card, all rendered QRs decode.
- **Scanner storm behavior**: every scan transaction updates the shared event
  counter, so same-millisecond bursts contend. `performScan` retries
  contended transactions with jittered exponential backoff (up to 6 attempts),
  which is Firestore's documented pattern. Real arrivals at a wedding gate
  are bursty (~10/s peak), not same-millisecond; the storm test models that
  and passes with exact counters. Exact transactional accounting was chosen
  over eventual-consistency on purpose: this is an access-control system.
- **Benchmarks are opt-in** (`RUN_BENCH=1`) because they are slow and
  machine-dependent; CI runs the deterministic suites only.

## Security/maintenance

- All releases are maintained as of selection time; recheck before event
  freeze (spec §28 step 11).
- Replacement plan: QR encoder and scanner are isolated in `src/lib/invitation/render.ts`
  and `src/app/scan/page.tsx` respectively, so either can be swapped after
  real-device testing without touching business logic.
- No client bundle contains server code: admin SDK usage lives only in
  API route handlers (`serverExternalPackages` + lazy init in
  `src/lib/firebase/admin.ts`).
