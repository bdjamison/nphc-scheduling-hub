# Scheduling Hub enhancements — deployment notes

## Features
- Public calendar displays Greek abbreviations (ΑΦΑ, ΑΚΑ, etc.) without revealing requester details.
- HOLD and approved reservations block calendar availability.
- Approver usage chart reports reserved hours by organization, with date and facility filters.
- Approver editor supports single reservations and native linked recurring series (single, future, whole series). Weekly/monthly schedule edits can add or remove occurrences, with preflight conflict checking and a change audit table.
- Requester notification email summarizes changed fields and counts of recurring occurrences added or removed.

## Important limitations
- Imported Google Calendar records have **no `seriesId`**, so they can be edited individually but cannot safely be treated as one recurring series without explicit grouping. Do not group records by matching descriptions alone.
- Azure Table Storage does not provide cross-partition atomic transactions. Recurring edits preflight conflicts and create new occurrences before retiring old ones, but a service interruption or concurrent edit can still leave a partially applied series. If the API reports partial success, review affected dates before retrying.
- Notifications require configured `ACS_CONNECTION_STRING` and `MAIL_FROM`; the editor reports delivery errors but cannot undo a successful reservation update.
- Only a syntax/JSX transpilation check was possible in this environment. Full Vite build, Azure integration, real email delivery, and concurrency testing have NOT been performed. Test in a nonproduction Static Web App with separate test tables before production deployment.
- The one-time Google migration workflow is included unchanged. **Do not manually run it again.**

## Validation performed
- `node --check api/src/functions/app.js` passed.
- TypeScript parser and JSX transpilation of `src/main.jsx` passed.
- Manifest JSON parsed successfully.
- ZIP integrity verified.

## Deployment
1. Extract the ZIP, inspect changes, and commit the updated repository to a staging branch.
2. Build with `npm ci` or `npm install`, then `npm run build` in a network-enabled environment.
3. Test add/remove recurring occurrences, conflicts, HOLD, imported single entries, email, and audit logs against staging data.
4. Only after successful tests, merge into the production deployment branch.
