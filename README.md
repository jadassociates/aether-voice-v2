# AETHER Voice V2 — Valentina inbound and outbound

Telnyx carries calls; OpenAI Realtime handles the conversation. Both directions use the existing `AETHER_REALTIME_MODEL`, `AETHER_REALTIME_VOICE` and verified AETHER Google Calendar tools. No Retell or Cal.com integration is required.

## Inbound

Keep +17874224202 assigned to the existing AETHER OpenAI Realtime SIP connection. Signed OpenAI incoming webhooks at `/webhook/realtime/incoming` accept the call and attach the sideband WebSocket. The inbound greeting and tools remain unchanged.

## Controlled outbound

The Telnyx Voice API application `AETHER Valentina Outbound` has its own connection ID (`3064472476890170444`) and the Default outbound voice profile. Do not assign the inbound number to this application. It uses the owned number as caller ID while inbound routing stays on the SIP connection.

1. An authenticated owner request calls `POST /outbound/start`.
2. Telnyx dials the destination. After it answers, the signed Telnyx webhook dials the existing OpenAI SIP destination and bridges both legs.
3. A nonce SIP header selects the authorized outbound context. The greeting waits for both the sideband session and Telnyx bridge to be ready.
4. Valentina verifies identity before discussing the purpose, uses the same calendar tools, and ends the call when requested. A hangup on either leg closes the other.

Set the variables in `.env.example`. Keep `AETHER_OUTBOUND_ENABLED=false` until credentials and a controlled real call are ready. Store `TELNYX_API_KEY` only in Railway secrets. `TELNYX_PUBLIC_KEY` is the account's base64 Ed25519 webhook verification public key.

Example request body (requires the existing SIDECAR_SHARED_SECRET as a bearer token):

```json
{
  "request_id": "unique-owner-request-001",
  "to": "+17875550123",
  "contact_name": "Persona de prueba",
  "call_reason": "Confirmar la orientación que solicitó",
  "owner_approved": true
}
```

Use a real authorized destination and purpose. This controlled rollout allows one active outbound call, +1 destinations, 30-second ring timeout, and a 10-minute maximum. Reuse the same request ID after an uncertain response; do not retry with a new ID. Provider command IDs and the process ledger suppress duplicates. The ledger is in memory, so restarts during a call require operator reconciliation; this is not a durable campaign queue. An unknown dial result blocks new calls until reconciliation/restart. Do not run multiple replicas for this rollout.

## Operations

`GET /health` reports inbound configuration and separate outbound readiness, including missing variable names without secrets. Outbound being disabled does not fail inbound health. `/attach`, `/detach`, and `/outbound/start` require the existing shared secret; Telnyx webhooks require a valid Ed25519 signature and fresh timestamp.

Railway must run continuously with `/health` as healthcheck. Preserve the existing start command that bootstraps the OpenAI webhook signing secret before importing `index.mjs`; plain `node index.mjs` is suitable only when `OPENAI_WEBHOOK_SECRET` is already configured.

Run `npm ci`, `npm run check`, and `npm test`. Tests mock Telnyx and place no real calls. Before enabling broader use, complete a real inbound regression call and a controlled outbound call verifying greeting, interruption, availability, booking, and cleanup.
