#!/usr/bin/env node
/**
 * One-time controlled bootstrap for the single ROOT_ADMIN account.
 *
 * Run locally (never on a server) with service-account env vars set:
 *   npm run bootstrap:root-admin -- --email you@example.com --password 'Str0ngPass!x' --display-name 'Olamide'
 *
 * Refuses to run if a ROOT_ADMIN already exists (use --force only when
 * deliberately migrating owners, and disable the old account afterwards).
 */
import { parseArgs } from 'node:util';
import { initializeApp, credential } from 'firebase-admin';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    'display-name': { type: 'string' },
    force: { type: 'boolean', default: false },
  },
});

const { email, password, force } = values;
if (!email || !password || password.length < 10) {
  console.error('Usage: npm run bootstrap:root-admin -- --email <email> --password <min 10 chars> [--display-name <name>]');
  process.exit(1);
}

const privateKey = (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
  console.error('Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY env vars.');
  process.exit(1);
}

const app = initializeApp({
  credential: credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  }),
});

const db = app.firestore();
const auth = app.auth();

const existing = await db.collection('users').where('accountType', '==', 'ROOT_ADMIN').limit(2).get();
if (!existing.empty) {
  if (!force) {
    console.error(`A ROOT_ADMIN already exists (${existing.docs.map((d) => d.data().email).join(', ')}).`);
    console.error('The system supports exactly one Root Admin. Use --force only for deliberate owner migration.');
    process.exit(1);
  }
  console.warn('WARNING: --force given; existing ROOT_ADMIN(s) remain and must be disabled manually.');
}

let user;
try {
  user = await auth.getUserByEmail(email);
  console.log('Existing Firebase Auth user found; promoting to ROOT_ADMIN.');
} catch {
  user = await auth.createUser({ email, password, emailVerified: true, displayName: values['display-name'] ?? email });
  console.log('Firebase Auth user created.');
}

const FieldValue = (await import('firebase-admin/firestore')).FieldValue;

await db.collection('users').doc(user.uid).set(
  {
    email,
    displayName: values['display-name'] ?? email,
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
    createdBy: 'bootstrap',
  },
  { merge: true }
);

await auth.setCustomUserClaims(user.uid, { admin: true });

await db.collection('auditLogs').add({
  action: 'ROOT_ADMIN_BOOTSTRAPPED',
  actor: user.uid,
  actorType: 'bootstrap-script',
  detail: { email },
  at: FieldValue.serverTimestamp(),
});

console.log(`\nROOT_ADMIN ready: ${email} (${user.uid})`);
console.log('Sign in at /login with this email and the password you set.');
process.exit(0);
