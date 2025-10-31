// server.js
// Twilio <-> OpenAI GPT-4o Realtime relay server
// Deploy on Render (free). Supports full-duplex voice calls.

import express from "express";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ========== TwiML endpoint (tells Twilio what to do when call starts) ==========
app.get("/twiml", (req, res) => {
  const prompt = req.query.prompt || "";
  const wsUrl = `${req.protocol === "https" ? "wss" : "ws"}://${req.get("host")}/twilio?prompt=${encodeURIComponent(prompt)}`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hello, I have a quick message for you.</Say>
  <Connect><Stream url="${wsUrl}" /></Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ========== Start HTTP server ==========
const server = app.listen(process.env.PORT || 10000, () => {
  console.log("Server listening on port", server.address().port);
});

// ========== WebSocket handler for Twilio <-> OpenAI bridge ==========
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/twilio")) {
    wss.handleUpgrade(req, socket, head, (ws) => handleTwilio(ws, req));
  } else {
    socket.destroy();
  }
});

async function handleTwilio(ws, req) {
  const prompt = new URL(req.url, "https://dummy").searchParams.get("prompt") || "";

  // Connect to OpenAI Realtime WebSocket
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
    console.error("OpenAI WS failed to connect");
    ws.close();
    return;
  }
  oai.accept();
  console.log("OpenAI connection accepted");

  // Configure realtime session
  oai.send(JSON.stringify({
    type: "session.update",
    session: {
      voice: "alloy",
      modalities: ["audio"],
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      turn_detection: { type: "server_vad" },
      instructions:
        "You are a friendly English-speaking phone assistant. Deliver the caller’s message " +
        "naturally, then handle brief back-and-forth politely."
    }
  }));

  // Send the initial prompt to OpenAI
  oai.send(JSON.stringify({
    type: "response.create",
    response: {
      instructions: `Deliver this message: ${prompt}`,
      modalities: ["audio"]
    }
  }));

  let streamSid = null;

  // Twilio -> OpenAI (incoming caller audio)
  ws.on("message", (m) => {
    try {
      const msg = JSON.parse(m);
      if (msg.event === "start") streamSid = msg.start.streamSid;
      else if (msg.event === "media" && streamSid)
        oai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
      else if (msg.event === "stop") {
        oai.close();
        ws.close();
      }
    } catch (e) {
      console.error("Parse error:", e);
    }
  });

  // OpenAI -> Twilio (outgoing spoken reply)
  oai.addEventListener("message", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "response.audio.delta" && data.delta && streamSid) {
        ws.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: data.delta }
        }));
      }
    } catch {
      // ignore non-JSON frames
    }
  });

  oai.addEventListener("close", () => ws.close());
  ws.on("close", () => oai.close());
}
