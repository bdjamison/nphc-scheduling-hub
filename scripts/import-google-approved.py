"""One-time Google-priority Azure Tables migration. Requires explicit workflow_dispatch confirmation.
No public API changes. Uses Entra workload identity via DefaultAzureCredential.
"""
import argparse, json, os, hashlib, datetime as dt, uuid, pathlib, sys
from collections import defaultdict
from azure.identity import DefaultAzureCredential
from azure.data.tables import TableServiceClient, UpdateMode
from azure.core.exceptions import ResourceNotFoundError, ResourceExistsError
from azure.core import MatchConditions

ROOT=pathlib.Path(__file__).resolve().parent
ROOMS={
 '201':("201 - Howard County Executive, Vanessa Atterbeary, Esq. - Main Meeting Space",0),
 '202':('202 - James . Martin Hospitality Lounge (Kitchen Area)',10),
 '202A':('202 A - Klohverleaf Dance Academy and Multipurpose Room',1),
 '250':('250 - Dr. Calvin Ball Legacy Lounge',3),
 '255':('255 - Delegate Frank Turner Computer Lab',8),
 '256':('256 - NPHC HC STEM GYM',2),
 '257':('257 - Roger L. Barnes - Meeting Room',11),
 '259':('259 - Alice Clark - Meeting Room',13),
 '260':('260 - Dr. Vernon C. Gray - Meeting Room',14),
 '261':('261 - Ruth Conway - Meeting Room',15),
}

def hhmm(t):
 h,m=map(int,t.split(':'));return h*60+m

