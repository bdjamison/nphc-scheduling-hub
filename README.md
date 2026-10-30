# NPHC Howard County Community Center Scheduling Hub

A public calendar, anonymous room reservation requests, conflict-safe temporary holds, email notifications, and a secure approver dashboard. Built for Azure Static Web Apps + GitHub.

## Resources
Main Large Conference Room, Dance Studio, STEM Lab, Legacy Lounge, Meeting Rooms 1–4, Computer Lab, Outdoor Courtyard.

## Architecture
- Vite + React frontend, built into `dist`.
- Azure Static Web Apps managed Azure Functions API (`api/`).
- Azure Table Storage for durable reservations and 30-minute slot locks. **Storage is not necessarily free**; check your subscription and pricing.
- Azure Communication Services Email for notifications. **Email may incur charges**; domain/sender verification required.
- Microsoft Entra ID authentication for approvers. Configure the SWA `approver` role through role invitations/assignments and ensure your SWA plan/provider supports the chosen identity setup. Public calendar and request form require no sign-in.

## Deploy from GitHub
1. Create a GitHub repository and upload all files in this folder, preserving the structure.
2. In Azure Portal, create a **Static Web App** (Free plan if eligible). Select GitHub, your repository and branch, and **Custom** build preset.
3. Set **App location:** `/`, **API location:** `api`, **Output location:** `dist`.
4. Azure generates a GitHub Actions workflow. Confirm it runs `npm install`/`npm run build` for the frontend and deploys the API.
5. Create an Azure Storage account (standard general-purpose v2). In Static Web App **Environment variables**, add `STORAGE_CONNECTION_STRING` with its storage connection string.
6. Configure Azure Communication Services Email and set `ACS_CONNECTION_STRING`, `MAIL_FROM` (verified sender), `APPROVER_EMAILS` (comma-separated), and `PUBLIC_BASE_URL` (your deployed https URL). Without these, requests still save but email does not send.
7. Configure SWA authentication for Microsoft Entra ID. Invite/assign authorized people the exact role `approver`. The app enforces this role server-side as well as in route rules. Do not assign `approver` to the anonymous role.
8. Test the entire workflow: public request, conflict rejection, approver login, approve/decline, emails, and calendar update.

## Important behavior
- Dates/times use America/New_York; requested intervals must start and end on half-hour boundaries, last at most 12 hours, and fall within a rolling 18-month window.
- Pending requests hold all selected 30-minute slots for 48 hours. On relevant API reads/requests, expired holds are released (lazy expiration); a scheduled cleanup job is recommended for production.
- Slot creation is atomic for a single resource/date via Azure Table transaction. Approved requests keep their slot locks. Declined requests release locks.
- The public calendar displays approved events only. Anonymous users can check availability but cannot view private contact details.
- Approver emails link to the approval dashboard; decisions are made after authenticated login, not from unsecured one-click email links.
- No cancellation/edit, recurrence, facility hours, admin resource management, or anti-bot CAPTCHA in v1. Add these before broad public launch if required.

## Local development
Run `npm install && npm run dev` for the UI. For end-to-end API development, install Azure Functions Core Tools and Azure Static Web Apps CLI, configure `api/local.settings.json` locally (never commit credentials), and run `swa start http://localhost:5173 --api-location api`. Run `npm install` inside `api/` first. The frontend will not submit requests without the API and storage configuration.

## Production hardening
- Use a scheduled Azure Function to expire stale holds and send reminders. Ensure approval is not attempted after expiry.
- Add rate limiting/CAPTCHA, retention/deletion policies for contact information, monitoring, and backups.
- Review concurrency edge cases, including expiry cleanup and decisions occurring at the same time, before high-volume use.
- Verify email sender and role provider compatibility in your Azure subscription.

## Option A: shared approver authority (confirmed)
All authenticated users assigned the `approver` Static Web Apps role have equal authority over every resource. Any one can approve or decline a pending reservation. Decisions use optimistic concurrency and a second simultaneous decision should be rejected.

## Deployment cautions
- **Do not publicly launch until tested.** No GitHub/Azure deployment has been performed by this package creator.
- The `staticwebapp.config.json` is in `public/` so Vite copies it into the deployed `dist/` directory. Confirm the deployed file exists.
- Check whether built-in Entra ID (`/.auth/login/aad`) and role invitations are supported in the selected SWA plan/tenant. If not, a different supported authentication configuration or plan is required.
- Expired holds currently use lazy cleanup and are not guaranteed to release at precisely 48 hours until a scheduled cleanup is added.
- Do not treat the app as production hardened until CAPTCHA/rate limiting, retention policy, email failure monitoring, and concurrent approval/expiration edge cases are addressed.
- Never commit storage connection strings or email credentials to GitHub.

## October 2026 enhancement package

- Approvers may approve, decline, or revoke approved reservations with optional comments. Decisions notify the requester.
- Revocation retains the reservation record and releases only slots still owned by that reservation.
- Calendar API returns requester/event details only for authenticated users with the `approver` role. Public visitors receive only room, date, time, and `Blocked`.
- Calendar now includes Day, Week, and Month views and Maryland-flag-inspired styling.
- Expiration updates reservation status with ETag checking before releasing owned slots.

**Deployment:** Upload the changed files to the existing GitHub repository, keeping paths unchanged. Review the GitHub Actions build/deployment, then test with a dedicated reservation before using with real bookings. This package has not been deployed to Azure or integration-tested against your production storage.

## Howard County branding and approvals history (October 2026)

- Header uses the user-provided NPHC emblem (`public/nphc-logo.png`), labeled Howard County, Maryland.
- The approver dashboard has **Current Requests** and **History** tabs.
- History supports reservation-date range, resource, requesting organization, requesting person's name/email, and status filters. Filtered results can be exported as CSV; 20 records display per page.
- History is loaded from the existing approver-protected `/api/approvals` endpoint; it is not exposed through the public calendar endpoint. No new environment variables or Azure tables are required.
- Existing approve, decline, revoke, email, and public calendar privacy workflows are retained.
- **Before production use:** verify GitHub Actions build and test approver-only history, all filters, CSV export, and revocation. History filtering/pagination are client-side; a future server-side paginated endpoint is recommended if records grow large.
