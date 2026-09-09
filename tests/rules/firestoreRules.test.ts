import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';

const PROJECT = 'rules-test';

const RULES = readFileSync('firestore.rules', 'utf8');

describe('deny-all Firestore rules stay enforced', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT,
      firestore: { rules: RULES, host: process.env.FIRESTORE_EMULATOR_HOST?.split(':')[0] ?? '127.0.0.1', port: Number(process.env.FIRESTORE_EMULATOR_HOST?.split(':')[1] ?? 8080) },
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('invitations').doc('seed').set({ status: 'unused' });
      await ctx.firestore().collection('events').doc('seed').set({ name: 'x' });
    });
  });

  afterAll(async () => { await env.cleanup(); });

  const COLLECTIONS = ['invitations', 'events', 'scanLogs', 'users', 'ushers', 'auditLogs', 'batches', 'templates'];

  for (const coll of COLLECTIONS) {
    it(`denies unauthenticated client reads on ${coll}`, async () => {
      const db = env.unauthenticatedContext().firestore();
      await assertFails(db.collection(coll).limit(1).get());
    });
    it(`denies unauthenticated client writes on ${coll}`, async () => {
      const db = env.unauthenticatedContext().firestore();
      await assertFails(db.collection(coll).doc('evil').set({ x: 1 }));
    });
    it(`denies even a signed-in client claiming admin on ${coll}`, async () => {
      const db = env.authenticatedContext('intruder', { admin: true, email: 'intruder@test.local' }).firestore();
      await assertFails(db.collection(coll).limit(1).get());
      await assertFails(db.collection(coll).doc('evil').set({ x: 1 }));
    });
  }

  it('still allows the trusted server (admin SDK path) — production code works', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await assertSucceeds(ctx.firestore().collection('invitations').limit(1).get());
    });
  });
});
