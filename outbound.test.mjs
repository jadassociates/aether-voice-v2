import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createOutbound, verifyTelnyxWebhook } from './outbound.mjs';

const pair = crypto.generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const env = { TELNYX_API_KEY: 'test-key', TELNYX_PUBLIC_KEY: publicKey,
  TELNYX_OUTBOUND_CONNECTION_ID: '123', AETHER_OUTBOUND_FROM: '+17874224202',
  AETHER_OPENAI_SIP_URI: 'sip:proj_test@sip.api.openai.com;transport=tls',
  AETHER_TELNYX_WEBHOOK_URL: 'https://example.com/webhook/telnyx/outbound',
  AETHER_OUTBOUND_ENABLED: 'true', SIDECAR_SHARED_SECRET: 'test-secret' };
const body = { request_id: 'test-request-01', to: '+17875550123', contact_name: 'Persona de Prueba',
  call_reason: 'Confirmar la orientación solicitada', owner_approved: true };
function signed(event) {
  const raw = JSON.stringify(event), timestamp = String(Math.floor(Date.now() / 1000));
  return [raw, { 'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': crypto.sign(null, Buffer.from(`${timestamp}|${raw}`), pair.privateKey).toString('base64') }];
}
function fixture(extra = {}) {
  const requests = [], ready = [], ended = [];
  const service = createOutbound({ env, request: async (url, options) => {
    const payload = JSON.parse(options.body); requests.push({ url, payload });
    return { ok: true, json: async () => ({ data: { call_control_id: requests.length === 1 ? 'pstn-1' : 'sip-1' } }) };
  }, onReady: r => ready.push(r.id), onEnd: r => ended.push(r.id), ...extra });
  return { service, requests, ready, ended };
}
function event(id, type, leg, control = 'pstn-1') {
  return { data: { id, event_type: type, payload: { connection_id: '123', call_control_id: control,
    client_state: Buffer.from(JSON.stringify({ request_id: body.request_id, leg })).toString('base64') } } };
}
test('signature validation rejects tampering, stale timestamps and missing public keys', () => {
  const [raw, headers] = signed({ data: {} });
  assert.equal(verifyTelnyxWebhook(raw, headers, publicKey), true);
  assert.equal(verifyTelnyxWebhook(raw + ' ', headers, publicKey), false);
  assert.equal(verifyTelnyxWebhook(raw, headers, publicKey, Date.now() + 400000), false);
  assert.equal(verifyTelnyxWebhook(raw, headers, ''), false);
});
test('disabled or incomplete configuration never dials', async () => {
  const { service, requests } = fixture({ env: { ...env, AETHER_OUTBOUND_ENABLED: 'false' } });
  assert.equal((await service.start(body)).code, 503); assert.equal(requests.length, 0);
});
test('requires owner approval, a genuine reason and a valid destination', async () => {
  const { service, requests } = fixture();
  for (const patch of [{ owner_approved: false }, { call_reason: '' }, { to: env.AETHER_OUTBOUND_FROM }, { to: 'sip:any@example.com' }]) {
    assert.equal((await service.start({ ...body, ...patch })).code, 400);
  }
  assert.equal(requests.length, 0);
});
test('repeated and conflicting requests cannot place duplicate PSTN calls', async () => {
  const { service, requests } = fixture();
  const results = await Promise.all([service.start(body), service.start(body)]);
  assert.equal(results[0].code, 202); assert.equal(results[1].code, 200);
  assert.equal((await service.start({ ...body, call_reason: 'Different reason' })).code, 409);
  assert.equal((await service.start({ ...body, request_id: 'another-request' })).code, 409);
  assert.equal(requests.length, 1);
});
test('answer bridges to the same OpenAI SIP target once and does not leak contact metadata in SIP headers', async () => {
  const { service, requests, ready, ended } = fixture(); await service.start(body);
  const answer = signed(event('evt-answer', 'call.answered', 'pstn'));
  await Promise.all([service.webhook(...answer), service.webhook(...answer)]);
  assert.equal(requests.length, 2);
  const sip = requests[1].payload;
  assert.equal(sip.to, env.AETHER_OPENAI_SIP_URI); assert.equal(sip.link_to, 'pstn-1');
  assert.equal(sip.bridge_on_answer, true); assert.equal(sip.sip_transport_protocol, 'TLS');
  assert.equal(sip.media_encryption, 'SRTP');
  assert.equal(JSON.stringify(sip.custom_headers).includes(body.contact_name), false);
  const context = service.resolveContext(sip.custom_headers);
  assert.equal(context.reason, body.call_reason); assert.equal(context.mediaReady, false);
  assert.deepEqual(ready, []);
  await service.webhook(...signed(event('evt-bridge', 'call.bridged', 'sip', 'sip-1')));
  assert.equal(context.mediaReady, true); assert.deepEqual(ready, [body.request_id]);
  await service.webhook(...signed(event('evt-hangup', 'call.hangup', 'pstn')));
  assert.deepEqual(ended, [body.request_id]); assert.match(requests[2].url, /sip-1\/actions\/hangup$/);
  assert.throws(() => service.resolveContext(sip.custom_headers));
});
test('failed SIP bridge closes the answered PSTN leg', async () => {
  let count = 0; const calls = [];
  const { service } = fixture({ request: async (url, options) => {
    count++; calls.push(url);
    if (count === 2) throw new Error('Network timeout');
    return { ok: true, json: async () => ({ data: { call_control_id: 'pstn-1' } }) };
  } });
  await service.start(body);
  await service.webhook(...signed(event('evt-answer-fail', 'call.answered', 'pstn')));
  assert.match(calls[2], /pstn-1\/actions\/hangup$/);
});
test('ambiguous dial failure is retained and never retried', async () => {
  let count = 0; const { service } = fixture({ request: async () => { count++; throw new Error('Timeout'); } });
  assert.equal((await service.start(body)).body.status, 'unknown');
  await service.start(body); assert.equal(count, 1);
});
test('forged webhook cannot dial or bridge', async () => {
  const { service, requests } = fixture(); await service.start(body);
  assert.equal((await service.webhook(JSON.stringify(event('forged', 'call.answered', 'pstn')), {})).code, 400);
  assert.equal(requests.length, 1);
});
