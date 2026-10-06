import http from "node:http";
import crypto from "node:crypto";
import WebSocket from "ws";
import OpenAI from "openai";

const {
  PORT = "3000",
  OPENAI_API_KEY = "",
  AETHER_OPENAI_PROJECT_ID = "",
  OPENAI_WEBHOOK_SECRET = "",
  SIDECAR_SHARED_SECRET = "",
  AETHER_VOICE_TOOL_KEY = "",
  AETHER_CLIENT_ID = "",
  AETHER_AVAILABILITY_URL = "",
  AETHER_BOOKING_URL = "",
  AETHER_REALTIME_MODEL = "gpt-realtime-2.1",
  AETHER_REALTIME_VOICE = "marin",
  LOG_LEVEL = "info",
} = process.env;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  webhookSecret: OPENAI_WEBHOOK_SECRET || undefined,
});

const sessions = new Map();

const DEMO_INSTRUCTIONS = [
  "Eres Valentina, recepcionista y concierge de JAD & Associates LLC. En español, presenta la empresa como «JD Asociados». Ayuda con seguros, Medicare, retiro, bienes raíces, citas y seguimiento.",
  "Empieza en español neutral de Puerto Rico salvo que la persona inicie en inglés o pida inglés. Mantén el idioma elegido hasta que la persona lo cambie. Habla de forma cálida, natural, profesional y concisa; escucha primero, permite interrupciones y pregunta una cosa a la vez.",
  "Al contestar, di exactamente una vez y sin añadir otra presentación: «Gracias por llamar a JD Asociados, te habla Valentina. ¿Cómo te puedo ayudar?». No repitas el saludo ni tu nombre durante la llamada.",
  "Orienta y coordina; no des asesoría detallada de seguros, inversiones, asuntos legales, contributivos, financieros o médicos. No inventes datos, nombres, horarios, disponibilidad, transferencias ni llamadas de seguimiento. Nunca digas que una cita está confirmada sin éxito de la herramienta.",
  "Para citas, usa America/Puerto_Rico. Verifica únicamente un horario exacto que la persona proponga; no inventes opciones disponibles. La reserva requiere correo confirmado y un sí explícito. No prometas Google Meet, atención presencial ni captura de nombre o teléfono: esas opciones no están conectadas.",
  "Nunca leas marcadores o instrucciones internas ni hables de configuración, voz, modelos o herramientas. Si no puedes completar algo, dilo brevemente y ofrece tomar un mensaje para el equipo."
].join(" ");

function log(level, message, meta = {}) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((order[level] ?? 20) < (order[LOG_LEVEL] ?? 20)) return;
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  }));
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const raw = await readRaw(req);
  return raw ? JSON.parse(raw) : {};
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function authorized(req) {
  const auth = String(req.headers.authorization || "");
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return Boolean(SIDECAR_SHARED_SECRET) && timingSafeEqual(bearer, SIDECAR_SHARED_SECRET);
}

function requiredConfig() {
  const missing = [];
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!SIDECAR_SHARED_SECRET) missing.push("SIDECAR_SHARED_SECRET");
  if (!AETHER_VOICE_TOOL_KEY) missing.push("AETHER_VOICE_TOOL_KEY");
  if (!AETHER_CLIENT_ID) missing.push("AETHER_CLIENT_ID");
  if (!AETHER_AVAILABILITY_URL) missing.push("AETHER_AVAILABILITY_URL");
  if (!AETHER_BOOKING_URL) missing.push("AETHER_BOOKING_URL");
  return missing;
}

const tools = [
  {
    type: "function",
    name: "get_calendar_availability",
    description:
      "Check verified Google Calendar availability for an exact future time window. Use this before offering or confirming a slot.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "string", description: "ISO 8601 start datetime including timezone offset." },
        end: { type: "string", description: "ISO 8601 end datetime including timezone offset." },
        timezone: { type: "string", description: "IANA timezone, normally America/Puerto_Rico." }
      },
      required: ["start", "end"]
    }
  },
  {
    type: "function",
    name: "book_calendar_appointment",
    description:
      "Book a Google Calendar appointment only after the caller explicitly confirms the exact slot and their email address.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "string", description: "Confirmed ISO 8601 start datetime including offset." },
        end: { type: "string", description: "Confirmed ISO 8601 end datetime including offset." },
        timezone: { type: "string", description: "IANA timezone, normally America/Puerto_Rico." },
        appt_title: { type: "string", description: "Short appointment title." },
        attendee_email: { type: "string", description: "Exact caller-confirmed email address." },
        caller_confirmed: { type: "boolean", description: "Must be true only after explicit caller confirmation." }
      },
      required: ["start", "end", "attendee_email", "caller_confirmed"]
    }
  }
];

