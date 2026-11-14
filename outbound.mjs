import crypto from 'node:crypto';

export function verifyTelnyxWebhook(raw, headers, publicKey, now = Date.now()) {
  try {
    const timestamp = String(headers['telnyx-timestamp'] || '');
    if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
    const bytes = Buffer.from(publicKey, 'base64');
    if (bytes.length !== 32) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), bytes
    ]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(`${timestamp}|${raw}`), key,
      Buffer.from(String(headers['telnyx-signature-ed25519'] || ''), 'base64'));
  } catch { return false; }
}

export const WORKSPACE_CALL_PROFILES = {
  "6af7af661a790b508ba68668": { from: "+17874224202", businessName: "AETHER Technologies" },
  "6af10aa99b47afc47c29c90f": { from: "+17874224204", businessName: "ASEGURARTE PR" }
};

export function createOutbound({ env = process.env, request = fetch, log = () => {}, onReady = () => {}, onEnd = () => {}, onChange = () => {} } = {}) {
  const records = new Map();
  const byToken = new Map();
  const seen = new Set();
  const config = {
    apiKey: env.TELNYX_API_KEY || '', publicKey: env.TELNYX_PUBLIC_KEY || '',
    connection: env.TELNYX_OUTBOUND_CONNECTION_ID || '',
    from: env.AETHER_OUTBOUND_FROM || '+17874224202',
    sip: env.AETHER_OPENAI_SIP_URI || '',
    webhook: env.AETHER_TELNYX_WEBHOOK_URL || '',
    enabled: env.AETHER_OUTBOUND_ENABLED === 'true',
    secret: env.SIDECAR_SHARED_SECRET || '',
  };
  function readiness() {
    const required = { TELNYX_API_KEY: config.apiKey, TELNYX_PUBLIC_KEY: config.publicKey,
      TELNYX_OUTBOUND_CONNECTION_ID: config.connection, AETHER_OPENAI_SIP_URI: config.sip,
      AETHER_TELNYX_WEBHOOK_URL: config.webhook, SIDECAR_SHARED_SECRET: config.secret };
    const missing = Object.keys(required).filter(k => !required[k]);
    return { ready: config.enabled && !missing.length, enabled: config.enabled, missing_config: missing };
  }
  async function api(path, body) {
    const response = await request(`https://api.telnyx.com/v2${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Telnyx request rejected (${response.status})`);
    return (await response.json()).data || {};
  }
  function clientState(record, leg) {
    return Buffer.from(JSON.stringify({ request_id: record.id, leg })).toString('base64');
  }
  function command(record, action) {
    return crypto.createHash('sha256').update(`${record.id}:${action}`).digest('hex');
  }
  async function hangup(record, id) {
    if (!id) return;
    try { await api(`/calls/${encodeURIComponent(id)}/actions/hangup`, { command_id: command(record, `hangup:${id}`) }); }
    catch { log('warn', 'outbound_hangup_failed', { request_id: record.id }); }
  }
  function changed(record) { record.sequence = (record.sequence || 0) + 1; try { onChange(record); } catch { log('warn','outbound_tracking_failed',{request_id:record.id}); } }
  function summary(record) {
    return { request_id: record.id, status: record.status, call_control_id: record.pstnId || null };
  }
  async function start(body) {
    if (!readiness().ready) return { code: 503, body: { error: 'Outbound is not configured', ...readiness() } };
    const id = String(body.request_id || '');
    const workspaceId = body.workspace_tracking === true ? String(body.client_account_id || "6af7af661a790b508ba68668") : "";
    const profile = WORKSPACE_CALL_PROFILES[workspaceId];
    const from = body.workspace_tracking === true ? profile?.from : config.from;
    if (!from || (body.from && body.from !== from)) return { code: 403, body: { error: "Source line does not match workspace" } };
    const to = String(body.to || '');
    const reason = String(body.call_reason || '').trim();
    const name = String(body.contact_name || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id) || !/^\+1\d{10}$/.test(to) || to === from ||
        !reason || reason.length > 1000 || name.length > 150 || body.owner_approved !== true) {
      return { code: 400, body: { error: 'Provide request_id, +1 destination, real call_reason and owner_approved=true' } };
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ to, reason, name, from, workspaceId })).digest('hex');
    const existing = records.get(id);
    if (existing) return { code: existing.fingerprint === fingerprint ? 200 : 409,
      body: existing.fingerprint === fingerprint ? summary(existing) : { error: 'request_id already used with different details' } };
    if ([...records.values()].some(r => !['ended', 'failed'].includes(r.status))) {
      return { code: 409, body: { error: 'A controlled outbound call is already active' } };
    }
    if (records.size >= 1000) return { code: 503, body: { error: 'Outbound request ledger is full; operator review required' } };
    const token = crypto.createHmac('sha256', config.secret).update(`outbound:${id}`).digest('hex');
    const record = { id, fingerprint, token, name, reason, status: 'dialing', mediaReady: false, direction: 'outbound', to, from, workspaceId, businessName: profile?.businessName || '', tracking: body.workspace_tracking === true, callerTurns: [], sequence: 0 };
    records.set(id, record); byToken.set(token, record);
    try {
      const call = await api('/calls', { connection_id: config.connection, from, to,
        from_display_name: record.tracking ? record.businessName : /\b(aether|ae7h3r|ether technologies|aether technologies)\b/i.test(reason) ? 'AETHER Technologies' : 'JAD Associates', command_id: command(record, 'pstn'),
        client_state: clientState(record, 'pstn'), webhook_url: config.webhook, webhook_url_method: 'POST',
        timeout_secs: 30, time_limit_secs: 600, retry_on_timeout: false });
      record.pstnId ||= call.call_control_id;
      changed(record);
      log('info', 'outbound_started', { request_id: id });
      return { code: 202, body: summary(record) };
    } catch {
      // An ambiguous network error is not permission to place another call.
      record.status = 'unknown'; changed(record);
      return { code: 502, body: { ...summary(record), error: 'Call setup result unknown; do not retry with a new request_id' } };
    }
  }
  function resolveContext(headers) {
    const tokens = (headers || []).filter(h => String(h.name).toLowerCase() === 'x-aether-outbound-token');
    if (!tokens.length) return null;
    const record = tokens.length === 1 ? byToken.get(String(tokens[0].value)) : null;
    if (!record || ['ended', 'failed'].includes(record.status)) throw new Error('Unknown outbound context');
    return record;
  }
  async function webhook(raw, headers) {
    if (!config.publicKey) return { code: 503, body: { error: 'Telnyx webhook verification is not configured' } };
    if (!verifyTelnyxWebhook(raw, headers, config.publicKey)) return { code: 400, body: { error: 'Invalid Telnyx signature' } };
    let data, state;
    try { data = JSON.parse(raw).data; state = JSON.parse(Buffer.from(data.payload.client_state || '', 'base64').toString()); }
    catch { return { code: 200, body: { received: true, ignored: true } }; }
    const record = records.get(state.request_id);
    if (!record || !['pstn', 'sip'].includes(state.leg) || String(data.payload.connection_id) !== config.connection) {
      return { code: 200, body: { received: true, ignored: true } };
    }
    if (typeof data.id !== 'string' || !data.id) return { code: 400, body: { error: 'Missing event id' } };
    if (seen.has(data.id)) return { code: 200, body: { received: true, duplicate: true } };
    // Serialize each call's webhook actions; retries cannot create a second SIP leg.
    const task = (record.queue || Promise.resolve()).catch(() => {}).then(async () => {
      if (seen.has(data.id)) return;
      const p = data.payload;
      if (state.leg === 'pstn') record.pstnId ||= p.call_control_id;
      else record.sipId ||= p.call_control_id;
      if (data.event_type === 'call.machine.detection.ended' && ['machine','machine_end_beep','machine_end_silence','machine_end_other'].includes(String(p.result))) record.responderType = 'machine';
      if (data.event_type === 'call.answered' && state.leg === 'pstn' && !record.sipRequested && !['ended', 'failed'].includes(record.status)) {
        record.answeredAt ||= new Date().toISOString();
        record.sipRequested = true; record.status = 'connecting';
        try {
          const call = await api('/calls', { connection_id: config.connection, from: record.from, to: config.sip,
            command_id: command(record, 'sip'), client_state: clientState(record, 'sip'),
            webhook_url: config.webhook, webhook_url_method: 'POST',
            link_to: record.pstnId, bridge_on_answer: true, prevent_double_bridge: true,
            custom_headers: [{ name: 'X-Aether-Outbound-Token', value: record.token }],
            sip_transport_protocol: 'TLS', media_encryption: 'SRTP', preferred_codecs: 'OPUS,PCMU,PCMA',
            timeout_secs: 20, time_limit_secs: 600, retry_on_timeout: false });
          record.sipId ||= call.call_control_id;
        } catch {
          record.status = 'failed'; await hangup(record, record.pstnId);
        }
      } else if (data.event_type === 'call.bridged' && !['ended', 'failed'].includes(record.status)) {
        record.status = 'connected'; record.mediaReady = true; onReady(record);
      } else if (data.event_type === 'call.hangup') {
        const cause = String(p.hangup_cause || '').toLowerCase();
        record.status = record.answeredAt ? 'ended' : /busy/.test(cause) ? 'busy' : /no_answer|timeout|no_user_response/.test(cause) ? 'no_answer' : 'failed';
        record.endedAt = new Date().toISOString(); record.mediaReady = false;
        byToken.delete(record.token); onEnd(record);
        await hangup(record, state.leg === 'pstn' ? record.sipId : record.pstnId);
        record.name = ''; record.reason = '';
      }
      changed(record);
      seen.add(data.id);
      if (seen.size > 10000) seen.delete(seen.values().next().value);
      log('info', 'outbound_event', { request_id: record.id, event_type: data.event_type, status: record.status });
    });
    record.queue = task;
    try { await task; return { code: 200, body: { received: true } }; }
    catch { return { code: 500, body: { error: 'Webhook processing failed' } }; }
  }
  return { start, webhook, resolveContext, readiness };
}
