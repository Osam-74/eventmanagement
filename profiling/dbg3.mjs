import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

process.env.FIREBASE_PROJECT_ID = 'demo-eventaccess';
const app = initializeApp({ credential: cert({ projectId: 'demo-eventaccess', clientEmail: 'perf@demo.iam', privateKey: readFileSync('/tmp/perf-key.pem', 'utf8') }) });
const auth = getAuth(app);
const db = getFirestore(app);

const r = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'perf-root@example.test', password: 'perf-root-pass-12345', returnSecureToken: true }),
});
const { idToken, localId } = await r.json();
console.log('uid:', localId);

try {
  const decoded = await auth.verifyIdToken(idToken, true);
  console.log('verifyIdToken OK:', decoded.uid);
} catch (e) {
  console.log('verifyIdToken FAILED:', e.message);
}

const snap = await db.collection('users').doc(localId).get();
console.log('users doc exists:', snap.exists, snap.exists ? { accountType: snap.data().accountType, active: snap.data().active } : '');
const ev = await db.collection('events').doc('perf-wedding').get();
console.log('event exists:', ev.exists);
const invCount = await db.collection('invitations').count().get();
console.log('invitations count:', invCount.data().count);