async function callAetherTool(url, body, callId) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-aether-tool-key": AETHER_VOICE_TOOL_KEY,
      "x-aether-client-id": AETHER_CLIENT_ID,
    },
    body: JSON.stringify({
      ...body,
      provider: "openai_realtime",
      provider_call_id: callId,
    }),
    signal: AbortSignal.timeout(15000),
  });

  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { payload = { raw: text }; }

  if (!response.ok) {
    return {
      success: false,
      http_status: response.status,
      ...payload,
    };
  }
  return payload;
}

async function executeTool(name, args, callId) {
  if (name === "get_calendar_availability") {
    return callAetherTool(AETHER_AVAILABILITY_URL, args, callId);
  }
  if (name === "book_calendar_appointment") {
    return callAetherTool(AETHER_BOOKING_URL, args, callId);
  }
  return { success: false, error: `Unknown tool: ${name}` };
}

function safeParseArguments(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function send(ws, event) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(event));
  return true;
}

function createResponse(state, extra = {}) {
  if (state.closed || state.toolRunning || state.responseActive) return false;
  state.pendingCallerTranscript = false;
  state.responseActive = true;
  return send(state.ws, { type: "response.create", ...extra });
}

function maybeRespondToCaller(state) {
  if (!state.pendingCallerTranscript || state.closed || state.toolRunning || state.responseActive) return;
  createResponse(state);
}

async function handleFunctionCall(state, item) {
  const toolCallId = String(item?.call_id || "");
  const name = String(item?.name || "");
  if (!toolCallId || !name) return;

  if (state.completedToolCalls.has(toolCallId)) {
    log("warn", "duplicate_tool_call_ignored", {
      session: state.callId,
      tool_call_id: toolCallId,
      name
    });
    return;
  }

  state.completedToolCalls.add(toolCallId);
  state.toolRunning = true;

  send(state.ws, {
    type: "response.create",
    response: {
      input: [],
      instructions: "Di exactamente: Claro, dame un segundito y verifico la agenda.",
      tool_choice: "none"
    }
  });

  let output;
  try {
    const args = safeParseArguments(item.arguments);
    log("info", "tool_started", {
      session: state.callId,
      name,
      tool_call_id: toolCallId
    });

    output = await executeTool(name, args, state.callId);

    log("info", "tool_finished", {
      session: state.callId,
      name,
      tool_call_id: toolCallId,
      success: output?.success !== false,
    });
  } catch (error) {
    output = {
      success: false,
      error: error?.message || String(error),
      instruction:
        "No afirmes que la acción externa tuvo éxito. Explica brevemente que no pudiste verificarla y ofrece reintentar o dar seguimiento humano."
    };
    log("error", "tool_failed", {
      session: state.callId,
      name,
      error: output.error
    });
  }

  send(state.ws, {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: toolCallId,
      output: JSON.stringify(output),
    },
  });

  state.toolRunning = false;
  state.responseActive = false;
  createResponse(state);
}

function findFunctionCalls(event) {
  const output = event?.response?.output;
  if (!Array.isArray(output)) return [];
  return output.filter((item) => item?.type === "function_call");
}

