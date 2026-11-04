# Final room mapping and archive procedure

The active application recognizes **only the 11 approved room/resource names**. Room 258 is unavailable for public bookings. The former Dance Studio maps to **202 A - Klohverleaf Dance Academy and Multipurpose Room** via its existing storage partition.

The following resources have **no replacement** and must be archived, not reassigned:

- Meeting Room 1
- Meeting Room 2
- Meeting Room 3
- Meeting Room 4
- Outdoor Courtyard

## Important: deployment does not automatically migrate Azure Tables

To avoid unexpected deletion of live data, the supplied archive utility is **dry-run by default**. Until you run the archive, the retired records remain in `NphcReservations` but are hidden from the calendar and approver dashboard. Their old slot records may still exist; these partition IDs are not reused for new rooms.

1. Back up/export `NphcReservations` and `NphcSlots` before making changes.
2. Open a terminal in the `api` folder with `STORAGE_CONNECTION_STRING` set securely in the environment (do not commit it or paste it into chat).
3. Install dependencies with `npm install` if needed.
4. Preview: `node ../scripts/archive-retired-reservations.mjs`.
5. Review the output; apply only when satisfied: `node ../scripts/archive-retired-reservations.mjs --apply`.
6. Verify that records were copied to `NphcArchivedReservations` and no retired records remain in `NphcReservations`.

The archive retains original room names **only inside the separate audit/archive table**, where they are needed to faithfully preserve historical records. They are not displayed in the app. The script copies and verifies each record before removing its original and associated owned slots. Re-running is safe for already archived records. Azure Tables operations across multiple tables are not atomic; inspect any reported errors before retrying.

**Do not** import the retired bookings as active reservations: the user confirmed these resources have no equivalent. The original Google Calendar migration is a separate task.

## Preserve former Dance Studio reservations (REQUIRED)

**Dance Studio is NOT a retired resource.** Every existing reservation, including all
Klohverleaf Dance Academy dates and recurring occurrences, must remain active.
The backend temporarily recognizes existing Dance Studio records in storage partition `1_`
as Room 202 A, so approved reservations continue appearing and blocking their times.

After backing up `NphcReservations` and `NphcSlots`, run from the `api` directory
with `STORAGE_CONNECTION_STRING` set securely:

```sh
node ../scripts/migrate-dance-studio.mjs
node ../scripts/migrate-dance-studio.mjs --apply
```

The script changes **only** the resource label to
`202 A - Klohverleaf Dance Academy and Multipurpose Room`. It preserves the
reservation ID, partition, time-slot claims, dates, statuses, recurrence metadata,
and requester details. It is safe to rerun. Do not archive Dance Studio bookings.

Then separately run the retired-room archive script (dry-run first).
No Azure data migration is performed merely by deploying the ZIP.
