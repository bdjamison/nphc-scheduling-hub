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
const verificationToken=email=>{const payload=Buffer.from(JSON.stringify({email,exp:Date.now()+183*24*60*60*1000,nonce:randomUUID()})).toString('base64url');return payload+'.'+mac(payload)};
const verifyProof=(email,token)=>{if(!securityReady()||typeof token!=='string'||token.length>2000)return false;const parts=token.split('.');if(parts.length!==2||!equal(mac(parts[0]),parts[1]))return false;try{const data=JSON.parse(Buffer.from(parts[0],'base64url').toString());return data.email===email&&Number.isFinite(data.exp)&&data.exp>Date.now()}catch{return false}};
const ensureVerified=async b=>{const email=normalizedEmail(b?.email);if(!verifyProof(email,b?.verificationToken))throw Error('Verify your email address before submitting a reservation.');await securityInit();await limit(securityKey('submitday'+new Date().toISOString().slice(0,10),email),20,86400000);const all=await readReservations();const pending=all.filter(r=>normalizedEmail(r.email)===email&&r.status==='pending'&&DateTime.fromISO(r.expiresAt).toMillis()>Date.now());if(pending.length>=3)throw Error('This email already has 3 active pending reservations. Contact the facility approver for assistance.');if(b.days&&pending.some(r=>r.seriesId))throw Error('This email already has a pending recurring series.');};
app.http('securityConfig',{methods:['GET'],authLevel:'anonymous',route:'security/config',handler:async()=>response(200,{enabled:securityReady()})});
app.http('sendVerification',{methods:['POST'],authLevel:'anonymous',route:'security/send-code',handler:async req=>{try{if(!securityReady())return response(503,{error:'Email verification is not configured.'});const b=await parse(req),email=normalizedEmail(b?.email);if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)return response(400,{error:'Enter a valid email address.'});await securityInit();await limit(securityKey('send',email),3,3600000);const code=String(randomInt(0,1000000)).padStart(6,'0');const key=securityKey('otp',email);await changeSecurity(key,()=>({codeHash:mac(email+':'+code),expiresAtMs:Date.now()+600000,attempts:0,verified:false}));await mail([email],'NPHC reservation email verification',`<p>Your NPHC Community Center verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not request this code, ignore this message.</p>`);return response(200,{message:'If the address can receive email, a verification code has been sent.'})}catch(e){console.error('Verification send failed:',e.message);return response(/Too many|bot|challenge|valid email/i.test(e.message)?429:503,{error:e.message||'Unable to send verification code.'})}}});
app.http('confirmVerification',{methods:['POST'],authLevel:'anonymous',route:'security/confirm-code',handler:async req=>{try{if(!securityReady())return response(503,{error:'Verification unavailable'});const b=await parse(req),email=normalizedEmail(b?.email),code=String(b?.code||'');if(!/^\d{6}$/.test(code)||!/^\S+@\S+\.\S+$/.test(email))return response(400,{error:'Invalid code or email.'});await securityInit();await limit(securityKey('verify',email),10,3600000);const key=securityKey('otp',email),row=await getSecurity(key);if(!row||row.verified||Number(row.expiresAtMs)<Date.now()||Number(row.attempts)>=5)return response(400,{error:'Code expired or too many attempts. Request a new code.'});const ok=equal(row.codeHash,mac(email+':'+code));await changeSecurity(key,old=>({attempts:Number(old?.attempts||0)+1,verified:ok||Boolean(old?.verified)}));if(!ok)return response(400,{error:'Incorrect verification code.'});return response(200,{verificationToken:verificationToken(email),expiresInDays:183})}catch(e){return response(429,{error:e.message||'Unable to verify code'})}}});
const TZ='America/New_York';
const resources=["201 - Howard County Executive, Vanessa Atterbeary, Esq. - Main Meeting Space","202 - James . Martin Hospitality Lounge (Kitchen Area)","202 A - Klohverleaf Dance Academy and Multipurpose Room","250 - Dr. Calvin Ball Legacy Lounge","255 - Delegate Frank Turner Computer Lab","256 - NPHC HC STEM GYM","257 - Roger L. Barnes - Meeting Room","258 - Lt. Col Rufus F. Clancy (O'HanaHC) - Meeting Room","259 - Alice Clark - Meeting Room","260 - Dr. Vernon C. Gray - Meeting Room","261 - Ruth Conway - Meeting Room"];
const table=()=>TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING,'NphcReservations');
const slotTable=()=>TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING,'NphcSlots');
const init=async()=>{await Promise.all([table().createTable().catch(e=>{if(e.statusCode!==409)throw e}),slotTable().createTable().catch(e=>{if(e.statusCode!==409)throw e})]);};
const response=(status,body)=>({status,jsonBody:body,headers:{'Cache-Control':'no-store'}});
const parse=async req=>{try{return await req.json()}catch{return null}};
const identity=req=>{try{return JSON.parse(Buffer.from(req.headers.get('x-ms-client-principal'),'base64').toString())}catch{return null}};
const approver=req=>identity(req)?.userRoles?.includes('approver')===true;
const sanitize=s=>String(s||'').trim().slice(0,500);
const divineNineOrganizations=new Set(["Alpha Kappa Alpha Sorority, Inc.", "Alpha Kappa Alpha Sorority, Inc. — Omega Eta Omega Chapter", "Alpha Kappa Alpha Sorority, Inc. — Iota Lambda Omega Chapter", "Alpha Phi Alpha Fraternity, Inc.", "Delta Sigma Theta Sorority, Inc.", "Iota Phi Theta Fraternity, Inc.", "Kappa Alpha Psi Fraternity, Inc.", "Omega Psi Phi Fraternity, Inc.", "Phi Beta Sigma Fraternity, Inc.", "Sigma Gamma Rho Sorority, Inc.", "Zeta Phi Beta Sorority, Inc."]);
const greekAbbreviations=new Map([
 ['alpha phi alpha','ΑΦΑ'],['alpha kappa alpha','ΑΚΑ'],['delta sigma theta','ΔΣΘ'],
 ['kappa alpha psi','ΚΑΨ'],['omega psi phi','ΩΨΦ'],['phi beta sigma','ΦΒΣ'],
 ['zeta phi beta','ΖΦΒ'],['sigma gamma rho','ΣΓΡ'],['iota phi theta','ΙΦΘ']
]);
const orgAbbreviation=org=>{const n=String(org||'').toLowerCase().replace(/[^a-z ]/g,' ').replace(/\s+/g,' ').trim();if(n.startsWith('alpha kappa alpha')){if(n.includes('omega eta omega'))return 'ΑΚΑ · ΩΗΩ';if(n.includes('iota lambda omega'))return 'ΑΚΑ · ΙΛΩ';}for(const [name,abbr] of greekAbbreviations){if(n===name||n.startsWith(name+' '))return abbr;}return String(org||'').trim().slice(0,48)||'Organization not specified';};
const validOrganization=(choice,organization)=>divineNineOrganizations.has(choice)?organization===choice:choice==='Other'&&organization.length>0&&organization.length<=200;