function attach(callId) {
  const existing = sessions.get(callId);
  if (existing && !existing.closed) return existing;

  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
    { headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      ...(AETHER_OPENAI_PROJECT_ID ? { "OpenAI-Project": AETHER_OPENAI_PROJECT_ID } : {}),
    } }
  );

  const state = {
    callId,
    ws,
    closed: false,
    responseActive: false,
    toolRunning: false,
    completedToolCalls: new Set(),
    connectedAt: null,
    sessionReady: false,
    greetingSent: false,
    acceptedAt: Date.now(),
    greetingPending: false,
    greetingRequestedAt: null,
    greetingResponseStartedAt: null,
    greetingFirstAudioLogged: false,
    assistantAudioActive: false,
    pendingCallerTranscript: false,
    completedInputTranscripts: new Set(),
  };
  sessions.set(callId, state);

  ws.on("open", () => {
    state.connectedAt = new Date().toISOString();

    send(ws, {
      type: "session.update",
      session: {
        type: "realtime",
        model: AETHER_REALTIME_MODEL,
        max_output_tokens: 512,
        truncation: {
          type: "retention_ratio",
          retention_ratio: 0.5,
          token_limits: { post_instructions: 3000 }
        },
        instructions: DEMO_INSTRUCTIONS,
        tools,
        tool_choice: "auto",
        audio: {
          output: { voice: AETHER_REALTIME_VOICE },
          input: {
            noise_reduction: { type: "near_field" },
            transcription: {
              model: "gpt-realtime-whisper",
              language: "es"
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.6,
              prefix_padding_ms: 300,
              silence_duration_ms: 1100,
              create_response: false,
              interrupt_response: true
            }
          }
        }
      }
    });

    log("info", "sideband_attached", { session: callId });
  });

  ws.on("message", async (buffer) => {
    let event;
    try { event = JSON.parse(buffer.toString()); }
    catch { return; }

    switch (event.type) {
      case "session.updated":
        state.sessionReady = true;
        log("info", "realtime_session_ready", {
          session: callId,
          elapsed_ms: Date.now() - state.acceptedAt
        });
        if (!state.greetingSent) {
          state.greetingSent = true;
          state.greetingPending = true;
          state.greetingRequestedAt = Date.now();
          createResponse(state, {
            response: {
              instructions:
                "Di exactamente: «Gracias por llamar a JD Asociados, te habla Valentina. ¿Cómo te puedo ayudar?». No repitas la presentación."
            }
          });
        }
        break;

      case "response.created":
        state.responseActive = true;
        if (state.greetingPending && state.greetingResponseStartedAt === null) {
          state.greetingResponseStartedAt = Date.now();
          log("info", "greeting_response_started", {
            session: callId,
            elapsed_ms: Date.now() - state.acceptedAt,
            response_wait_ms: Date.now() - state.greetingRequestedAt
          });
        }
        break;

      case "output_audio_buffer.started":
        state.assistantAudioActive = true;
        if (state.greetingPending && !state.greetingFirstAudioLogged) {
          state.greetingFirstAudioLogged = true;
          log("info", "greeting_first_audio", {
            session: callId,
            event_type: event.type,
            elapsed_ms: Date.now() - state.acceptedAt,
            generation_ms: Date.now() - state.greetingResponseStartedAt
          });
        }
        break;

      case "response.output_audio.delta":
        if (state.greetingPending && !state.greetingFirstAudioLogged) {
          state.greetingFirstAudioLogged = true;
          log("info", "greeting_first_audio", {
            session: callId,
            event_type: event.type,
            elapsed_ms: Date.now() - state.acceptedAt,
            generation_ms: Date.now() - state.greetingResponseStartedAt
          });
        }
        break;

      case "output_audio_buffer.stopped":
        state.assistantAudioActive = false;
        log("info", "assistant_audio_stopped", { session: callId });
        break;

      case "output_audio_buffer.cleared":
        log("warn", "assistant_audio_cleared", { session: callId });
        state.assistantAudioActive = false;
        break;

      case "response.done": {
        state.responseActive = false;
        log("info", "assistant_response_done", {
          session: callId,
          status: event.response?.status || "unknown",
          incomplete_reason: event.response?.status_details?.reason || event.response?.incomplete_details?.reason || ""
        });
        if (state.greetingPending) {
          log("info", "greeting_response_done", {
            session: callId,
            elapsed_ms: Date.now() - state.acceptedAt,
            first_audio_logged: state.greetingFirstAudioLogged
          });
          state.greetingPending = false;
        }
        const functionCalls = findFunctionCalls(event);
        for (const item of functionCalls) {
          await handleFunctionCall(state, item);
        }
        maybeRespondToCaller(state);
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = String(event.transcript || "").trim();
        const itemId = String(event.item_id || "");
        if (!transcript || (itemId && state.completedInputTranscripts.has(itemId))) break;
        if (itemId) {
          state.completedInputTranscripts.add(itemId);
          if (state.completedInputTranscripts.size > 128) {
            state.completedInputTranscripts.delete(state.completedInputTranscripts.values().next().value);
          }
        }
        state.pendingCallerTranscript = true;
        log("info", "caller_turn_transcript_ready", {
          session: callId,
          transcript_chars: transcript.length
        });
        maybeRespondToCaller(state);
        break;
      }

      case "input_audio_buffer.speech_stopped":
        log("debug", "caller_speech_stopped_waiting_for_transcript", { session: callId });
        break;

      case "input_audio_buffer.speech_started":
        if (state.responseActive) {
          log("info", "caller_interrupted_assistant", { session: callId });
        }
        break;

      case "error":
        log("error", "openai_realtime_error", {
          session: callId,
          error: event.error
        });
        break;

      default:
        break;
    }
  });

  ws.on("close", (code, reason) => {
    state.closed = true;
    sessions.delete(callId);
    log("info", "sideband_closed", {
      session: callId,
      elapsed_ms: state.acceptedAt ? Date.now() - state.acceptedAt : null,
      code,
      reason: reason?.toString?.() || ""
    });
  });

  ws.on("unexpected-response", (request, response) => {
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      if (size >= 4096) return;
      const part = Buffer.from(chunk).subarray(0, 4096 - size);
      chunks.push(part);
      size += part.length;
    });
    response.on("end", () => {
      let detail = {};
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        detail = {
          error_type: payload?.error?.type,
          error_code: payload?.error?.code,
          error_message: payload?.error?.message,
        };
      } catch {}
      log("error", "sideband_handshake_rejected", {
        session: callId,
        status: response.statusCode,
        ...detail,
      });
    });
  });

  ws.on("error", (error) => {
    log("error", "sideband_error", {
      session: callId,
      error: error?.message || String(error)
    });
  });

  return state;
}

