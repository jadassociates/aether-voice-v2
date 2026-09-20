# AETHER Voice V2 — OpenAI Realtime SIP Sidecar

Persistent Node.js sidecar for AETHER Option C.

## Purpose

Keeps a long-lived server-side WebSocket attached to an existing OpenAI Realtime SIP call while SIP carries audio. The sidecar:

- exposes `/health`
- accepts authenticated `/attach` and `/detach`
- connects to `wss://api.openai.com/v1/realtime?call_id=...`
- installs AETHER function tools with `session.update`
- uses `input_audio_buffer.speech_stopped` only for turn timing
- executes tools only from completed model `function_call` items
- returns `function_call_output`
- sends `response.create` after tool completion
- deduplicates tool calls by `call_id`

## Required environment variables

See `.env.example`.

## Railway

Start command:

```bash
node index.mjs
```

Healthcheck:

```text
/health
```

The service should run continuously (sleep disabled).

## Safety / rollout

This repository is staging infrastructure. Do not route the production phone number to it until:

1. Railway `/health` returns `200`
2. Base44 webhook can call `/attach`
3. OpenAI API + Base44 tool secrets are configured
4. a real PSTN test passes availability lookup and booking
5. Retell remains available as rollback
