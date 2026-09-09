# Event day runbook — I & S wedding (03 October 2026)

Print this. Keep one charged admin phone/tablet open on `/admin` throughout
the event.

## T-1 day: rehearsal

1. Test every gate phone against the **production** URL: sign in with PIN,
   camera permission, scan → green.
2. Admin dashboard → **Activate Scanning** (confirmation required).
3. Scan a rehearsal card → ACCESS GRANTED. Scan again → ALREADY USED.
   Two phones scanning the same fresh card simultaneously → exactly one wins.
4. Scan a revoked rehearsal card → rejected.
5. Turn scanning **off** → open scanners immediately show EVENT NOT OPEN.
6. Search the rehearsal serial on `/admin/invitations`, try **Allow rescan**,
   scan again → green.
7. Turn scanning back **off**. Revoke/delete all rehearsal cards.
8. Check: hotspot backup SIM, power banks, gate labels.

## Event day

1. 07:00 — Admin signs into `/admin`. Dashboard shows **Scanning: INACTIVE**.
2. Doors open: press **Activate Scanning** → confirm. Status turns ACTIVE.
3. Ushers sign in at `/scan` with name + PIN (their own, never an admin's).
4. Watch the dashboard: active ushers (green dot), admitted count, recent
   scan feed.

## Common situations

**Scanner shows OFFLINE**
The camera still works but nothing validates. Move toward the hotspot;
do NOT admit anyone without the green screen.

**Guest at gate, usher sees ALREADY USED, guest insists they never entered**
1. Usher reads the serial number printed under the QR to the admin over
   phone (e.g. `ISWED-00042`).
2. Admin searches the serial on `/admin/invitations`:
   - Scanned by the same usher a minute ago + they say the screen never
     turned green → **network issue, scan response was lost**. Press
     **Allow rescan**, type the reason, release. Usher rescans → green.
     The full history (who allowed, when, why, previous scan) stays on the
     invitation.
   - Scanned by a *different* usher → someone else used that card.
     Escalate per house policy.
3. Every release is logged; do not use it for "letting in extra guests".

**Usher forgot PIN / phone lost**
Admin → Ushers → Reset PIN → new PIN shown once; hand over privately.
Or disable the usher — their open scanner dies on the next request.

**Wrong event / INVALID on a legitimate-looking card**
Check the card belongs to this event (serial prefix) and that you are
signed into the right event on the scanner.

**Internet down at every gate**
Scanners must not guess. Use the organizer's documented manual process
(paper guest list) until connectivity returns. Nothing is consumed
offline, so re-scanning later is safe.

## Doors closed

1. Admin → **Deactivate Scanning** → confirm. All gates stop instantly.
2. `/admin/logs` → **Export CSV** for the final record.
3. Later: close/archive the event from the Events page.
