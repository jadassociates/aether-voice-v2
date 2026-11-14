import {test} from 'node:test';import assert from 'node:assert/strict';
import {createCallReporter} from './call-reporter.mjs';
const record={id:'mind-test',tracking:true,sequence:1,status:'dialing',from:'+17874224202',to:'+17875550123',callerTurns:[]};
test('untracked legacy and owner-test calls do not invoke workspace callbacks',async()=>{
 let n=0;const report=createCallReporter({key:'test',request:async()=>{n++;return {ok:true}},pause:async()=>{}});
 await report({...record,tracking:false});assert.equal(n,0);
});
test('callback serialization snapshots each state and retries delivery without redialing',async()=>{
 const events=[];let failed=false;
 const report=createCallReporter({key:'test',request:async(url,opts)=>{const body=JSON.parse(opts.body);events.push(body);assert.equal(opts.headers['x-aether-tool-key'],'test');if(!failed){failed=true;throw Error('temporary network failure')}return {ok:true}},pause:async()=>{}});
 const a=report({...record});const b=report({...record,status:'ended',sequence:2,callerTurns:['Quiero hablar mañana.']});await Promise.all([a,b]);
 assert.deepEqual(events.map(x=>x.sequence),[1,1,2]);assert.equal(events.at(-1).caller_turns[0],'Quiero hablar mañana.');
 assert.equal(events.at(-1).responder_type,'unknown');assert(!('message_left' in events.at(-1)));
});
test('authorization failures stop retries and leave a diagnostic',async()=>{
 let count=0;const logs=[];
 const report=createCallReporter({key:'test',request:async()=>{count++;return {ok:false,status:401}},log:(...args)=>logs.push(args),pause:async()=>{}});
 await report({...record});assert.equal(count,1);assert.equal(logs[0][1],'outbound_tracking_delivery_failed');
});
