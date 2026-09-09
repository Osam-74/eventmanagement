import * as admin from 'firebase-admin';

let app: admin.app.App | null = null;

/**
 * Lazily-initialized Firebase Admin SDK singleton.
 * All secrets come from server environment variables only and are never
 * bundled into the client. Initialization is deferred to first use so
 * builds and tests that never touch the server runtime do not require
 * service-account credentials.
 */
export function getAdminApp(): admin.app.App {
  if (app) return app;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY environment variables.'
    );
  }

  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
  return app;
}

export function db(): admin.firestore.Firestore {
  return getAdminApp().firestore();
}

export function bucket() {
  return getAdminApp().storage().bucket();
}

export function auth(): admin.auth.Auth {
  return getAdminApp().auth();
}
