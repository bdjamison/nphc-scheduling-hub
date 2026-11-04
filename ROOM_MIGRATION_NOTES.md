# NPHC Room Catalog Update — Migration Notes

The public resource list has 11 rooms. Room 258 is unavailable for public requests, enforced in both availability and submission APIs.

## Preserved historical partition IDs

- Main Large Conference Room -> Room 201 (partition 0)
- Dance Studio -> Room 202 A (partition 1)
- STEM Lab -> Room 256 (partition 2)
- Legacy Lounge -> Room 250 (partition 3)
- Computer Lab -> Room 255 (partition 8)

The old names remain in historical records; existing slot holds in these partitions are respected by the new names.

## Manual review required

The former Meeting Room 1–4 and Outdoor Courtyard do not have an explicit confirmed mapping to the new numbered rooms. Existing reservations for these spaces remain stored and visible under their original names, but do not automatically block new room numbers. **Before accepting new bookings**, review existing reservations for these five legacy spaces and identify their correct destination rooms. Do not delete Azure Table entities or change partition keys manually without a tested migration.

Room 258 is intentionally unavailable for public reservations; no synthetic perpetual reservation is written to Azure Tables. Approvers may review historical events, but a future admin override requires a separate explicitly authorized change.
