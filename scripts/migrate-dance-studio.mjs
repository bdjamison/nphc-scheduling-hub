// Run from api directory: node ../scripts/migrate-dance-studio.mjs [--apply]
// Preserves every existing reservation and slot ownership; changes resource display name only.
import { TableClient } from '@azure/data-tables';
const conn=process.env.STORAGE_CONNECTION_STRING;
if(!conn){console.error('Set STORAGE_CONNECTION_STRING securely before running.');process.exit(1)}
const client=TableClient.fromConnectionString(conn,'NphcReservations');
const old='Dance Studio';
const updated='202 A - Khloverleaf Dance Academy and Multipurpose Room';
const apply=process.argv.includes('--apply');
const matches=[];
for await(const r of client.listEntities())if(r.resource===old)matches.push(r);
console.log(`${apply?'APPLY':'DRY RUN'}: ${matches.length} Dance Studio reservations to preserve and rename`);
for(const r of matches)console.log(`${r.partitionKey}/${r.rowKey} | ${r.date} ${r.start}-${r.end} | ${r.status} | ${r.organization||''}`);
if(!apply){console.log('No changes made. Back up NphcReservations and NphcSlots, then rerun with --apply.');process.exit(0)}
let changed=0,errors=0;
for(const r of matches){
 try{
  // Only change the resource label. Retain partitionKey, rowKey, seriesId, slotKeys,
  // status, dates, requester, and all other metadata. Slot records are untouched.
  await client.updateEntity({partitionKey:r.partitionKey,rowKey:r.rowKey,resource:updated},'Merge',{etag:r.etag});
  changed++;
 }catch(e){errors++;console.error(`FAILED ${r.partitionKey}/${r.rowKey}: ${e.message}`)}
}
console.log(`Renamed ${changed} reservations; ${errors} errors. No reservation or slot was deleted.`);
if(errors)process.exitCode=1;
