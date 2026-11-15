# Approver calendar performance update

Calendar event clicks now call `GET /api/approvals/detail?id=...&resource=...&date=...` instead of downloading every reservation from `/api/approvals`.

The backend checks approver authorization, validates the supplied room and date, calculates the existing resource/date PartitionKey, and calls `getEntity(partitionKey,rowKey)` for the selected reservation. Only approved/hold records are returned. Slot keys are omitted.

The existing animated Retrieving indicator remains in place. Approver dashboard bulk loading, editing, recurring series actions, public calendar, and data storage are unchanged. No migration or configuration changes required.

Deploy frontend and API together. Confirm an approver can open/edit both one-time and recurring events; confirm a non-approver gets 403 from the detail endpoint.
