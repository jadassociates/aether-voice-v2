import crypto from 'node:crypto';
export const CALENDAR_WORKSPACE='6af7af661a790b508ba68668';
export function validatedCalendarGrant(value,workspaceId,requestId,now=Date.now()){
 if(!value||workspaceId!==CALENDAR_WORKSPACE||value.workspace_id!==workspaceId||value.request_id!==requestId||
  !/^[a-f0-9]{24}$/.test(value.user_id||'')||typeof value.access_token!=='string'||!value.access_token||value.access_token.length>10000||
  typeof value.calendar_id!=='string'||!value.calendar_id||value.calendar_id.length>300||!/^\S+@\S+\.\S+$/.test(value.account_email||'')||
  !Number.isFinite(Date.parse(value.expires_at))||Date.parse(value.expires_at)<=now||Date.parse(value.expires_at)>now+12*60000)return null;
 return {...value};
}
const fail=(code)=>{throw Object.assign(new Error(code),{code})};
const terminal=new Set(['ended','failed','busy','no_answer','unknown']);
function interval(args,now){
 const start=String(args.start||''),end=String(args.end||'');
 if(!/(?:Z|[+-]\d{2}:\d{2})$/.test(start)||!/(?:Z|[+-]\d{2}:\d{2})$/.test(end))fail('EXACT_TIME_REQUIRED');
 const a=Date.parse(start),b=Date.parse(end);
 if(!Number.isFinite(a)||!Number.isFinite(b)||a<=now||a>now+90*86400000||b-a<15*60000||b-a>120*60000)fail('INVALID_APPOINTMENT_WINDOW');
 if(args.timezone&&args.timezone!=='America/Puerto_Rico')fail('TIMEZONE_NOT_SUPPORTED');
 return {start:new Date(a).toISOString(),end:new Date(b).toISOString(),timezone:'America/Puerto_Rico'};
}
export function hasCalendarConsent(record,email){
 const turns=record.calendarDialogue||[];
 const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 const last=turns.at(-1);
 const yes=normalize(last?.text).trim();
 if(last?.role!=='user'||!/^(si|correcto|correcta|exacto|confirmo|confirmado|de acuerdo|adelante|yes|correct|that's correct|that is correct)\b/.test(yes)||/\b(no|pero|cambia|corrige|excepto|not|but)\b/.test(yes))return false;
 const compact=value=>normalize(value).replace(/\barroba\b/g,'@').replace(/\bpunto\b/g,'.').replace(/\bguion bajo\b/g,'_').replace(/\bguion\b/g,'-').replace(/\s+/g,'');
 const target=compact(email);
 for(let n=turns.length-2;n>=0;n--){
  const t=turns[n];
  if(t.role==='user'&&/\b(no|cambia|corrige|arroba|punto|email|correo)\b|@/.test(normalize(t.text)))return false;
  if(t.role==='assistant'&&compact(t.text).includes(target))return true;
 }
 return false;
}
export function createWorkspaceCalendar({request=fetch,now=Date.now}={}){
 const bookings=new Map();
 async function execute(record,name,args={}){
  const g=validatedCalendarGrant(record.calendarConnection,record.workspaceId,record.id,now());
  if(!g||!record.tracking||terminal.has(record.status))return {success:false,code:'CALL_CALENDAR_UNAVAILABLE',error:'El calendario no está autorizado para esta llamada. No se ha reservado una cita.'};
  if(!['get_calendar_availability','book_calendar_appointment'].includes(name))return {success:false,code:'TOOL_NOT_ALLOWED'};
  const http=async(path,opts={})=>{
   try{return await request('https://www.googleapis.com/calendar/v3'+path,{...opts,headers:{Authorization:'Bearer '+g.access_token,'content-type':'application/json'},signal:AbortSignal.timeout(10000)})}
   catch{fail('CALENDAR_REQUEST_UNCONFIRMED')}
  };
  const base='/calendars/'+encodeURIComponent(g.calendar_id)+'/events';
  const eventId='aether'+crypto.createHash('sha256').update(record.workspaceId+':'+record.id).digest('hex').slice(0,40);
  const ownEvent=async()=>{
   const r=await http(base+'/'+eventId);
   if(r.status===404)return null;
   if(!r.ok)fail('CALENDAR_RECEIPT_UNCONFIRMED');
   const e=await r.json();
   if(e.status==='cancelled'||e.extendedProperties?.private?.aether_call!==record.id||e.extendedProperties?.private?.aether_workspace!==record.workspaceId)fail('CALENDAR_RECEIPT_SCOPE_MISMATCH');
   return e;
  };
  const receipt=e=>({success:true,booked:true,status:'booked',event_id:e.id,event_url:/^https:\/\/(?:www\.)?google\.com\/calendar\//.test(e.htmlLink||'')?e.htmlLink:'',start:e.start?.dateTime,end:e.end?.dateTime,timezone:'America/Puerto_Rico',calendar:g.account_email});
  const available=async(slot)=>{
   const r=await http('/freeBusy',{method:'POST',body:JSON.stringify({timeMin:slot.start,timeMax:slot.end,timeZone:slot.timezone,items:[{id:g.calendar_id}]})});
   if(!r.ok)fail('CALENDAR_AVAILABILITY_FAILED');
   const data=await r.json(),entry=data.calendars?.[g.calendar_id];
   if(!entry||entry.errors?.length||!Array.isArray(entry.busy))fail('CALENDAR_AVAILABILITY_UNCONFIRMED');
   return entry.busy.length===0;
  };
  try{
   const slot=interval(args,now());
   if(name==='get_calendar_availability')return {success:true,available:await available(slot),...slot};
   if(args.caller_confirmed!==true||args.email_confirmed!==true)fail('CALLER_CONFIRMATION_REQUIRED');
   const caller=String(args.caller_name||'').trim(),email=String(args.attendee_email||'').trim(),phone=String(args.caller_phone||'').replace(/[^0-9]/g,'');
   if(!caller||caller.length>150||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||!(phone.length===10||phone.length===11&&phone[0]==='1'))fail('CONFIRMED_CONTACT_REQUIRED');
   if(!hasCalendarConsent(record,email))fail('AUDIBLE_EMAIL_CONFIRMATION_REQUIRED');
   const fingerprint=JSON.stringify([slot.start,slot.end,email.toLowerCase(),caller,phone]);
   const existing=bookings.get(record.id);
   if(existing){if(existing.fingerprint!==fingerprint)fail('CALL_ALREADY_HAS_BOOKING_ATTEMPT');return await existing.promise;}
   const task=(async()=>{
    // Deterministic Google event ID recovers ambiguous writes and prevents duplicates.
    const prior=await ownEvent();if(prior)return receipt(prior);
    if(!await available(slot))return {success:true,booked:false,status:'busy',available:false,...slot};
    if(terminal.has(record.status)||!record.calendarConnection)fail('CALL_CALENDAR_UNAVAILABLE');
    if(Date.parse(g.expires_at)<=now())fail('CALL_CALENDAR_UNAVAILABLE');
    let response;
    try{response=await http(base+'?sendUpdates=all',{method:'POST',body:JSON.stringify({id:eventId,summary:String(args.appt_title||'Cita con '+record.businessName).slice(0,200),description:'Cita coordinada por Valentina. Contacto: '+caller+'. Teléfono: '+phone+'.',start:{dateTime:slot.start,timeZone:slot.timezone},end:{dateTime:slot.end,timeZone:slot.timezone},attendees:[{email}],extendedProperties:{private:{aether_call:record.id,aether_workspace:record.workspaceId}}})});}
    catch{const recovered=await ownEvent().catch(()=>null);return recovered?receipt(recovered):{success:false,booked:false,status:'unknown',code:'CALENDAR_WRITE_UNCONFIRMED',error:'No se pudo confirmar la reserva. No repita la gestión hasta revisar el calendario.'};}
    if(response.status===409){const recovered=await ownEvent();if(recovered)return receipt(recovered);fail('CALENDAR_WRITE_UNCONFIRMED');}
    if(!response.ok){if(response.status>=500){const recovered=await ownEvent().catch(()=>null);if(recovered)return receipt(recovered);return {success:false,booked:false,status:'unknown',code:'CALENDAR_WRITE_UNCONFIRMED'};}fail('CALENDAR_BOOKING_REJECTED');}
    try{
     const created=await response.json();
     if(created.id!==eventId||created.status==='cancelled'||!Number.isFinite(Date.parse(created.start?.dateTime))||!Number.isFinite(Date.parse(created.end?.dateTime)))throw Error('receipt');
     return receipt(created);
    }catch{const recovered=await ownEvent().catch(()=>null);return recovered?receipt(recovered):{success:false,booked:false,status:'unknown',code:'CALENDAR_WRITE_UNCONFIRMED'};}
   })();
   bookings.set(record.id,{fingerprint,promise:task});
   const result=await task;
   // Busy is a verified non-write: the caller may choose another time.
   if(result.status==='busy')bookings.delete(record.id);
   return result;
  }catch(error){return {success:false,booked:false,status:'failed',code:error.code||'CALENDAR_TOOL_FAILED',error:'No se pudo completar la gestión de calendario. No confirme una cita sin comprobante.'};}
 }
 return {execute,forget:id=>bookings.delete(id)};
}
