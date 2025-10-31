// server.js – Twilio <-> OpenAI Realtime relay (Render)
import express from "express";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json());

// Health endpoints (fixes "Cannot GET /")
app.get("/", (_req, res) => res.type("text/plain").send("OK"));
app.get("/health", (_req, res) => res.type("text/plain").send("healthy"));

// TwiML endpoint (Twilio fetches this)
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

// Start HTTP server
const server = app.listen(process.env.PORT || 10000, () => {
  console.log("Server listening on", server.address().port);
});

// WS bridge Twilio <-> OpenAI Realtime
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/twilio")) {
    wss.handleUpgrade(req, socket, head, (ws) => handleTwilio(ws, req).catch(err => {
      console.error("handleTwilio error:", err);
      try { ws.close(); } catch {}
    }));
  } else {
    socket.destroy();
  }
});

async function handleTwilio(ws, req) {
  const prompt = new URL(req.url, "https://example.com").searchParams.get("prompt") || "";

  // Outbound WS to OpenAI Realtime
  const resp = await fetch("https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
      "Sec-WebSocket-Protocol": "realtime",
      "Connection": "Upgrade",
      "Upgrade": "websocket"
    }
  });

  const oai = resp.webSocket;
  if (!oai) {
    console.error("OpenAI WS connect failed, status:", resp.status);
    ws.close();
    return;
  }
  oai.accept();

  // Configure session
  oai.send(JSON.stringify({
    type: "session.update",
    session: {
      voice: "alloy",
      modalities: ["audio"],
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      turn_detection: { type: "server_vad" },
      instructions: "You are a friendly English-speaking phone assistant. Deliver the caller’s message, then keep replies brief."
    }
  }));

  // Initial prompt
  oai.send(JSON.stringify({
    type: "response.create",
    response: { instructions: `Deliver this message: ${prompt}`, modalities: ["audio"] }
  }));

  let streamSid = null;

  // Twilio → OpenAI
  ws.on("message", (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.event === "start") streamSid = msg.start?.streamSid;
      else if (msg.event === "media" && streamSid)
        oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
      else if (msg.event === "stop") { try { oai.close(); } catch {}; try { ws.close(); } catch {}; }
    } catch (e) { console.error("Twilio msg parse error:", e); }
  });

  // OpenAI → Twilio
  oai.addEventListener("message", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "response.audio.delta" && data.delta && streamSid) {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: data.delta } }));
      }
    } catch { /* ignore non-JSON frames */ }
  });

  oai.addEventListener("close", () => { try { ws.close(); } catch {} });
  ws.on("close", () => { try { oai.close(); } catch {} });
}


  oai.addEventListener("close", () => ws.close());
  ws.on("close", () => oai.close());
}
