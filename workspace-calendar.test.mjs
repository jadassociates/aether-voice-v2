import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CALENDAR_WORKSPACE,validatedCalendarGrant,createWorkspaceCalendar,hasCalendarConsent} from './workspace-calendar.mjs';
import {createCallReporter} from './call-reporter.mjs';
const now=Date.parse('2026-11-15T01:00:00Z');
const grant=()=>({workspace_id:CALENDAR_WORKSPACE,user_id:'6aefd4d2bdce158c19479e31',request_id:'call-test-01',calendar_id:'owner@example.com',account_email:'owner@example.com',access_token:'test-only-token',expires_at:new Date(now+660000).toISOString()});
const record=()=>({id:'call-test-01',workspaceId:CALENDAR_WORKSPACE,tracking:true,status:'connected',businessName:'AETHER',calendarConnection:grant(),calendarDialogue:[{role:'assistant',text:'Tengo jay arroba example punto com, ¿es correcto?'},{role:'user',text:'Sí, correcto.'}]});
const args=()=>({start:'2026-11-16T11:00:00-04:00',end:'2026-11-16T11:30:00-04:00',caller_name:'Jay Amaro',caller_phone:'7875550123',attendee_email:'jay@example.com',caller_confirmed:true,email_confirmed:true});
const response=(status,data)=>({status,ok:status>=200&&status<300,json:async()=>data});
function fixture(mode='ok'){
 let writes=0,stored=null;const calls=[];const r=record();
 const request=async(url,opts)=>{
  calls.push({url,opts});assert.equal(opts.headers.Authorization,'Bearer test-only-token');
  if(url.endsWith('/freeBusy')){if(mode==='hangup')r.status='ended';return response(200,{calendars:{'owner@example.com':mode==='error'?{errors:[{reason:'notFound'}]}:{busy:mode==='busy'?[{}]:[]}}});}
  if(opts.method==='POST'){
   writes++;const body=JSON.parse(opts.body);stored={...body,htmlLink:'https://www.google.com/calendar/event?eid=test'};
   if(mode==='timeout')throw Error('timeout');
   if(mode==='ambiguous'){stored=null;throw Error('timeout');}
   return response(200,stored);
  }
  return stored?response(200,stored):response(404,{});
 };
 return {r,calls,api:createWorkspaceCalendar({request,now:()=>now}),writes:()=>writes};
}
test('grant is scoped to tenant, user, call and short expiry',()=>{
 const g=grant();assert(validatedCalendarGrant(g,CALENDAR_WORKSPACE,g.request_id,now));
 for(const changed of [{workspace_id:'other'},{request_id:'other'},{user_id:''},{expires_at:new Date(now).toISOString()},{expires_at:new Date(now+3600000).toISOString()}])assert.equal(validatedCalendarGrant({...g,...changed},CALENDAR_WORKSPACE,g.request_id,now),null);
 assert.equal(validatedCalendarGrant(g,'other',g.request_id,now),null);
});
test('email must be read aloud then explicitly affirmed; a correction invalidates consent',()=>{
 const r=record();assert(hasCalendarConsent(r,'jay@example.com'));assert(!hasCalendarConsent(r,'wrong@example.com'));
 r.calendarDialogue.push({role:'user',text:'No, cambia el correo.'});assert(!hasCalendarConsent(r,'jay@example.com'));
 r.calendarDialogue.push({role:'user',text:'Sí'});assert(!hasCalendarConsent(r,'jay@example.com'));
});
test('books scoped calendar once, with receipt and verified availability',async()=>{
 const f=fixture();const [a,b]=await Promise.all([f.api.execute(f.r,'book_calendar_appointment',args()),f.api.execute(f.r,'book_calendar_appointment',args())]);
 assert.equal(a.booked,true);assert.deepEqual(a,b);assert.equal(f.writes(),1);assert.match(a.event_id,/^aether[0-9a-f]{40}$/);
 const write=f.calls.find(x=>x.opts.method==='POST'&&!x.url.endsWith('freeBusy'));
 assert(write.url.includes(encodeURIComponent('owner@example.com')));assert.deepEqual(JSON.parse(write.opts.body).attendees,[{email:'jay@example.com'}]);
 assert.equal((await f.api.execute(f.r,'book_calendar_appointment',{...args(),end:'2026-11-16T12:00:00-04:00'})).code,'CALL_ALREADY_HAS_BOOKING_ATTEMPT');
});
test('missing consent, invalid time, expired or terminal call never writes',async()=>{
 for(const type of ['consent','time','expired','ended']){
  const f=fixture(),a=args();if(type==='consent')a.email_confirmed=false;if(type==='time')a.start='tomorrow';if(type==='expired')f.r.calendarConnection.expires_at=new Date(now-1).toISOString();if(type==='ended')f.r.status='ended';
  assert.equal((await f.api.execute(f.r,'book_calendar_appointment',a)).success,false);assert.equal(f.writes(),0);
 }
});
test('busy, incomplete freebusy and hangup during lookup do not write',async()=>{
 for(const mode of ['busy','error','hangup']){const f=fixture(mode),result=await f.api.execute(f.r,'book_calendar_appointment',args());assert.equal(f.writes(),0);assert.equal(result.booked,false);}
});
test('timeout recovers receipt; ambiguous write is never retried',async()=>{
 const f=fixture('timeout');assert.equal((await f.api.execute(f.r,'book_calendar_appointment',args())).booked,true);assert.equal(f.writes(),1);
 const g=fixture('ambiguous');assert.equal((await g.api.execute(g.r,'book_calendar_appointment',args())).status,'unknown');assert.equal((await g.api.execute(g.r,'book_calendar_appointment',args())).status,'unknown');assert.equal(g.writes(),1);
});
test('reporter never sends temporary calendar credentials or dialogue',async()=>{
 let payload;const report=createCallReporter({key:'test',request:async(url,opts)=>{payload=opts.body;return {ok:true}}});
 await report({...record(),sequence:1,calendarResult:{status:'booked',event_id:'aether123'}});
 assert(!payload.includes('test-only-token'));assert(!payload.includes('calendarDialogue'));assert.equal(JSON.parse(payload).calendar_result.status,'booked');
});
