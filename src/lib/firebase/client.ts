'use client';

import { initializeApp, getApps, getApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';

/**
 * Firebase web (client) SDK configuration. These values identify the web app to
 * Firebase and are PUBLIC BY DESIGN — every Firebase web app ships them in the
 * browser bundle. They are not secrets: access is enforced by Firebase Auth
 * sign-in + server-side Firestore security rules, not by hiding these values.
 * (Firebase docs: https://firebase.google.com/docs/web/setup#add-sdps)
 *
 * Baked in as build-safe defaults so the client initializes even when
 * NEXT_PUBLIC_* env vars are absent (or stored as Vercel "Secret" values,
 * which are withheld from the build step). Environment variables still
 * override these defaults when they are available at build time.
 */
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBWd0UBfzfVyl4dHGF-IKbrP3-iwHDZoL0',
  authDomain: 'event-management-b5999.firebaseapp.com',
  projectId: 'event-management-b5999',
  storageBucket: 'event-management-b5999.firebasestorage.app',
  messagingSenderId: '690920844020',
  appId: '1:690920844020:web:5aab6143dd0147be90cca1',
};

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? DEFAULT_FIREBASE_CONFIG.apiKey,
  authDomain:
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? DEFAULT_FIREBASE_CONFIG.authDomain,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? DEFAULT_FIREBASE_CONFIG.projectId,
  storageBucket:
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? DEFAULT_FIREBASE_CONFIG.storageBucket,
  messagingSenderId:
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ??
    DEFAULT_FIREBASE_CONFIG.messagingSenderId,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? DEFAULT_FIREBASE_CONFIG.appId,
};

export function getFirebaseApp(): FirebaseApp {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

let emulatorWired = false;

export function getFirebaseAuth(): Auth {
  const auth = getAuth(getFirebaseApp());
  // TEST BUILDS ONLY: point the client SDK at the Firebase Auth emulator.
  // The env var is set at BUILD time by the e2e suite; production builds
  // never contain it, so this branch is compiled out.
  const emu = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
  if (emu && !emulatorWired) {
    emulatorWired = true;
    connectAuthEmulator(auth, emu, { disableWarnings: true });
  }
  return auth;
}
