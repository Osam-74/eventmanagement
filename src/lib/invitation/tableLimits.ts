/**
 * Table / seat label limits, shared by the server (services/invitationTable) and
 * the admin UI. Dependency-free on purpose so client components can import it
 * without pulling firebase-admin into the browser bundle.
 *
 * 120 (owner request, 2026-10-03; was 24): one tag can cover ~20 tables, written as
 * "1, 2, 3, ... 20" (about 50 characters), with room to spare.
 */
export const TABLE_MAX_LENGTH = 120;
/** Above this length the usher popup / admin chip switch to a smaller font so it still fits. */
export const TABLE_LONG_THRESHOLD = 14;
