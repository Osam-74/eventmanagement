# Dependency decisions

Recorded per the library-first policy (spec §6). Versions are pinned via
`package-lock.json`; keep Dependabot/GitHub dependency updates enabled.

| Package | Version | License | Why chosen | Alternatives considered | Notes |
|---|---|---|---|---|---|
| next | 15.x (locked) | MIT | Required App Router + API routes + Vercel first-class support | Remix, Express+SPA | Runtime Node required for image/zip routes |
| firebase / firebase-admin | 11.x / 13.x (locked) | Apache-2.0 | Official SDKs; Auth, Firestore (transactions), Storage, signed URLs | Supabase | Admin SDK bypasses security rules (server-only) |
| qrcode (node-qrcode) | 1.5.4 | MIT | Mature encoder with error-correction control + buffer output | qr-code-styling (browser, unmaintained) | Server-side render at final pixel density, EC level Q |
| html5-qrcode | 2.3.8 | MIT | Single dependency covering camera lifecycle + decoding; simplest reliable repeated-scan behavior on phones | @zxing/browser | If real-device tests favour zxing, swap is isolated to `src/app/scan/page.tsx` |
| sharp | 0.33.5 | Apache-2.0 | Standard compositing/resizing, fast, Vercel-supported | jimp (pure JS, slower), canvas | `serverExternalPackages` set in next.config |
| archiver | 7.0.1 | MIT | Streaming ZIP — never buffers a whole batch in RAM | zip.js (browser-focused) | Used in batch download route |
| zod | 3.24.1 | MIT | Schema validation on every API input | Yup | Strict typing + .safeParse pattern |
| tailwindcss | 3.4.17 | MIT | Styling without hand-rolled CSS systems | plain CSS | UI only |

## Security/maintenance

- All releases are maintained as of selection time; recheck before event
  freeze (spec §28 step 11).
- Replacement plan: QR encoder and scanner are isolated in `src/lib/invitation/render.ts`
  and `src/app/scan/page.tsx` respectively, so either can be swapped after
  real-device testing without touching business logic.
- No client bundle contains server code: admin SDK usage lives only in
  API route handlers (`serverExternalPackages` + lazy init in
  `src/lib/firebase/admin.ts`).
