import crypto from 'node:crypto';
import { verifyTelnyxWebhook } from './outbound.mjs';

const tokenHeader = 'X-Aether-Inbound-Token';
const reply = (code, body = { received: true }) => ({ code, body });

export function createInbound({ clients, env = process.env, request = fetch, now = Date.now, log = () => {} }) {
  const enabled = env.AETHER_INBOUND_CLIENTS_ENABLED === 'true';
  const connection = env.TELNYX_INBOUND_CONNECTION_ID;
  const key = env.TELNYX_API_KEY;
  const publicKey = env.TELNYX_PUBLIC_KEY;
  const sip = env.AETHER_OPENAI_SIP_URI;
  const secret = env.SIDECAR_SHARED_SECRET;
  const ready = Boolean(enabled && connection && key && publicKey && sip && secret && clients.size);
  const usedTokens = new Map();

  const sign = payload => crypto.createHmac('sha256', secret).update('inbound:' + payload).digest('hex');

  function resolveTenant(headers, openaiCallId) {
    const tokens = (headers || []).filter(header => String(header.name).toLowerCase() === tokenHeader.toLowerCase());
    if (!tokens.length) return null;
    const parts = String(tokens[0].value).split('.');
    const [number, expires, nonce, signature] = parts;
    const payload = parts.slice(0, 3).join('.');
    const deadline = Number(expires);
    const tenant = clients.get(number);
    if (!ready || tokens.length !== 1 || parts.length !== 4 || !tenant ||
        !/^\d+$/.test(expires) || deadline < now() || deadline > now() + 120000 ||
        !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature) ||
        !crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(payload), 'hex'))) {
      throw new Error('Invalid inbound context');
    }
    for (const [id, used] of usedTokens) if (used.deadline < now()) usedTokens.delete(id);
    const existing = usedTokens.get(nonce);
    if (existing && existing.openaiCallId !== openaiCallId) throw new Error('Replayed inbound context');
    if (!existing && usedTokens.size >= 10000) throw new Error('Inbound context capacity reached');
    usedTokens.set(nonce, { deadline, openaiCallId });
    return tenant;
  }

  async function webhook(raw, headers) {
    if (!ready) return reply(503, { error: 'Client inbound calling is disabled or incomplete' });
    if (!verifyTelnyxWebhook(raw, headers, publicKey, now())) return reply(400, { error: 'Invalid Telnyx signature' });
    let data;
    try { data = JSON.parse(raw)?.data; } catch { return reply(400, { error: 'Invalid Telnyx event' }); }
    const call = data?.payload;
    if (data?.event_type !== 'call.initiated' || call?.direction !== 'incoming' ||
        String(call.connection_id) !== connection || !clients.has(call.to)) return reply(200);
    if (typeof call.call_control_id !== 'string' || !call.call_control_id) {
      return reply(400, { error: 'Missing call control ID' });
    }

    const commandId = crypto.createHash('sha256').update('inbound-transfer:' + call.call_control_id).digest('hex');
    const payload = [call.to, now() + 120000, commandId.slice(0, 32)].join('.');
    try {
      const response = await request('https://api.telnyx.com/v2/calls/' + encodeURIComponent(call.call_control_id) + '/actions/transfer', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({
          to: sip, command_id: commandId, sip_transport_protocol: 'TLS', media_encryption: 'SRTP',
          custom_headers: [{ name: tokenHeader, value: payload + '.' + sign(payload) }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Transfer rejected');
      log('info', 'client_inbound_transfer_accepted');
      return reply(200);
    } catch {
      log('warn', 'client_inbound_transfer_unconfirmed');
      return reply(502, { error: 'Transfer unconfirmed' });
    }
  }

  return { webhook, resolveTenant };
}