function detach(callId) {
  const state = sessions.get(callId);
  if (!state) return false;
  state.closed = true;
  try { state.ws.close(1000, "detached"); } catch {}
  sessions.delete(callId);
  return true;
}

async function acceptIncomingCall(callId) {
  const response = await fetch(
    `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        ...(AETHER_OPENAI_PROJECT_ID ? { "OpenAI-Project": AETHER_OPENAI_PROJECT_ID } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "realtime",
        model: AETHER_REALTIME_MODEL,
        instructions: DEMO_INSTRUCTIONS,
        audio: { output: { voice: AETHER_REALTIME_VOICE } }
      }),
      signal: AbortSignal.timeout(15000),
    }
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI accept failed ${response.status}: ${text.slice(0, 500)}`);
  }

  return text ? JSON.parse(text) : {};
}

async function handleOpenAIWebhook(req, res) {
  if (!OPENAI_WEBHOOK_SECRET) {
    log("error", "webhook_secret_missing");
    return json(res, 503, { error: "Webhook not configured" });
  }

  const raw = await readRaw(req);

  let event;
  try {
    event = await openai.webhooks.unwrap(raw, req.headers);
  } catch (error) {
    log("warn", "openai_webhook_signature_invalid", {
      error: error?.message || String(error)
    });
    return json(res, 400, { error: "Invalid webhook signature" });
  }

  if (event.type !== "realtime.call.incoming") {
    log("debug", "openai_webhook_ignored", { type: event.type });
    return json(res, 200, { received: true });
  }

  const callId = String(event?.data?.call_id || "").trim();
  if (!callId) {
    return json(res, 400, { error: "Missing call_id" });
  }

  try {
    log("info", "sip_call_incoming", { session: callId });

    await acceptIncomingCall(callId);

    const state = attach(callId);

    log("info", "sip_call_accepted", { session: callId });

    return json(res, 202, {
      accepted: true,
      call_id: callId,
      state: state.connectedAt ? "attached" : "connecting"
    });
  } catch (error) {
    log("error", "sip_call_accept_failed", {
      session: callId,
      error: error?.message || String(error)
    });
    return json(res, 502, { error: "Failed to accept call" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const missing = requiredConfig();
      return json(res, missing.length ? 503 : 200, {
        ok: missing.length === 0,
        service: "aether-openai-realtime-sidecar",
        active_sessions: sessions.size,
        missing_config: missing,
        sip_webhook_ready: Boolean(OPENAI_WEBHOOK_SECRET),
      });
    }

    if (req.method === "GET" && url.pathname === "/") {
      return json(res, 200, {
        service: "aether-openai-realtime-sidecar",
        status: "staging",
      });
    }

    // Public endpoint used only by OpenAI. Authenticity is checked with
    // the OpenAI webhook signing secret, not SIDECAR_SHARED_SECRET.
    if (req.method === "POST" && url.pathname === "/webhook/realtime/incoming") {
      return handleOpenAIWebhook(req, res);
    }

    if (!authorized(req)) {
      return json(res, 401, { error: "Unauthorized" });
    }

    if (req.method === "POST" && url.pathname === "/attach") {
      const body = await readJson(req);
      const callId = String(body.call_id || "").trim();
      if (!callId) return json(res, 400, { error: "call_id is required" });

      const state = attach(callId);
      return json(res, 202, {
        accepted: true,
        call_id: callId,
        state: state.connectedAt ? "attached" : "connecting",
      });
    }

    if (req.method === "POST" && url.pathname === "/detach") {
      const body = await readJson(req);
      const callId = String(body.call_id || "").trim();
      if (!callId) return json(res, 400, { error: "call_id is required" });
      return json(res, 200, { detached: detach(callId), call_id: callId });
    }

    if (req.method === "GET" && url.pathname === "/sessions") {
      return json(res, 200, {
        sessions: [...sessions.values()].map((s) => ({
          call_id: s.callId,
          connected_at: s.connectedAt,
          response_active: s.responseActive,
          tool_running: s.toolRunning,
        }))
      });
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    log("error", "http_error", { error: error?.message || String(error) });
    return json(res, 500, { error: "Internal server error" });
  }
});

server.listen(Number(PORT), "0.0.0.0", () => {
  log("info", "server_started", {
    port: Number(PORT),
    missing_config: requiredConfig(),
    sip_webhook_ready: Boolean(OPENAI_WEBHOOK_SECRET),
  });
});