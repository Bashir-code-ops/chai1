const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

// ── Credentials ──────────────────────────────────────────────────────────────
const FIREBASE_API_KEY = "AIzaSyDlCazdn_bziqDVwQkDroR8eK4GVaEHawU"; // from APK
const CHAI_UID        = "5UjcH6R0zWYwzLciAX7lz9F3Sz02";
const REFRESH_TOKEN   = "AMf-vBxABjgCQ0SoRCymcdUbckokYPr9aPJ7-zsy6cFeXMioykMeSSGJiF4Vpi1tqic6HqzfaTmNWDPAo1Z-WBAEFGAuY_tGRt_fyujgs4zhwj7FnvFIp-ZKWM4RsX8sO5qwVZ6gRVFn5eo8kehreZbOCblhhqMMqgaR-EgI_whH4uVWONzzR_QqZnOfWA_yRrEuxAQy4YwoA6znvXbLNz-v21MJbhrzLQiZ6Vc--XuUWqD9Z09f5W2KLfU-8Zq96LPygwE2LS-BLQCqrLCxFzQEVOLRH_422e68fhEbmwv3cvJitPo3LoPas1VO4XCAvULjjT0HC6SjbG6ko03H1VW-NOCCbOTpmlXfrvIUVO-g0bcCsCYLZIL0WMgz5V9PvJ1LYPz4QKBv";

// ── Mobile API endpoints (from APK reverse engineering) ───────────────────────
const BOT_RESPONDER   = "https://bot-responder-eu-shdxwd54ta-nw.a.run.app";
const BOT_SERVICE     = "https://bot-service-us1-shdxwd54ta-uc.a.run.app";

// ── Token cache ───────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getFreshToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN }),
    }
  );
  const data = await res.json();
  if (!data.id_token) throw new Error("Token refresh failed: " + JSON.stringify(data));
  cachedToken = data.id_token;
  tokenExpiry = Date.now() + 3500 * 1000;
  console.log("✅ Token refreshed");
  return cachedToken;
}

// ── GET /botinfo/:botId — fetch bot metadata ──────────────────────────────────
app.get("/botinfo/:botId", async (req, res) => {
  try {
    const token = await getFreshToken();
    const url = `${BOT_SERVICE}/chatbots/v2?bot_uid=${req.params.botId}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    console.log("Bot info:", JSON.stringify(data).substring(0, 300));
    res.status(response.status).json(data);
  } catch (err) {
    console.error("Bot info error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /chat — send a message to a bot ─────────────────────────────────────
// Body: { botId, message, conversationId? }
app.post("/chat", async (req, res) => {
  try {
    const { botId, message, conversationId } = req.body;
    if (!botId || !message) {
      return res.status(400).json({ error: "botId and message are required" });
    }

    const token = await getFreshToken();
    const now = Date.now();

    const payload = {
  user_uid:        CHAI_UID,
  bot_uid:         botId,
  conversation_id: conversationId || `${CHAI_UID}_${botId}`,
  text:            message,
  model:           "chai_v2",
};

    console.log("→ Sending to bot-responder:", JSON.stringify(payload));

    const response = await fetch(`${BOT_RESPONDER}/send_message`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    console.log("← Bot-responder status:", response.status);
    console.log("← Bot-responder body:", text.substring(0, 500));

    // Try to parse as JSON, fall back to raw text
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /token — expose current token + uid (for frontend) ───────────────────
app.get("/token", async (req, res) => {
  try {
    const token = await getFreshToken();
    res.json({ token, uid: CHAI_UID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── GET /feed — get the bot discovery feed ────────────────────────────────────
app.get("/feed", async (req, res) => {
  try {
    const token = await getFreshToken();
    const response = await fetch(
      "https://chai-feed-service-65663778556.us-central1.run.app/feeds/strict-or-lax-acquisition-resolved-feed",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /search?q=xxx — search bots ──────────────────────────────────────────
app.get("/search", async (req, res) => {
  try {
    const token = await getFreshToken();
    const query = req.query.q || "";
    const response = await fetch(
      `https://bot-service-us1-65663778556.us-central1.run.app/v2/search?text=${encodeURIComponent(query)}&from_index=0&num_results=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    res.status(response.status).json(data);
    } catch (err) {
    res.status(500).json({ error: err.message });
  }
});  

// ── GET /image?url=... ──
app.get("/image", async (req, res) => {
  try {
    const imageUrl = decodeURIComponent(req.query.url);
    const response = await fetch(imageUrl);
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/", (req, res) => res.json({ status: "Chai Proxy running (mobile API)" }));

if (require.main === module) {
  app.listen(3001, () => console.log("Chai Proxy running on http://localhost:3001"));
}
module.exports = app;