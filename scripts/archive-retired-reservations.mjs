// Run from the api directory with: node ../scripts/archive-retired-reservations.mjs [--apply]
// DRY RUN by default. Archives the five retired resources only.
import { TableClient } from '@azure/data-tables';
const conn=process.env.STORAGE_CONNECTION_STRING;
if(!conn){console.error('Set STORAGE_CONNECTION_STRING in the current shell (never commit it).');process.exit(1)}
const apply=process.argv.includes('--apply');
const retired=new Set(['Meeting Room 1','Meeting Room 2','Meeting Room 3','Meeting Room 4','Outdoor Courtyard']);
const active=TableClient.fromConnectionString(conn,'NphcReservations');
const archive=TableClient.fromConnectionString(conn,'NphcArchivedReservations');
const slots=TableClient.fromConnectionString(conn,'NphcSlots');
const records=[];
for await(const r of active.listEntities())if(retired.has(r.resource))records.push(r);
console.log(`${apply?'APPLY':'DRY RUN'}: ${records.length} retired reservation records found`);
for(const r of records)console.log(`${r.partitionKey}/${r.rowKey} | ${r.resource} | ${r.date} | ${r.status}`);
if(!apply){console.log('No changes made. Review the records and run with --apply to archive.');process.exit(0)}
await archive.createTable().catch(e=>{if(e.statusCode!==409)throw e});
let moved=0,errors=0;
for(const r of records){
 try{
  // Copy first; verify existence before removing active reservation or slot claims.
  const {etag,timestamp,...data}=r;
  await archive.upsertEntity({...data,archivedAt:new Date().toISOString(),archiveReason:'Retired resource; no equivalent room'},'Replace');
  await archive.getEntity(r.partitionKey,r.rowKey);
  // Remove only slot records actually owned by this reservation.
  for(const key of JSON.parse(r.slotKeys||'[]')){
   try{const slot=await slots.getEntity(r.partitionKey,key);if(slot.reservationId===r.rowKey)await slots.deleteEntity(r.partitionKey,key,{etag:slot.etag})}
   catch(e){if(![404,412].includes(e.statusCode))throw e}
  }
  await active.deleteEntity(r.partitionKey,r.rowKey,{etag:r.etag});moved++;
 }catch(e){errors++;console.error(`FAILED ${r.partitionKey}/${r.rowKey}: ${e.message}`)}
}
console.log(`Archived ${moved} records; errors ${errors}. Original historical details are retained in NphcArchivedReservations.`);
if(errors)process.exitCode=1;
