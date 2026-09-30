/**
 * One-time: keep Guest moments working for admins who used it under
 * canManageInvites. Dry run by default; pass --apply to write.
 *
 *   npx tsx scripts/backfill-moments-access.ts          # preview
 *   npx tsx scripts/backfill-moments-access.ts --apply  # do it
 *
 * Needs the same FIREBASE_* env vars as the app (see .env.example).
 */
import { db } from '../src/lib/firebase/admin';
import { backfillMomentsAccess } from '../src/lib/services/admins';

async function main() {
  const apply = process.argv.includes('--apply');
  const r = await backfillMomentsAccess(db(), { dryRun: !apply });
  console.log(`${apply ? 'UPDATED' : 'WOULD UPDATE'} ${r.updated.length} admin(s) with access to ${r.eventCount} event(s):`);
  for (const id of r.updated) console.log('  +', id);
  console.log(`skipped ${r.skipped.length} (root admin, no invite permission, or already set)`);
  if (!apply) console.log('\nDry run only. Re-run with --apply to write.');
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
