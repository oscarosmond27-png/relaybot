// server.js – Twilio <-> OpenAI Realtime relay (Render, Node 22)
// Uses ws client to connect to OpenAI Realtime via WebSocket
// Endpoints:
//   GET /           -> "OK" (health/keep-alive)
//   GET /health     -> "healthy"
//   GET /twiml?prompt=... -> TwiML that tells Twilio to open a media stream to /twilio
//   (upgrade) /twilio  -> WS bridge Twilio <-> OpenAI

import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.use(express.json());

// ---- Health ----
app.get("/", (_req, res) => res.type("text/plain").send("OK"));
app.get("/health", (_req, res) => res.type("text/plain").send("healthy"));

// ---- TwiML (Twilio fetches this) ----
app.get("/twiml", (req, res) => {
  try {
    const prompt = req.query.prompt || "";
    const host = req.get("host");
    const wsUrl = `wss://${host}/twilio?prompt=${encodeURIComponent(prompt)}`;
    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<Response>\n` +
      `  <Say>Hello, I have a quick message for you.</Say>\n` +
      `  <Connect><Stream url="${wsUrl}" /></Connect>\n` +
      `</Response>`;
    res.set("Content-Type", "text/xml").status(200).send(twiml);
  } catch (e) {
    console.error("TwiML error:", e);
    res
      .status(500)
      .type("text/xml")
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, an error occurred.</Say></Response>`);
  }
});

// ---- HTTP server ----
const server = app.listen(process.env.PORT || 10000, () => {
  console.log("Server listening on", server.address().port);
});

// ---- WS upgrade routing ----
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/twilio")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleTwilio(ws, req).catch(err => {
        console.error("handleTwilio error:", err);
        try { ws.close(); } catch {}
      });
    });
  } else {
    socket.destroy();
  }
});

// ---- Twilio <-> OpenAI bridge ----
async function handleTwilio(ws, req) {
  const url = new URL(req.url, "https://example.com");
  const prompt = url.searchParams.get("prompt") || "";
  const loop = url.searchParams.get("loop") === "1";

  // --- LOOPBACK TEST MODE ---
  if (loop) {
    console.log("Loopback mode enabled");
    let sid = null;

    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString());
        if (msg.event === "start") {
          sid = msg.start?.streamSid;
        } else if (msg.event === "media" && sid) {
          // Send the same audio back
          ws.send(JSON.stringify({
            event: "media",
            streamSid: sid,
            media: { payload: msg.media.payload }
          }));
        } else if (msg.event === "stop") {
          try { ws.close(); } catch {}
        }
      } catch {}
    });
    return; // Don't connect to OpenAI in loopback mode
  }


  // Connect to OpenAI Realtime with ws client (Node)
  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
  const oai = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    "realtime",
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  let streamSid = null;
  let oaiOpen = false;

  oai.on("open", () => {
    oaiOpen = true;

    // Configure session
    oai.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: "alloy",
        modalities: ["audio"],
        input_audio_format: "g711_ulaw",   // Twilio sends μ-law 8k
        output_audio_format: "g711_ulaw",  // Have OpenAI return μ-law 8k
        turn_detection: { type: "server_vad" },
        instructions:
          "You are a friendly ENGLISH-ONLY phone assistant. " +
          "Deliver the caller’s message, then keep replies brief (under 8 seconds)."
      }
    }));

    // Initial prompt
    oai.send(JSON.stringify({
      type: "response.create",
      response: { instructions: `Deliver this message: ${prompt}`, modalities: ["audio"] }
    }));
  });

  // Twilio -> OpenAI
  ws.on("message", (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.event === "start") {
        streamSid = msg.start?.streamSid;
      } else if (msg.event === "media" && streamSid && oaiOpen) {
        oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        // (Optional) we can commit periodically; realtime server-vad works fine without explicit commit per chunk.
      } else if (msg.event === "stop") {
        try { oai.close(); } catch {}
        try { ws.close(); } catch {}
      }
    } catch (e) {
      console.error("Twilio msg parse error:", e);
    }
  });

  // OpenAI -> Twilio
  oai.on("message", (data) => {
    try {
      const obj = JSON.parse(data.toString());
      if (obj.type === "response.audio.delta" && obj.delta && streamSid) {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: obj.delta } }));
      }
    } catch {
      // ignore non-JSON frames
    }
  });

  oai.on("close", () => { try { ws.close(); } catch {} });
  oai.on("error", (err) => { console.error("OpenAI WS error:", err?.message || err); try { ws.close(); } catch {} });

  ws.on("close", () => { try { oai.close(); } catch {} });
}