const dateRange=(date,start,end)=>{const a=DateTime.fromISO(`${date}T${start}`,{zone:TZ});const b=DateTime.fromISO(`${date}T${end}`,{zone:TZ});if(!a.isValid||!b.isValid||a.toISODate()!==date||b.toISODate()!==date||b<=a||b.diff(a,'minutes').minutes>1440||a.minute%30||b.minute%30||a.second||b.second)throw Error('Choose valid same-day start and end times in 30-minute increments. Overnight reservations are not supported.');const today=DateTime.now().setZone(TZ).startOf('day');if(a< DateTime.now().setZone(TZ)||a>today.plus({months:18}).endOf('day'))throw Error('Requests must be in the future and within 18 months.');return {a,b};};
// Preserve stable partition IDs for previously renamed active spaces.
// Retired resources have no active mapping and are archived separately.
const resourcePartitionIds=new Map([
  [resources[0],0], [resources[2],1], [resources[5],2],
  [resources[3],3], [resources[4],8],
  [resources[1],10], [resources[6],11], [resources[7],12],
  [resources[8],13], [resources[9],14], [resources[10],15]
]);
const partition=(resource,date)=>`${resourcePartitionIds.get(resource)}_${date}`;
const unavailableResource=resource=>resource===resources[7];
const requireBookable=resource=>{if(!resources.includes(resource))throw Error('Invalid resource');if(unavailableResource(resource))throw Error('Room 258 is reserved indefinitely by New Tenant and is not available for public booking.');};
const slots=(a,b)=>{let out=[];for(let t=a;t<b;t=t.plus({minutes:30}))out.push(t.toFormat('HHmm'));return out};
const mail=async(to,subject,html)=>{if(!process.env.ACS_CONNECTION_STRING||!process.env.MAIL_FROM||!to?.length){console.warn('Email not configured',subject);return}const client=new EmailClient(process.env.ACS_CONNECTION_STRING);const poller=await client.beginSend({senderAddress:process.env.MAIL_FROM,recipients:{to:to.map(address=>({address}))},content:{subject,html}});await poller.pollUntilDone();};
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const readReservations=async()=>{const items=[];for await(const r of table().listEntities()){if((r.resource==='Dance Studio'||r.resource==='202 A - Khloverleaf Dance Academy and Multipurpose Room')&&r.partitionKey?.startsWith('1_'))r.resource=resources[2];items.push(r);}return items};
const release=async r=>{const st=slotTable();for(const k of JSON.parse(r.slotKeys||'[]')){try{const slot=await st.getEntity(r.partitionKey,k);if(slot.reservationId!==r.rowKey)continue;await st.deleteEntity(r.partitionKey,k,{etag:slot.etag});}catch(e){if(![404,412].includes(e.statusCode))throw e;}}};
const expire=async r=>{if(r.status!=='pending'||DateTime.fromISO(r.expiresAt).toMillis()>=Date.now())return false;try{await table().updateEntity({...r,status:'expired'},'Replace',{etag:r.etag});}catch(e){if(e.statusCode===412)return false;throw e;}await release(r);return true};
const cleanup=async r=>{if(['expired','declined','revoked'].includes(r.status))await release(r)};
// A series is stored as dated occurrences. Each occurrence uses the existing
// resource/date partition and slot ownership protection.
const WEEKDAYS=['sun','mon','tue','wed','thu','fri','sat'];
const occurrencePlan=b=>{
  requireBookable(b.resource);
  const first=DateTime.fromISO(b.rangeStart,{zone:TZ});
  const last=DateTime.fromISO(b.rangeEnd,{zone:TZ});
  if(!first.isValid||!last.isValid||first.toISODate()!==b.rangeStart||last.toISODate()!==b.rangeEnd||last<first||last>first.plus({years:1}))throw Error('Choose a date range of at most one calendar year.');
  const monthly=b.recurrenceType==='monthly';
  let rules=new Map(),monthlyRule=null;
  if(monthly){
    const r=b.monthlyRule||{};
    if(!WEEKDAYS.includes(r.day)||![1,2,3,4,-1].includes(Number(r.ordinal))||!/^\d{2}:\d{2}$/.test(r.start||'')||!/^\d{2}:\d{2}$/.test(r.end||''))throw Error('Choose a valid monthly occurrence, weekday, and time range.');
    monthlyRule={...r,ordinal:Number(r.ordinal)};
  }else{
    if(!Array.isArray(b.days)||!b.days.length||b.days.length>7)throw Error('Choose at least one weekday.');
    for(const rule of b.days){
      if(!WEEKDAYS.includes(rule.day)||rules.has(rule.day))throw Error('Invalid or duplicate weekday');
      if(!/^\d{2}:\d{2}$/.test(rule.start)||!/^\d{2}:\d{2}$/.test(rule.end))throw Error('Invalid time format');
      rules.set(rule.day,{start:rule.start,end:rule.end});
    }
  }
  const out=[];
  for(let d=first;d<=last;d=d.plus({days:1})){
    const day=WEEKDAYS[d.weekday%7];
    let rule=monthly?monthlyRule:rules.get(day);
    if(!rule)continue;
    if(monthly){
      if(day!==monthlyRule.day)continue;
      const occurrence=Math.floor((d.day-1)/7)+1;
      const lastOfMonth=d.plus({days:7}).month!==d.month;
      if(monthlyRule.ordinal===-1?!lastOfMonth:occurrence!==monthlyRule.ordinal)continue;
    }
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
    if(!name||!organization||!validOrganization(sanitize(b.organizationChoice),organization)||!description||!/^\S+@\S+\.\S+$/.test(email)||!/^[\d+(). -]{7,25}$/.test(phone))return response(400,{error:'Complete all required fields'});
    if(b.website)return response(200,{message:'Request received'});
    await ensureVerified(b);
    const fullPlan=occurrencePlan(b);
    if(fullPlan.length>52)throw Error('Public recurring requests are limited to 52 occurrences. Contact an approver for longer series.');
    if(b.excludeDates!==undefined&&(!Array.isArray(b.excludeDates)||b.excludeDates.length>52||b.excludeDates.some(d=>typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d))))throw Error('Invalid skipped dates');
    const skipped=new Set(b.excludeDates||[]);
    if([...skipped].some(d=>!fullPlan.some(item=>item.date===d)))throw Error('Skipped date is outside this recurring series');
    const plan=fullPlan.filter(item=>!skipped.has(item.date));
    if(!plan.length)return response(400,{error:'No available dates remain after exclusions.'});
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
    const schedule=b.recurrenceType==='monthly'?`${b.monthlyRule.ordinal===-1?'Last':['','1st','2nd','3rd','4th'][Number(b.monthlyRule.ordinal)]} ${b.monthlyRule.day} of each month: ${b.monthlyRule.start}–${b.monthlyRule.end}`:b.days.map(x=>`${x.day}: ${x.start}–${x.end}`).join('; ');
    const approvers=(process.env.APPROVER_EMAILS||'').split(',').map(x=>x.trim()).filter(Boolean);
    await mail(approvers,'NPHC recurring facility request awaiting approval',`<p>New recurring request from ${escape(name)} (${escape(organization)}).</p><p>${escape(b.resource)}: ${escape(b.rangeStart)} through ${escape(b.rangeEnd)} (${plan.length} occurrences; ${skipped.size} excluded dates)</p><p>${escape(schedule)}</p><p>${escape(description)}</p><p><a href="${escape(process.env.PUBLIC_BASE_URL||'')}/?admin=1">Review approval dashboard</a></p>`).catch(console.error);
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
app.http('calendar',{methods:['GET'],authLevel:'anonymous',route:'calendar',handler:async(req)=>{try{await init();const all=await readReservations();const events=[];for(const r of all){if(!resources.includes(r.resource))continue;if(await expire(r))continue;if(r.status==='approved'||r.status==='hold')events.push(approver(req)?{id:r.rowKey,resource:r.resource,date:r.date,start:r.start,end:r.end,title:'Blocked',organization:r.organization,status:r.status}:{id:r.rowKey,resource:r.resource,date:r.date,start:r.start,end:r.end,title:'Blocked',orgDisplay:orgAbbreviation(r.organization)})}return response(200,{events})}catch(e){return response(500,{error:'Unable to load calendar'})}}});
app.http('availability',{methods:['GET'],authLevel:'anonymous',route:'availability',handler:async(req)=>{try{await init();const resource=req.query.get('resource'),date=req.query.get('date'),start=req.query.get('start'),end=req.query.get('end');if(!resources.includes(resource))return response(400,{error:'Invalid resource'});if(unavailableResource(resource))return response(200,{available:false,reason:'Room 258 is reserved indefinitely by New Tenant.'});const {a,b}=dateRange(date,start,end);const p=partition(resource,date);const wanted=slots(a,b);const all=await readReservations();for(const r of all.filter(x=>x.partitionKey===p)){await expire(r);await cleanup(r);}for(const key of wanted){try{await slotTable().getEntity(p,key);return response(200,{available:false})}catch(e){if(e.statusCode!==404)throw e}}return response(200,{available:true})}catch(e){return response(400,{error:e.message})}}});
app.http('requests',{methods:['POST'],authLevel:'anonymous',route:'requests',handler:async(req)=>{try{await init();const b=await parse(req);if(!b||!resources.includes(b.resource))return response(400,{error:'Invalid resource'});if(unavailableResource(b.resource))return response(403,{error:'Room 258 is reserved indefinitely by New Tenant.'});const name=sanitize(b.name),email=sanitize(b.email),phone=sanitize(b.phone),organization=sanitize(b.organization),description=sanitize(b.description);if(!name||!organization||!validOrganization(sanitize(b.organizationChoice),organization)||!description||!/^\S+@\S+\.\S+$/.test(email)||!/^[\d+(). -]{7,25}$/.test(phone))return response(400,{error:'Complete all required fields'});if(b.website)return response(200,{message:'Request received'});
    await ensureVerified(b);const {a,b:finish}=dateRange(b.date,b.start,b.end);const id=randomUUID(),p=partition(b.resource,b.date),keys=slots(a,finish),now=DateTime.now().setZone(TZ);const entity={partitionKey:p,rowKey:id,name,email,phone,organization,description,resource:b.resource,date:b.date,start:b.start,end:b.end,status:'pending',createdAt:now.toISO(),expiresAt:now.plus({hours:48}).toISO(),slotKeys:JSON.stringify(keys)};
// Azure Table transactional batch: all slot inserts share a partition, ensuring no overlapping requests succeed.
const all=await readReservations();for(const r of all.filter(x=>x.partitionKey===p)){await expire(r);await cleanup(r);}
const actions=keys.map(k=>['create',{partitionKey:p,rowKey:k,reservationId:id}]);await slotTable().submitTransaction(actions);try{await table().createEntity(entity)}catch(e){await release(entity);throw e}
const approvers=(process.env.APPROVER_EMAILS||'').split(',').map(x=>x.trim()).filter(Boolean);await mail(approvers,'NPHC facility request awaiting approval',`<p>New request from ${escape(name)} (${escape(organization)}).</p><p>${escape(b.resource)} — ${escape(b.date)} ${escape(b.start)}–${escape(b.end)} ET</p><p>${escape(description)}</p><p>Review: <a href="${escape(process.env.PUBLIC_BASE_URL||'')}/?admin=1">Approval dashboard</a></p>`).catch(console.error);await mail([email],'NPHC reservation request received',`<p>Thank you, ${escape(name)}. Your request for ${escape(b.resource)} on ${escape(b.date)} is pending approval. Your reference number is ${id}.</p>`).catch(console.error);return response(201,{id,status:'pending',message:'Request submitted and held pending approval for up to 48 hours.'})}catch(e){if(e.statusCode===409)return response(409,{error:'That time is already held or booked. Please select another time.'});console.error(e);return response(400,{error:e.message||'Unable to submit request'})}}});
app.http('approvals',{methods:['GET'],authLevel:'anonymous',route:'approvals',handler:async(req)=>{if(!approver(req))return response(403,{error:'Approver access required'});try{await init();const all=(await readReservations()).filter(r=>resources.includes(r.resource));for(const r of all){await expire(r);await cleanup(r);}return response(200,{requests:all.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(({slotKeys,...r})=>r)})}catch(e){return response(500,{error:'Unable to load approvals'})}}});
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


// Approver-only editing. Existing occurrences are retained as revision history when moved.
const auditTable=()=>TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING,'NphcReservationAudit');
const editDateRange=(date,start,end)=>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(start)||!/^\d{2}:\d{2}$/.test(end))throw Error('Invalid date or time');
 const a=DateTime.fromISO(`${date}T${start}`,{zone:TZ}),b=DateTime.fromISO(`${date}T${end}`,{zone:TZ});
 if(!a.isValid||!b.isValid||a.toISODate()!==date||b.toISODate()!==date||b<=a||a.second||b.second||a.minute%15||b.minute%15)throw Error('Choose valid same-day times in 15-minute increments');
 return {a,b};
};
const editKeys=(date,start,end)=>{const {a,b}=editDateRange(date,start,end);const keys=[];let t=a.startOf('hour').plus({minutes:a.minute>=30?30:0});while(t<b){keys.push(t.toFormat('HHmm'));t=t.plus({minutes:30});}return keys;};
const editPlan=b=>{
 const first=DateTime.fromISO(b.rangeStart,{zone:TZ}),last=DateTime.fromISO(b.rangeEnd,{zone:TZ});
 if(!first.isValid||!last.isValid||first.toISODate()!==b.rangeStart||last.toISODate()!==b.rangeEnd||last<first||last.diff(first,'days').days>366)throw Error('Invalid recurring range (maximum 1 year)');
 const monthly=b.recurrenceType==='monthly',rules=new Map();
 if(monthly){const r=b.monthlyRule;if(!r||!WEEKDAYS.includes(r.day)||![1,2,3,4,-1].includes(Number(r.ordinal)))throw Error('Invalid monthly rule');}
 else{if(!Array.isArray(b.days)||!b.days.length||b.days.length>7)throw Error('Select weekdays');for(const r of b.days){if(!WEEKDAYS.includes(r.day)||rules.has(r.day))throw Error('Invalid weekday');rules.set(r.day,r);}}
 const result=[];
 for(let d=first;d<=last;d=d.plus({days:1})){
  const day=WEEKDAYS[d.weekday%7];let rule=monthly?b.monthlyRule:rules.get(day);if(!rule)continue;
  if(monthly){if(day!==rule.day)continue;const nth=Math.floor((d.day-1)/7)+1;const isLast=d.plus({days:7}).month!==d.month;if(Number(rule.ordinal)===-1?!isLast:nth!==Number(rule.ordinal))continue;}
  const date=d.toISODate();editDateRange(date,rule.start,rule.end);result.push({date,start:rule.start,end:rule.end});
 }
 if(!result.length||result.length>366)throw Error('Invalid recurring occurrence count');return result;
};
const editFields=(b,r)=>{
 const resource=String(b.resource||''),organization=sanitize(b.organization),description=sanitize(b.description),name=sanitize(b.name),email=normalizedEmail(b.email),phone=sanitize(b.phone);
 if(!resources.includes(resource)||unavailableResource(resource))throw Error('Choose an available room');
 if(!organization||!description||!name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||( !phone && r.migrationSource!=='google-calendar'))throw Error('Complete all requester and reservation fields');
 return {resource,organization,description,name,email,phone};
};
const slotOwner=async(p,key)=>{try{return await slotTable().getEntity(p,key)}catch(e){if(e.statusCode===404)return null;throw e}};
const writeAudit=async(old,updated,actor,scope,operation)=>{try{await auditTable().createTable().catch(e=>{if(e.statusCode!==409)throw e});await auditTable().createEntity({partitionKey:'changes',rowKey:randomUUID(),reservationId:old.rowKey,seriesId:old.seriesId||'',actor,scope,operation,changedAt:DateTime.now().setZone(TZ).toISO(),before:JSON.stringify({date:old.date,start:old.start,end:old.end,resource:old.resource,organization:old.organization,name:old.name,email:old.email,phone:old.phone,description:old.description}),after:JSON.stringify({date:updated.date,start:updated.start,end:updated.end,resource:updated.resource,organization:updated.organization,name:updated.name,email:updated.email,phone:updated.phone,description:updated.description})})}catch(e){console.error('Audit write failed',e)}};
const sendEditEmail=async(old,updated,scope,counts={})=>{
 const lines=['date','start','end','resource','organization','description','name','email','phone'].filter(k=>String(old[k]||'')!==String(updated[k]||'')).map(k=>`<tr><th style="text-align:left;padding:6px">${escape(k)}</th><td style="padding:6px">${escape(old[k]||'—')}</td><td style="padding:6px">${escape(updated[k]||'—')}</td></tr>`).join('');
 const html=`<p>Your NPHC Community Center reservation was updated by an authorized approver.</p><p><b>Applies to:</b> ${escape(scope)}</p><p>Occurrences updated: ${Number(counts.updated||0)}; added: ${Number(counts.added||0)}; removed: ${Number(counts.removed||0)}.</p><table border="1" cellspacing="0" cellpadding="4"><tr><th>Field</th><th>Previous</th><th>Updated</th></tr>${lines||'<tr><td colspan="3">Recurring schedule updated</td></tr>'}</table><p>For questions, contact the community center.</p>`;
 const recipients=[...new Set([normalizedEmail(old.email),normalizedEmail(updated.email)].filter(x=>/^\S+@\S+\.\S+$/.test(x)))];
 if(!process.env.ACS_CONNECTION_STRING||!process.env.MAIL_FROM)throw Error('Email delivery is not configured');
 await mail(recipients,'NPHC reservation updated',html);
};
// Preflight every target before writing anything. Prevent collision with records outside the edit set.
const preflightEdits=async(targets,proposals)=>{
 const owned=new Set(targets.map(r=>r.partitionKey+'|'+r.rowKey));const conflicts=[];
 for(let i=0;i<proposals.length;i++){
  const r=targets[i],v=proposals[i],p=partition(v.resource,v.date),keys=editKeys(v.date,v.start,v.end);
  for(const k of keys){const slot=await slotOwner(p,k);if(slot&&!owned.has(p+'|'+slot.reservationId)){conflicts.push({date:v.date,start:v.start,end:v.end,resource:v.resource});break;}}
 }
 for(let i=0;i<proposals.length;i++)for(let j=i+1;j<proposals.length;j++){
  const a=proposals[i],b=proposals[j];if(a.date===b.date&&a.resource===b.resource&&a.start<b.end&&b.start<a.end)conflicts.push({date:a.date,start:a.start,end:a.end,resource:a.resource});
 }
 return conflicts;
};
const applyEdit=async(old,v,actor,scope)=>{
 const p=partition(v.resource,v.date),keys=editKeys(v.date,v.start,v.end),samePartition=p===old.partitionKey;
 const oldKeys=JSON.parse(old.slotKeys||'[]'),oldKeySet=new Set(oldKeys);
 const newId=samePartition?old.rowKey:randomUUID();
 const created=[];
 try{
  for(const key of keys){if(samePartition&&oldKeySet.has(key))continue;await slotTable().createEntity({partitionKey:p,rowKey:key,reservationId:newId});created.push(key);}
  const next={...old,...v,partitionKey:p,rowKey:newId,slotKeys:JSON.stringify(keys),updatedAt:DateTime.now().setZone(TZ).toISO(),updatedBy:actor};
  if(samePartition){await table().updateEntity(next,'Replace',{etag:old.etag});}
  else{
   await table().createEntity(next);
   try{await table().updateEntity({...old,status:'superseded',supersededBy:newId,supersededAt:next.updatedAt},'Replace',{etag:old.etag})}
   catch(e){await table().deleteEntity(p,newId).catch(console.error);throw e;}
  }
  // Remove only slots still owned by the previous occurrence.
  for(const key of oldKeys){if(samePartition&&keys.includes(key))continue;try{const slot=await slotTable().getEntity(old.partitionKey,key);if(slot.reservationId===old.rowKey)await slotTable().deleteEntity(old.partitionKey,key,{etag:slot.etag})}catch(e){if(e.statusCode!==404)console.error('Old slot release failed',e)}}
  await writeAudit(old,next,actor,scope,samePartition?'update':'move');return next;
 }catch(e){for(const key of created){try{const slot=await slotTable().getEntity(p,key);if(slot.reservationId===newId)await slotTable().deleteEntity(p,key,{etag:slot.etag})}catch(err){console.error('Edit rollback',err)}}throw e;}
};
app.http('editReservation',{methods:['POST'],authLevel:'anonymous',route:'approvals/edit',handler:async req=>{
 if(!approver(req))return response(403,{error:'Approver access required'});
 try{
  await init();const b=await parse(req);if(!b||!['single','future','series'].includes(b.scope))return response(400,{error:'Invalid edit scope'});
  const old=await table().getEntity(b.partitionKey,b.id);if(!['approved','hold'].includes(old.status))return response(409,{error:'Only approved or HOLD reservations may be edited'});
  const fields=editFields(b,old),all=await readReservations();
  let targets=[old];if(b.scope!=='single'){
   if(!old.seriesId)return response(400,{error:'This reservation has no linked recurring series. Edit this occurrence individually.'});
   targets=all.filter(r=>r.seriesId===old.seriesId&&['approved','hold'].includes(r.status)&&(b.scope==='series'||r.date>=old.date)).sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
  }
  const actor=identity(req)?.userDetails||'Approver';
  let matched=[],additions=[],removals=[];
  if(b.scope==='single'){
   editDateRange(b.date,b.start,b.end);
   matched=[{old,proposal:{...fields,date:b.date,start:b.start,end:b.end}}];
  }else{
   const plan=editPlan(b),proposals=plan.map(x=>({...fields,...x}));
   const retained=all.filter(r=>r.seriesId===old.seriesId&&['approved','hold'].includes(r.status)&&!targets.some(t=>t.partitionKey===r.partitionKey&&t.rowKey===r.rowKey));
   if(proposals.some(x=>retained.some(r=>r.date===x.date&&r.resource===x.resource&&r.start<x.end&&x.start<r.end)))return response(409,{error:'Updated schedule overlaps an unchanged occurrence of this series'});
   const byDate=new Map(targets.map(t=>[t.date,t]));
   for(const v of proposals){const existing=byDate.get(v.date);if(existing){matched.push({old:existing,proposal:v});byDate.delete(v.date)}else additions.push(v)}
   removals=[...byDate.values()];
  }
  // Fail closed when newly added dates overlap any occupied slot, including dates being removed.
  // This avoids destructive rearrangements and prevents false availability from a planned removal.
  const testTargets=[...matched.map(x=>x.old),...additions.map(()=>({partitionKey:'__new__',rowKey:'__new__'}))];
  const testProposals=[...matched.map(x=>x.proposal),...additions];
  const conflicts=await preflightEdits(testTargets,testProposals);
  if(conflicts.length)return response(409,{error:'Requested room or time conflicts with existing reservations',conflicts});
  const changes=[],created=[];
  const now=DateTime.now().setZone(TZ).toISO();
  // Add new occurrences first. If an addition fails, remove additions already made.
  // Never remove an existing occurrence until all additions and edits succeed.
  try{
   for(const v of additions){
    const p=partition(v.resource,v.date),keys=editKeys(v.date,v.start,v.end),id=randomUUID(),claimed=[];
    try{
     for(const key of keys){await slotTable().createEntity({partitionKey:p,rowKey:key,reservationId:id});claimed.push(key)}
     const next={...old,...v,partitionKey:p,rowKey:id,slotKeys:JSON.stringify(keys),seriesId:old.seriesId,status:old.status,createdAt:now,updatedAt:now,updatedBy:actor,rangeStart:b.rangeStart,rangeEnd:b.rangeEnd};
     delete next.etag;delete next.timestamp;delete next.supersededBy;delete next.supersededAt;
     await table().createEntity(next);created.push(next);
     await writeAudit(old,next,actor,b.scope,'series-add');
    }catch(e){for(const key of claimed)await slotTable().deleteEntity(p,key).catch(console.error);throw e}
   }
  }catch(e){for(const r of created){await table().deleteEntity(r.partitionKey,r.rowKey).catch(console.error);await release(r).catch(console.error)}return response(409,{error:'No existing reservations were changed. Could not create a new occurrence: '+e.message})}
  for(const {old:r,proposal:v} of matched){
   try{changes.push(await applyEdit(r,{...v,...(b.scope==='single'?{}:{rangeStart:b.rangeStart,rangeEnd:b.rangeEnd})},actor,b.scope))}
   catch(e){return response(409,{error:`${changes.length} existing occurrence(s) were changed and ${created.length} new ones were added, but the edit stopped: ${e.message}. Review the calendar before retrying.`,updated:changes.length,added:created.length})}
  }
  for(const r of removals){
   try{await table().updateEntity({...r,status:'revoked',updatedAt:now,updatedBy:actor,decisionComments:'Removed by approver recurring schedule edit'},'Replace',{etag:r.etag});await release(r);await writeAudit(r,{...r,status:'revoked'},actor,b.scope,'series-remove')}
   catch(e){return response(409,{error:`Schedule partly updated, but could not release an obsolete occurrence (${r.date}): ${e.message}. Review the calendar before retrying.`,updated:changes.length,added:created.length})}
  }
  let emailSent=false,emailError='';
  try{await sendEditEmail(old,changes[0]||created[0]||{...old,...fields},b.scope,{added:additions.length,removed:removals.length,updated:changes.length});emailSent=true}catch(e){emailError=e.message;console.error('Reservation edit notification failed',e)}
  return response(200,{updated:changes.length,added:created.length,removed:removals.length,emailSent,emailError});
 }catch(e){console.error('Edit reservation failed',e);return response([404,409,412].includes(e.statusCode)?409:400,{error:e.message||'Unable to edit reservation'});}
}});
