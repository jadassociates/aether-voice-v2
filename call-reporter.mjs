export function createCallReporter({ key, request = fetch, log = () => {}, pause = ms => new Promise(r => setTimeout(r,ms)) }) {
  const queues = new Map();
  const url = "https://app.base44.com/api/apps/6a8c8d74eac265b80c1c368c/functions/voiceCallEvents";
  return record => {
    if (!record.tracking) return;
    const at = record.endedAt || new Date().toISOString();
    const payload = {
      request_id:record.id, sequence:record.sequence, status:record.status,
      from:record.from,to:record.to,at,call_control_id:record.pstnId || "",
      answered_at:record.answeredAt || "",
      duration_seconds:record.answeredAt ? Math.max(0,Math.floor((Date.parse(at)-Date.parse(record.answeredAt))/1000)) : 0,
      caller_turns:(record.callerTurns || []).slice(-3).map(x=>String(x).slice(0,400)),
      responder_type:record.responderType === "machine" ? "machine" : "unknown"
    };
    const task = (queues.get(record.id) || Promise.resolve()).catch(()=>{}).then(async()=>{
      for(let n=0;n<3;n++){
        try{
          const result=await request(url,{method:"POST",headers:{"content-type":"application/json","x-aether-tool-key":key},body:JSON.stringify(payload),signal:AbortSignal.timeout(6000)});
          if(result.ok)return;
          if([400,401,403,404].includes(result.status))break;
        }catch{}
        if(n<2)await pause(n?1000:250);
      }
      log("warn","outbound_tracking_delivery_failed",{request_id:record.id,sequence:record.sequence});
    });
    queues.set(record.id,task);
    task.finally(()=>{if(queues.get(record.id)===task)queues.delete(record.id)});
    return task;
  };
}
