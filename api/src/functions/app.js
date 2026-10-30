import { app } from '@azure/functions';
import { TableClient } from '@azure/data-tables';
import { EmailClient } from '@azure/communication-email';
import { DateTime } from 'luxon';
import { randomUUID,randomInt,createHmac,createHash,timingSafeEqual } from 'node:crypto';
// Public-request security. Configure all three secrets before deployment.
const securityTable=()=>TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING,'NphcSecurity');
const securityReady=()=>Boolean(process.env.EMAIL_VERIFY_SECRET&&process.env.ACS_CONNECTION_STRING&&process.env.MAIL_FROM);
const hash=x=>createHash('sha256').update(String(x)).digest('hex');
const mac=x=>createHmac('sha256',process.env.EMAIL_VERIFY_SECRET).update(x).digest('hex');
const normalizedEmail=x=>String(x||'').trim().toLowerCase();
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y)};
const securityInit=async()=>{await securityTable().createTable().catch(e=>{if(e.statusCode!==409)throw e})};
const securityKey=(prefix,email)=>prefix+'_'+hash(email);
const getSecurity=async(key)=>{try{return await securityTable().getEntity('security',key)}catch(e){if(e.statusCode===404)return null;throw e}};
const changeSecurity=async(key,mutate)=>{for(let attempt=0;attempt<6;attempt++){const current=await getSecurity(key);const next=mutate(current);try{if(current)await securityTable().updateEntity({...current,...next},'Merge',{etag:current.etag});else await securityTable().createEntity({partitionKey:'security',rowKey:key,...next});return next}catch(e){if(![409,412].includes(e.statusCode))throw e}}throw Error('Too many simultaneous requests. Please retry shortly.')};
const limit=async(key,max,periodMs)=>{let blocked=false;await changeSecurity(key,old=>{const now=Date.now(),windowStart=Number(old?.windowStart||0);const count=now-windowStart<periodMs?Number(old?.count||0):0;blocked=count>=max;return {windowStart:count?windowStart:now,count:blocked?count:count+1}});if(blocked)throw Error('Too many attempts. Please try again later.')};
const verificationToken=email=>{const payload=Buffer.from(JSON.stringify({email,exp:Date.now()+30*60*1000,nonce:randomUUID()})).toString('base64url');return payload+'.'+mac(payload)};
const verifyProof=(email,token)=>{if(!securityReady()||typeof token!=='string'||token.length>2000)return false;const parts=token.split('.');if(parts.length!==2||!equal(mac(parts[0]),parts[1]))return false;try{const data=JSON.parse(Buffer.from(parts[0],'base64url').toString());return data.email===email&&Number.isFinite(data.exp)&&data.exp>Date.now()}catch{return false}};
const ensureVerified=async b=>{const email=normalizedEmail(b?.email);if(!verifyProof(email,b?.verificationToken))throw Error('Verify your email address before submitting a reservation.');await securityInit();await limit(securityKey('submitday'+new Date().toISOString().slice(0,10),email),5,86400000);const all=await readReservations();const pending=all.filter(r=>normalizedEmail(r.email)===email&&r.status==='pending'&&DateTime.fromISO(r.expiresAt).toMillis()>Date.now());if(pending.length>=3)throw Error('This email already has 3 active pending reservations. Contact the facility approver for assistance.');if(b.days&&pending.some(r=>r.seriesId))throw Error('This email already has a pending recurring series.');};
app.http('securityConfig',{methods:['GET'],authLevel:'anonymous',route:'security/config',handler:async()=>response(200,{enabled:securityReady()})});
app.http('sendVerification',{methods:['POST'],authLevel:'anonymous',route:'security/send-code',handler:async req=>{try{if(!securityReady())return response(503,{error:'Email verification is not configured.'});const b=await parse(req),email=normalizedEmail(b?.email);if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)return response(400,{error:'Enter a valid email address.'});await securityInit();await limit(securityKey('send',email),3,3600000);const code=String(randomInt(0,1000000)).padStart(6,'0');const key=securityKey('otp',email);await changeSecurity(key,()=>({codeHash:mac(email+':'+code),expiresAtMs:Date.now()+600000,attempts:0,verified:false}));await mail([email],'NPHC reservation email verification',`<p>Your NPHC Community Center verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not request this code, ignore this message.</p>`);return response(200,{message:'If the address can receive email, a verification code has been sent.'})}catch(e){console.error('Verification send failed:',e.message);return response(/Too many|bot|challenge|valid email/i.test(e.message)?429:503,{error:e.message||'Unable to send verification code.'})}}});
app.http('confirmVerification',{methods:['POST'],authLevel:'anonymous',route:'security/confirm-code',handler:async req=>{try{if(!securityReady())return response(503,{error:'Verification unavailable'});const b=await parse(req),email=normalizedEmail(b?.email),code=String(b?.code||'');if(!/^\d{6}$/.test(code)||!/^\S+@\S+\.\S+$/.test(email))return response(400,{error:'Invalid code or email.'});await securityInit();await limit(securityKey('verify',email),10,3600000);const key=securityKey('otp',email),row=await getSecurity(key);if(!row||row.verified||Number(row.expiresAtMs)<Date.now()||Number(row.attempts)>=5)return response(400,{error:'Code expired or too many attempts. Request a new code.'});const ok=equal(row.codeHash,mac(email+':'+code));await changeSecurity(key,old=>({attempts:Number(old?.attempts||0)+1,verified:ok||Boolean(old?.verified)}));if(!ok)return response(400,{error:'Incorrect verification code.'});return response(200,{verificationToken:verificationToken(email),expiresInMinutes:30})}catch(e){return response(429,{error:e.message||'Unable to verify code'})}}});
const TZ='America/New_York';
const resources=['Main Large Conference Room','Dance Studio','STEM Lab','Legacy Lounge','Meeting Room 1','Meeting Room 2','Meeting Room 3','Meeting Room 4','Computer Lab','Outdoor Courtyard'];
const table=()=>TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING,'NphcReservations');
const slotTable=()=>TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING,'NphcSlots');
const init=async()=>{await Promise.all([table().createTable().catch(e=>{if(e.statusCode!==409)throw e}),slotTable().createTable().catch(e=>{if(e.statusCode!==409)throw e})]);};
const response=(status,body)=>({status,jsonBody:body,headers:{'Cache-Control':'no-store'}});
const parse=async req=>{try{return await req.json()}catch{return null}};
const identity=req=>{try{return JSON.parse(Buffer.from(req.headers.get('x-ms-client-principal'),'base64').toString())}catch{return null}};
const approver=req=>identity(req)?.userRoles?.includes('approver')===true;
const sanitize=s=>String(s||'').trim().slice(0,500);
const dateRange=(date,start,end)=>{const a=DateTime.fromISO(`${date}T${start}`,{zone:TZ});const b=DateTime.fromISO(`${date}T${end}`,{zone:TZ});if(!a.isValid||!b.isValid||a.toISODate()!==date||b.toISODate()!==date||b<=a||b.diff(a,'minutes').minutes>1440||a.minute%30||b.minute%30||a.second||b.second)throw Error('Choose valid same-day start and end times in 30-minute increments. Overnight reservations are not supported.');const today=DateTime.now().setZone(TZ).startOf('day');if(a< DateTime.now().setZone(TZ)||a>today.plus({months:18}).endOf('day'))throw Error('Requests must be in the future and within 18 months.');return {a,b};};
const partition=(resource,date)=>`${resources.indexOf(resource)}_${date}`;
const slots=(a,b)=>{let out=[];for(let t=a;t<b;t=t.plus({minutes:30}))out.push(t.toFormat('HHmm'));return out};
const mail=async(to,subject,html)=>{if(!process.env.ACS_CONNECTION_STRING||!process.env.MAIL_FROM||!to?.length){console.warn('Email not configured',subject);return}const client=new EmailClient(process.env.ACS_CONNECTION_STRING);const poller=await client.beginSend({senderAddress:process.env.MAIL_FROM,recipients:{to:to.map(address=>({address}))},content:{subject,html}});await poller.pollUntilDone();};
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const readReservations=async()=>{const items=[];for await(const r of table().listEntities())items.push(r);return items};
const release=async r=>{const st=slotTable();for(const k of JSON.parse(r.slotKeys||'[]')){try{const slot=await st.getEntity(r.partitionKey,k);if(slot.reservationId!==r.rowKey)continue;await st.deleteEntity(r.partitionKey,k,{etag:slot.etag});}catch(e){if(![404,412].includes(e.statusCode))throw e;}}};
const expire=async r=>{if(r.status!=='pending'||DateTime.fromISO(r.expiresAt).toMillis()>=Date.now())return false;try{await table().updateEntity({...r,status:'expired'},'Replace',{etag:r.etag});}catch(e){if(e.statusCode===412)return false;throw e;}await release(r);return true};
const cleanup=async r=>{if(['expired','declined','revoked'].includes(r.status))await release(r)};
// A series is stored as dated occurrences. Each occurrence uses the existing
// resource/date partition and slot ownership protection.
const WEEKDAYS=['sun','mon','tue','wed','thu','fri','sat'];
const occurrencePlan=b=>{
  if(!resources.includes(b.resource))throw Error('Invalid resource');
  const first=DateTime.fromISO(b.rangeStart,{zone:TZ});
  const last=DateTime.fromISO(b.rangeEnd,{zone:TZ});
  if(!first.isValid||!last.isValid||first.toISODate()!==b.rangeStart||last.toISODate()!==b.rangeEnd||last<first||last>first.plus({years:1}))throw Error('Choose a date range of at most one calendar year.');
  if(!Array.isArray(b.days)||!b.days.length||b.days.length>7)throw Error('Choose at least one weekday.');
  const rules=new Map();
  for(const rule of b.days){
    if(!WEEKDAYS.includes(rule.day)||rules.has(rule.day))throw Error('Invalid or duplicate weekday');
    if(!/^\d{2}:\d{2}$/.test(rule.start)||!/^\d{2}:\d{2}$/.test(rule.end))throw Error('Invalid time format');
    rules.set(rule.day,{start:rule.start,end:rule.end});
  }
  const out=[];
  for(let d=first;d<=last;d=d.plus({days:1})){
    const rule=rules.get(WEEKDAYS[d.weekday%7]);
    if(!rule)continue;
    const date=d.toISODate();
    const {a,b:finish}=dateRange(date,rule.start,rule.end);
    out.push({date,start:rule.start,end:rule.end,partitionKey:partition(b.resource,date),keys:slots(a,finish)});
  }
  if(!out.length)throw Error('No matching weekdays in the date range');
  if(out.length>366)throw Error('Too many occurrences');
  return out;
};
const conflictDetails=async (plan)=>{
  const conflicts=[];
  const existing=await readReservations();
  const partitions=new Map();
  for(const r of existing){if(!partitions.has(r.partitionKey))partitions.set(r.partitionKey,[]);partitions.get(r.partitionKey).push(r);}
  for(const item of plan){
    for(const r of partitions.get(item.partitionKey)||[]){await expire(r);await cleanup(r);}
    for(const key of item.keys){
      try{await slotTable().getEntity(item.partitionKey,key);conflicts.push({date:item.date,start:item.start,end:item.end});break;}
      catch(e){if(e.statusCode!==404)throw e;}
    }
  }
  return conflicts;
};
app.http('seriesAvailability',{methods:['POST'],authLevel:'anonymous',route:'series/availability',handler:async(req)=>{
  try{await init();const b=await parse(req);const plan=occurrencePlan(b);const conflicts=await conflictDetails(plan);return response(200,{available:conflicts.length===0,count:plan.length,conflicts});}
  catch(e){return response(400,{error:e.message||'Unable to check series'});}
}});
app.http('seriesRequests',{methods:['POST'],authLevel:'anonymous',route:'series/requests',handler:async(req)=>{
  const inserted=[];
  try{
    await init();const b=await parse(req);
    const name=sanitize(b.name),email=sanitize(b.email),phone=sanitize(b.phone),organization=sanitize(b.organization),description=sanitize(b.description);
    if(!name||!organization||!description||!/^\S+@\S+\.\S+$/.test(email)||!/^[\d+(). -]{7,25}$/.test(phone))return response(400,{error:'Complete all required fields'});
    if(b.website)return response(200,{message:'Request received'});
    await ensureVerified(b);
    const plan=occurrencePlan(b);
    if(plan.length>52)throw Error('Public recurring requests are limited to 52 occurrences. Contact an approver for longer series.');
    const conflicts=await conflictDetails(plan);
    if(conflicts.length)return response(409,{error:'Some recurring dates are unavailable.',conflicts});
    const seriesId=randomUUID(),now=DateTime.now().setZone(TZ),expiresAt=now.plus({hours:48}).toISO();
    // Each dated slot batch is atomic. If a later date conflicts, earlier dates are rolled back.
    for(const item of plan){
      const id=randomUUID();
      const r={partitionKey:item.partitionKey,rowKey:id,seriesId,seriesCount:plan.length,rangeStart:b.rangeStart,rangeEnd:b.rangeEnd,name,email,phone,organization,description,resource:b.resource,date:item.date,start:item.start,end:item.end,status:'pending',createdAt:now.toISO(),expiresAt,slotKeys:JSON.stringify(item.keys)};
      await slotTable().submitTransaction(item.keys.map(k=>['create',{partitionKey:item.partitionKey,rowKey:k,reservationId:id}]));
      inserted.push(r);
      await table().createEntity(r);
    }
    const schedule=b.days.map(x=>`${x.day}: ${x.start}–${x.end}`).join('; ');
    const approvers=(process.env.APPROVER_EMAILS||'').split(',').map(x=>x.trim()).filter(Boolean);
    await mail(approvers,'NPHC recurring facility request awaiting approval',`<p>New recurring request from ${escape(name)} (${escape(organization)}).</p><p>${escape(b.resource)}: ${escape(b.rangeStart)} through ${escape(b.rangeEnd)} (${plan.length} occurrences)</p><p>${escape(schedule)}</p><p>${escape(description)}</p><p><a href="${escape(process.env.PUBLIC_BASE_URL||'')}/?admin=1">Review approval dashboard</a></p>`).catch(console.error);
    await mail([email],'NPHC recurring reservation request received',`<p>Thank you ${escape(name)}. Your ${plan.length}-date recurring request for ${escape(b.resource)} is pending approval for up to 48 hours.</p><p>Reference: ${seriesId}</p>`).catch(console.error);
    return response(201,{seriesId,count:plan.length,status:'pending',message:`${plan.length} recurring dates held pending approval for up to 48 hours.`});
  }catch(e){
    // Roll back only slots owned by this request, never another reservation's slots.
    for(const r of inserted.reverse()){
      try{const stored=await table().getEntity(r.partitionKey,r.rowKey);if(stored.status==='pending')await table().deleteEntity(r.partitionKey,r.rowKey,{etag:stored.etag});}catch(err){if(err.statusCode!==404)console.error('Rollback reservation',err);}
      try{await release(r);}catch(err){console.error('Rollback slots',err);}
    }
    if(e.statusCode===409)return response(409,{error:'One or more recurring dates were just booked. Please check availability again.'});
    console.error(e);return response(400,{error:e.message||'Unable to create recurring reservation'});
  }
}});
app.http('seriesDecision',{methods:['POST'],authLevel:'anonymous',route:'series/decision',handler:async(req)=>{
  if(!approver(req))return response(403,{error:'Approver access required'});
  try{
    await init();const b=await parse(req);
    if(!b||!b.seriesId||!['approved','declined','revoked'].includes(b.decision))return response(400,{error:'Invalid series decision'});
    const all=(await readReservations()).filter(r=>r.seriesId===b.seriesId);
    if(!all.length)return response(404,{error:'Series not found'});
    const expected=b.decision==='revoked'?'approved':'pending';
    for(const r of all){if(await expire(r))return response(409,{error:'One or more occurrences expired'});}
    if(all.some(r=>![expected,...(b.decision==='revoked'?['revoked']:[])].includes(r.status)))return response(409,{error:`Series has incompatible statuses. Use individual occurrence decisions instead.`});
    const targets=all.filter(r=>r.status===expected);
    if(!targets.length)return response(409,{error:'No eligible occurrences remain in this series'});
    const comments=String(b.comments||'').trim().slice(0,1000),now=DateTime.now().setZone(TZ).toISO(),actor=identity(req).userDetails||'Approver';
    // Update with ETags to reject concurrent changes. Partial progress is reported, never hidden.
    let updated=0;
    for(const r of targets){
      try{await table().updateEntity({...r,status:b.decision,decidedAt:now,decidedBy:actor,decisionComments:comments},'Replace',{etag:r.etag});updated++;if(b.decision!=='approved')await release(r);}
      catch(e){return response(409,{error:`Updated ${updated} of ${targets.length} eligible occurrences; another change interrupted the series. Review History and finish remaining dates individually.`,updated,total:all.length});}
    }
    const note=comments?`<p><strong>Comments:</strong> ${escape(comments)}</p>`:'';
    await mail([all[0].email],`NPHC recurring reservation ${b.decision}`,`<p>Your recurring reservation for ${escape(all[0].resource)} (${all.length} dates) has been <strong>${escape(b.decision)}</strong>.</p>${note}`).catch(console.error);
    return response(200,{status:b.decision,count:updated});
  }catch(e){console.error(e);return response(500,{error:'Unable to process recurring decision'});}
}});
app.http('resources',{methods:['GET'],authLevel:'anonymous',route:'resources',handler:async()=>response(200,{resources})});
app.http('calendar',{methods:['GET'],authLevel:'anonymous',route:'calendar',handler:async(req)=>{try{await init();const all=await readReservations();const events=[];for(const r of all){if(await expire(r))continue;if(r.status==='approved')events.push(approver(req)?{id:r.rowKey,resource:r.resource,date:r.date,start:r.start,end:r.end,title:r.description||'Reserved',organization:r.organization,name:r.name,email:r.email,phone:r.phone}:{id:r.rowKey,resource:r.resource,date:r.date,start:r.start,end:r.end,title:'Blocked'})}return response(200,{events})}catch(e){return response(500,{error:'Unable to load calendar'})}}});
app.http('availability',{methods:['GET'],authLevel:'anonymous',route:'availability',handler:async(req)=>{try{await init();const resource=req.query.get('resource'),date=req.query.get('date'),start=req.query.get('start'),end=req.query.get('end');if(!resources.includes(resource))return response(400,{error:'Invalid resource'});const {a,b}=dateRange(date,start,end);const p=partition(resource,date);const wanted=slots(a,b);const all=await readReservations();for(const r of all.filter(x=>x.partitionKey===p)){await expire(r);await cleanup(r);}for(const key of wanted){try{await slotTable().getEntity(p,key);return response(200,{available:false})}catch(e){if(e.statusCode!==404)throw e}}return response(200,{available:true})}catch(e){return response(400,{error:e.message})}}});
app.http('requests',{methods:['POST'],authLevel:'anonymous',route:'requests',handler:async(req)=>{try{await init();const b=await parse(req);if(!b||!resources.includes(b.resource))return response(400,{error:'Invalid resource'});const name=sanitize(b.name),email=sanitize(b.email),phone=sanitize(b.phone),organization=sanitize(b.organization),description=sanitize(b.description);if(!name||!organization||!description||!/^\S+@\S+\.\S+$/.test(email)||!/^[\d+(). -]{7,25}$/.test(phone))return response(400,{error:'Complete all required fields'});if(b.website)return response(200,{message:'Request received'});
    await ensureVerified(b);const {a,b:finish}=dateRange(b.date,b.start,b.end);const id=randomUUID(),p=partition(b.resource,b.date),keys=slots(a,finish),now=DateTime.now().setZone(TZ);const entity={partitionKey:p,rowKey:id,name,email,phone,organization,description,resource:b.resource,date:b.date,start:b.start,end:b.end,status:'pending',createdAt:now.toISO(),expiresAt:now.plus({hours:48}).toISO(),slotKeys:JSON.stringify(keys)};
// Azure Table transactional batch: all slot inserts share a partition, ensuring no overlapping requests succeed.
const all=await readReservations();for(const r of all.filter(x=>x.partitionKey===p)){await expire(r);await cleanup(r);}
const actions=keys.map(k=>['create',{partitionKey:p,rowKey:k,reservationId:id}]);await slotTable().submitTransaction(actions);try{await table().createEntity(entity)}catch(e){await release(entity);throw e}
const approvers=(process.env.APPROVER_EMAILS||'').split(',').map(x=>x.trim()).filter(Boolean);await mail(approvers,'NPHC facility request awaiting approval',`<p>New request from ${escape(name)} (${escape(organization)}).</p><p>${escape(b.resource)} — ${escape(b.date)} ${escape(b.start)}–${escape(b.end)} ET</p><p>${escape(description)}</p><p>Review: <a href="${escape(process.env.PUBLIC_BASE_URL||'')}/?admin=1">Approval dashboard</a></p>`).catch(console.error);await mail([email],'NPHC reservation request received',`<p>Thank you, ${escape(name)}. Your request for ${escape(b.resource)} on ${escape(b.date)} is pending approval. Your reference number is ${id}.</p>`).catch(console.error);return response(201,{id,status:'pending',message:'Request submitted and held pending approval for up to 48 hours.'})}catch(e){if(e.statusCode===409)return response(409,{error:'That time is already held or booked. Please select another time.'});console.error(e);return response(400,{error:e.message||'Unable to submit request'})}}});
app.http('approvals',{methods:['GET'],authLevel:'anonymous',route:'approvals',handler:async(req)=>{if(!approver(req))return response(403,{error:'Approver access required'});try{await init();const all=await readReservations();for(const r of all){await expire(r);await cleanup(r);}return response(200,{requests:all.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(({slotKeys,...r})=>r)})}catch(e){return response(500,{error:'Unable to load approvals'})}}});
app.http('decision',{methods:['POST'],authLevel:'anonymous',route:'approvals/decision',handler:async(req)=>{
 if(!approver(req))return response(403,{error:'Approver access required'});
 try{await init();const b=await parse(req);if(!b||!['approved','declined','revoked'].includes(b.decision))return response(400,{error:'Invalid decision'});
 const r=await table().getEntity(b.partitionKey,b.id);if(await expire(r))return response(409,{error:'Request has expired'});
 const expected=b.decision==='revoked'?'approved':'pending';if(r.status!==expected)return response(409,{error:`Only ${expected} reservations can be ${b.decision}`});
 const comments=String(b.comments||'').trim().slice(0,1000),now=DateTime.now().setZone(TZ).toISO();
 const updated={...r,status:b.decision,decidedAt:now,decidedBy:identity(req).userDetails||'Approver',decisionComments:comments};
 if(b.decision==='revoked'){updated.revokedAt=now;updated.revokedBy=updated.decidedBy;}
 await table().updateEntity(updated,'Replace',{etag:r.etag});
 if(b.decision!=='approved')await release(r);
 const note=comments?`<p><strong>Comments:</strong> ${escape(comments)}</p>`:'';
 await mail([r.email],`NPHC reservation ${b.decision}`,`<p>Hello ${escape(r.name)}, your ${r.seriesId?'recurring occurrence':'reservation request'} for ${escape(r.resource)} on ${escape(r.date)} from ${escape(r.start)} to ${escape(r.end)} ET has been <strong>${escape(b.decision)}</strong>.</p>${note}`).catch(console.error);
 return response(200,{status:b.decision});
 }catch(e){console.error(e);return response(e.statusCode===412?409:500,{error:e.statusCode===412?'Another approver already acted on this request.':'Unable to process decision'});}
}});