def slotkeys(start,end):
 # Claim EVERY 30-minute bucket intersecting the actual interval, including :15/:45 boundaries.
 # This prevents the public API's 30-minute slot logic from allowing overlapping bookings.
 a,b=hhmm(start),hhmm(end)
 if not 0<=a<b<=1440:raise ValueError(f'Invalid interval {start}-{end}')
 return [f'{n//60:02d}{n%60:02d}' for n in range((a//30)*30,b,30)]

def main():
 p=argparse.ArgumentParser();p.add_argument('--apply',action='store_true');p.add_argument('--confirm',default='');a=p.parse_args()
 if a.apply and a.confirm!='GOOGLE_WINS_REMOVE_AZURE':raise SystemExit('Missing exact destructive-action confirmation')
 account=os.environ['AZURE_STORAGE_ACCOUNT']; endpoint=f'https://{account}.table.core.windows.net'
 client=TableServiceClient(endpoint=endpoint,credential=DefaultAzureCredential(exclude_interactive_browser_credential=True))
 reservations=client.get_table_client('NphcReservations');slots=client.get_table_client('NphcSlots')
 manifest=json.loads((ROOT/'google-approved-appointments.json').read_text())
 appointments=manifest['appointments']; keys=set(); normalized=[]
 if manifest.get('scope')!='approved-only-323' or manifest.get('excludeUnreviewed') is not True or manifest.get('expectedCount')!=323 or len(appointments)!=323:
  raise SystemExit('Migration scope guard failed: only the user-approved 323-appointment manifest is permitted')
 for entry in appointments:
  room=entry['room'];name,pid=ROOMS[room];date=entry['date'];start=entry['start'];end=entry['end']
  dt.date.fromisoformat(date);claim=slotkeys(start,end);identity=(pid,date,start,end)
  if identity in keys:raise SystemExit(f'Duplicate approved Google room/time: {identity}')
  keys.add(identity);normalized.append({**entry,'resource':name,'partitionKey':f'{pid}_{date}','keys':claim})
 # Prevent overlapping Google meetings before any write; conflicting Google entries require explicit resolution.
 occupied={}
 for e in normalized:
  for key in e['keys']:
   claim=(e['partitionKey'],key)
   if claim in occupied:raise SystemExit(f'Unresolved Google/Google overlap: {occupied[claim]} and {e}')
   occupied[claim]=e
 existing=list(reservations.list_entities()); existing_slots=list(slots.list_entities())
 by_pk=defaultdict(list)
 for r in existing:by_pk[r['PartitionKey']].append(r)
 by_slot={(s['PartitionKey'],s['RowKey']):s for s in existing_slots}
 removals={}; inserts=[];duplicates=0
 for e in normalized:
  matching=[r for r in by_pk[e['partitionKey']] if r.get('migrationSource')=='google-calendar' and r.get('start')==e['start'] and r.get('end')==e['end'] and r.get('resource')==e['resource'] and r.get('description')==e['description']]
  if matching:
   # A reservation without all of its slots is an incomplete prior import, not a duplicate.
   if all(by_slot.get((e['partitionKey'],k),{}).get('reservationId')==matching[0]['RowKey'] for k in e['keys']):
    duplicates+=1;continue
   raise SystemExit(f'Incomplete previously imported Google reservation: {matching[0]["RowKey"]}; manual repair required')
  for r in by_pk[e['partitionKey']]:
   if r.get('status') in ('expired','declined','revoked'):continue
   if r.get('migrationSource')=='google-calendar':
    raise SystemExit(f'Conflicting previously imported Google reservation: {r["RowKey"]}')
   if hhmm(r.get('start','00:00'))<hhmm(e['end']) and hhmm(e['start'])<hhmm(r.get('end','00:00')):
    removals[(r['PartitionKey'],r['RowKey'])]=r
  for k in e['keys']:
   s=by_slot.get((e['partitionKey'],k))
   if s:
    owner=next((r for r in by_pk[e['partitionKey']] if r['RowKey']==s.get('reservationId')),None)
    if owner:removals[(owner['PartitionKey'],owner['RowKey'])]=owner
    else:raise SystemExit(f'Orphaned slot at {e["partitionKey"]}/{k}; cannot safely replace')
  inserts.append(e)
 print(json.dumps({'approved':len(normalized),'already_present':duplicates,'to_insert':len(inserts),'azure_to_remove':len(removals)},indent=2))
 if not a.apply:return
 # Private downloadable backup artifact must exist before destructive changes.
 backup={'exportedAt':dt.datetime.now(dt.timezone.utc).isoformat(),'reservations':existing,'slots':existing_slots}
 backup_path=pathlib.Path(os.environ.get('RUNNER_TEMP',str(ROOT)))/'google-migration-backup.json'
 backup_path.write_text(json.dumps(backup,default=str,indent=2));os.chmod(backup_path,0o600)
 print('BACKUP_SHA256',hashlib.sha256(backup_path.read_bytes()).hexdigest(),flush=True)
 # Archive each displaced reservation first. Existing archived records are retained.
 archive=client.get_table_client('NphcArchivedReservations')
 try:archive.create_table()
 except ResourceExistsError:pass
 for r in removals.values():
  data={k:v for k,v in r.items() if k not in ('etag','Timestamp','timestamp')}
  data.update(archivedAt=dt.datetime.now(dt.timezone.utc).isoformat(),archiveReason='Superseded by approved Google Calendar migration')
  archive.upsert_entity(data,mode=UpdateMode.REPLACE)
  archive.get_entity(r['PartitionKey'],r['RowKey'])
  for k in json.loads(r.get('slotKeys') or '[]'):
   s=by_slot.get((r['PartitionKey'],k))
   if s and s.get('reservationId')==r['RowKey']:
    try:slots.delete_entity(r['PartitionKey'],k,etag=s.metadata.get('etag'),match_condition=MatchConditions.IfNotModified)
    except Exception as exc:raise RuntimeError(f'Failed releasing owned slot {k}: {exc}')
  # Also release any slots owned by this reservation, even if slotKeys is stale.
  for s in existing_slots:
   if s['PartitionKey']==r['PartitionKey'] and s.get('reservationId')==r['RowKey']:
    try:slots.delete_entity(s['PartitionKey'],s['RowKey'])
    except ResourceNotFoundError:pass
  reservations.delete_entity(r['PartitionKey'],r['RowKey'])
 # Preserve deterministic IDs so reruns can reconcile partial imports.
 for e in inserts:
  rid=str(uuid.uuid5(uuid.NAMESPACE_URL,'nphc-google-migration:'+e['partitionKey']+':'+e['start']+':'+e['end']+':'+e['description']))
  existing_one=next((r for r in by_pk[e['partitionKey']] if r['RowKey']==rid),None)
  if existing_one:continue
  now=dt.datetime.now(dt.timezone.utc).isoformat()
  # Slots are created in a single partition-atomic transaction, as in the deployed API.
  # On reservation creation failure, remove only slots owned by this import.
  slot_entities=[{'PartitionKey':e['partitionKey'],'RowKey':k,'reservationId':rid} for k in e['keys']]
  try:
   slots.submit_transaction([('create',entity) for entity in slot_entities])
  except Exception as exc:
   raise RuntimeError(f'Unable to claim slots for {e["partitionKey"]}; no slots were intentionally overwritten: {exc}')
  try:
   reservations.create_entity({'PartitionKey':e['partitionKey'],'RowKey':rid,'name':'Bruce Nelson','email':'nphcoperations@gmail.com','phone':'','organization':'NPHC-HC','description':e['description'],'resource':e['resource'],'date':e['date'],'start':e['start'],'end':e['end'],'status':e.get('status','approved'),'createdAt':now,'slotKeys':json.dumps(e['keys']),'migrationSource':'google-calendar'})
  except Exception:
   for k in e['keys']:
    try:
     owned=slots.get_entity(e['partitionKey'],k)
     if owned.get('reservationId')==rid:slots.delete_entity(e['partitionKey'],k)
    except ResourceNotFoundError:pass
   raise
 print('Migration completed. No notification emails sent.')

if __name__=='__main__':main()
