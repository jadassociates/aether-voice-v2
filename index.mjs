import http from "node:http";
import crypto from "node:crypto";
import WebSocket from "ws";

const {
  PORT = "3000",
  OPENAI_API_KEY = "",
  SIDECAR_SHARED_SECRET = "",
  AETHER_VOICE_TOOL_KEY = "",
  AETHER_CLIENT_ID = "",
  AETHER_AVAILABILITY_URL = "",
  AETHER_BOOKING_URL = "",
  AETHER_REALTIME_MODEL = "gpt-realtime-2.1",
  AETHER_REALTIME_VOICE = "marin",
  LOG_LEVEL = "info",
} = process.env;

const sessions = new Map();

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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
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
  if (state.closed || state.toolRunning || state.responseActive) return;
  state.responseActive = true;
  send(state.ws, { type: "response.create", ...extra });
}

async function handleFunctionCall(state, item) {
  const callId = String(item?.call_id || "");
  const name = String(item?.name || "");
  if (!callId || !name) return;

  if (state.completedToolCalls.has(callId)) {
    log("warn", "duplicate_tool_call_ignored", { session: state.callId, tool_call_id: callId, name });
    return;
  }

  state.completedToolCalls.add(callId);
  state.toolRunning = true;

  // Bridge ACK: a short spoken message before external lookup.
  send(state.ws, {
    type: "response.create",
    response: {
      input: [],
      instructions: "Say exactly: déjame verificar",
      tool_choice: "none"
    }
  });

  let output;
  try {
    const args = safeParseArguments(item.arguments);
    log("info", "tool_started", { session: state.callId, name, tool_call_id: callId });
    output = await executeTool(name, args, state.callId);
    log("info", "tool_finished", {
      session: state.callId,
      name,
      tool_call_id: callId,
      success: output?.success !== false,
    });
  } catch (error) {
    output = {
      success: false,
      error: error?.message || String(error),
      instruction:
        "Do not claim the external action succeeded. Tell the caller the system could not verify it and offer a safe retry or human follow-up."
    };
    log("error", "tool_failed", { session: state.callId, name, error: output.error });
  }

  send(state.ws, {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
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
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );

  const state = {
    callId,
    ws,
    closed: false,
    responseActive: false,
    toolRunning: false,
    completedToolCalls: new Set(),
    connectedAt: null,
  };
  sessions.set(callId, state);

  ws.on("open", () => {
    state.connectedAt = new Date().toISOString();

    send(ws, {
      type: "session.update",
      session: {
        type: "realtime",
        model: AETHER_REALTIME_MODEL,
        tools,
        tool_choice: "auto",
        audio: {
          output: { voice: AETHER_REALTIME_VOICE },
          input: {
            turn_detection: {
              type: "server_vad",
              create_response: false,
              interrupt_response: true
            }
          }
        }
      }
    });

    // Initial greeting only. No tool work occurs here.
    createResponse(state, {
      response: {
        instructions:
          "Greet the caller briefly and naturally in the caller's language. Ask how you can help. Do not mention systems, tools, or implementation details."
      }
    });

    log("info", "sideband_attached", { session: callId });
  });

  ws.on("message", async (buffer) => {
    let event;
    try { event = JSON.parse(buffer.toString()); }
    catch { return; }

    switch (event.type) {
      case "response.created":
        state.responseActive = true;
        break;

      case "response.done": {
        state.responseActive = false;
        const functionCalls = findFunctionCalls(event);
        for (const item of functionCalls) {
          // Tool execution boundary: completed model function-call items only.
          await handleFunctionCall(state, item);
        }
        break;
      }

      case "input_audio_buffer.speech_stopped":
        // Turn timing only. Never execute a tool here.
        if (!state.toolRunning && !state.responseActive) createResponse(state);
        break;

      case "input_audio_buffer.speech_started":
        // Realtime server handles interruption via interrupt_response=true.
        break;

      case "error":
        log("error", "openai_realtime_error", { session: callId, error: event.error });
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
      code,
      reason: reason?.toString?.() || ""
    });
  });

  ws.on("error", (error) => {
    log("error", "sideband_error", { session: callId, error: error?.message || String(error) });
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
      });
    }

    if (req.method === "GET" && url.pathname === "/") {
      return json(res, 200, {
        service: "aether-openai-realtime-sidecar",
        status: "staging",
      });
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
  });
});
