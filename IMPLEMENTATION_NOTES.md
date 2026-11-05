# Reservation editor implementation — staging review

This package adds an approver-only editor (`POST /api/approvals/edit`), a React edit dialog, conflict preflight, requester change notifications, and an audit table (`NphcReservationAudit`). It retains the previous Greek abbreviation and usage-chart work.

## Important limitations before production

- The recurring editor currently supports editing existing series occurrences only when the resulting schedule has **the same number of occurrences**. Adding/removing recurring dates is deliberately rejected, not silently applied.
- Imported reservations without `seriesId` can only be edited individually. Imported Google recurring series are not automatically linked.
- Series updates are not atomic across Azure Table partitions; partial progress is reported. Concurrent edits and time swaps should be tested.
- No live Azure test, end-to-end email test, or frontend production build has been completed. **Do not deploy directly to production without testing.**
- The one-time Google migration workflow remains unchanged and must not be rerun.

## Testing checklist

1. Run `npm ci && npm run build` in an environment with npm registry access; run `npm ci` in `api/`.
2. Test approved and HOLD occurrence edits, including date/room moves and :15/:45 times.
3. Test blocked room/time conflicts and simultaneous edits.
4. Test series editing with same occurrence count, including changing weekdays and times.
5. Confirm email delivery to requester and audit entries.
6. Verify public calendar shows only org abbreviation and never requester details.
7. Verify analytics counts approved and HOLD records correctly, with filters.
