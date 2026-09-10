'use client';

import { redirect } from 'next/navigation';

/**
 * Batches now lives on the Generate page (owner request, 2026-09-10: "bring
 * together the generate and the batch so they should be on the same page").
 * Redirect any stale bookmark/link here instead of 404ing.
 */
export default function BatchesPageRedirect() {
  redirect('/admin/generate');
}
