# One-time Google Calendar migration (NOT EXECUTED)

The repository contains a proposed manual GitHub Actions workflow `.github/workflows/import-google-calendar.yml`, a migration script `scripts/import-google-approved.py`, and a fixed-scope approved-appointment manifest `scripts/google-approved-appointments.json`.

**DO NOT RUN YET.** User explicitly closed the import scope to the current 323 appointments and excluded every remaining unreviewed Google entry. The manifest includes the approved 2026-11-21 Robotics HOLD move to Room 257, 10:00–12:00. Zeta Pearlette remains Room 255 and Zeta Amicette remains Room 256. The script intentionally stops before writing if Google/Google slots overlap. The original ICS contains additional entries, but they are intentionally outside the approved scope and must not be imported.

## Intended behavior
- Manually triggered GitHub Actions only; no changes to public booking rules.
- Microsoft Entra federated sign-in through azure/login OIDC; Azure RBAC Storage Table Data Contributor for the storage account, and create permission for the archive table.
- GitHub environment `nphc-production-migration` should require approval, and environment variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_STORAGE_ACCOUNT` must be set. Entra federated credential must match repository and GitHub environment.
- Conflicting existing Azure bookings are archived to `NphcArchivedReservations` and removed from active reservations and owned slots; Google wins.
- A backup is written to the GitHub Actions runner and uploaded as a private short-retention artifact. Restrict artifact access; do not upload or commit it to the public repository.
- Appointments are written as dated occurrences; no notification emails.

## Known limitations before execution
- Scope is frozen to the 323 entries in `google-approved-appointments.json`; do not expand from the ICS. Confirm the import logic is safe before execution; the package remains a preparation draft.
- The 2026-11-21 Robotics HOLD is Room 257; Zeta Pearlette remains Room 255 and Zeta Amicette Room 256. Unreviewed ICS entries are excluded.
- Review Azure Tables SDK entity/ETag handling, retries, restart behavior, and partial-failure recovery with a nonproduction test. Operations across tables are not atomic. The script does not guarantee rollback.
- The 30-minute bucket claim strategy blocks overlapping public reservations, including Google events at :15 and :45, but can also block adjacent bookings sharing a bucket. This limitation needs a deliberate scheduling design before execution.
- Check whether `NphcArchivedReservations` exists and whether the OIDC identity has create permissions.
- This workflow is not enabled by simply deploying the Static Web App; manual action is necessary.
