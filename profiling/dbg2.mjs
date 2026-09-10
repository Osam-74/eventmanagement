// Mint an idToken from the Auth emulator and POST it to /api/auth/session
const email = 'perf-root@example.test', password = 'perf-root-pass-12345';
const r = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password, returnSecureToken: true }),
});
const body = await r.json();
console.log('emulator signin status:', r.status);
if (!body.idToken) { console.log(JSON.stringify(body).slice(0, 300)); process.exit(1); }
const res = await fetch('http://127.0.0.1:3222/api/auth/session', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ idToken: body.idToken }),
});
console.log('session POST status:', res.status);
console.log((await res.text()).slice(0, 300));
