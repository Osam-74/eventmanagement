#!/bin/sh
cd "$(dirname "$0")/.."
export PORT=3222 NODE_ENV=production
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
export FIREBASE_PROJECT_ID=demo-eventaccess
export FIREBASE_CLIENT_EMAIL=perf@demo.iam
export FIREBASE_PRIVATE_KEY="$(cat /tmp/perf-key.pem)"
export FIREBASE_STORAGE_BUCKET=demo-eventaccess.appspot.com
export QR_TOKEN_HMAC_KEY=perf-secret
export USHER_PIN_PEPPER=perf-pepper
export USHER_SESSION_SECRET=perf-usher-secret
export ADMIN_SESSION_SECRET=perf-admin-secret
exec npx next start
