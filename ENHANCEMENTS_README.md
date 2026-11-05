# Scheduling Hub enhancements — staged release

This package is a **partial implementation** of the requested improvements, prepared for code review. It is **not** the completed approver-editing release.

## Implemented
- Public calendar: Greek-letter abbreviation for recognized Divine Nine organizations. For other organizations, show a shortened organization name. No requester name, email, or phone is exposed.
- Public calendar: display approved and HOLD records as occupied. The booking slot logic remains unchanged.
- Approver dashboard: facility-usage horizontal bars, calculated from approved and HOLD reservation hours, with date-range and facility filters. Each dated occurrence counts once.

## Not yet implemented
- Approver editing of individual reservations, entire recurring series, and future occurrences.
- Automatic requester emails after edits, audit trail for edits, and safe multi-record edit transactions.
- Reliable recurrence metadata reconstruction for imported Google events.

## Deployment safety
- This ZIP is for review; do not deploy until the remaining edit workflow is implemented and tested against a staging copy of Azure Tables.
- The one-time migration workflow is unchanged and should **never be run again**.
- No live data has been modified by preparing this package.
