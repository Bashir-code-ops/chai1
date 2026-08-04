const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

// ── Credentials ──────────────────────────────────────────────────────────────
// Set these in Vercel → Settings → Environment Variables (do NOT hardcode in
// the repo). Fallback empty strings just make missing-config errors clearer.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "";
const CHAI_UID          = process.env.CHAI_UID || "";
const REFRESH_TOKEN     = process.env.CHAI_REFRESH_TOKEN || "";
const BOT_RESPONDER      = "https://bot-responder-eu-shdxwd54ta-nw.a.run.app";
const WEBSITE_API_BASE   = "https://www.chai-ai.com/api";

if (!FIREBASE_API_KEY) console.warn("⚠️  FIREBASE_API_KEY is not set");
if (!CHAI_UID) console.warn("⚠️  CHAI_UID is not set");
if (!REFRESH_TOKEN) console.warn("⚠️  CHAI_REFRESH_TOKEN is not set");

// ── Token cache (shared by BOTH the mobile API calls and the website /chat call) ─
// Same Firebase account, same idToken works for both — one refresh mechanism.
let cachedToken = null;
let tokenExpiry = 0;

async function getFreshToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (!REFRESH_TOKEN || !FIREBASE_API_KEY) {
    throw new Error("REFRESH_TOKEN / FIREBASE_API_KEY not configured on the proxy.");
  }
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

// ── GET /feed ─────────────────────────────────────────────────────────────────
app.get("/feed", async (req, res) => {
  try {
    const token = await getFreshToken();
    const response = await fetch(
      "https://chai-feed-service-65663778556.us-central1.run.app/feeds/strict-or-lax-acquisition-resolved-feed",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const text = await response.text();
    console.log(`[/feed] upstream status: ${response.status}`);
    if (!response.ok) {
      return res.status(response.status).json({
        error: `Upstream feed service failed with status ${response.status}`,
        upstreamBody: text.substring(0, 500),
      });
    }
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(502).json({ error: "Upstream feed service returned non-JSON response", upstreamBody: text.substring(0, 500) });
    }
  } catch (err) {
    console.error("[/feed] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /search?q=xxx ─────────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  try {
    const token = await getFreshToken();
    const query = req.query.q || "";
    const response = await fetch(
      `https://bot-service-us1-65663778556.us-central1.run.app/v2/search?text=${encodeURIComponent(query)}&limit=20&offset=${req.query.offset || 0}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const text = await response.text();
    console.log(`[/search] q="${query}" offset=${req.query.offset || 0} upstream status: ${response.status}`);
    if (!response.ok) {
      return res.status(response.status).json({
        error: `Upstream search service failed with status ${response.status}`,
        upstreamBody: text.substring(0, 500),
      });
    }
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(502).json({ error: "Upstream search service returned non-JSON response", upstreamBody: text.substring(0, 500) });
    }
  } catch (err) {
    console.error("[/search] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /chat — send message via the WEBSITE API (no regional block, no proxy needed) ─
app.post("/chat", async (req, res) => {
  try {
    const { conversationId, message, botId } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }

    const token = await getFreshToken();
    const send = () => fetch(`${WEBSITE_API_BASE}/conversations/${conversationId}/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: message || "" }),
    });

    console.log("→ Sending message via website API to conversation:", conversationId);
    let response = await send();

    if (response.status === 401) {
      console.log("↻ Got 401, forcing token refresh and retrying once...");
      cachedToken = null;
      await getFreshToken();
      response = await send();
    }

    const text = await response.text();
    console.log("← Website API status:", response.status);
    console.log("← Website API body:", text.substring(0, 500));

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

// ── POST /retry — regenerate the bot's last response (mobile API) ────────────
app.post("/retry", async (req, res) => {
  try {
    const { botId, message, conversationId } = req.body;
    if (!botId || !message || !conversationId) {
      return res.status(400).json({ error: "botId, message, and conversationId are required" });
    }
    const token = await getFreshToken();
    const safeConversationId = conversationId && conversationId.includes(CHAI_UID)
      ? conversationId
      : `${CHAI_UID}_${botId}`;
    const payload = {
      user_uid:        CHAI_UID,
      bot_uid:         botId,
      conversation_id: safeConversationId,
      text:            message,
      model:           "chai_v2",
    };
    console.log("→ Sending retry to bot-responder:", JSON.stringify(payload));
    const response = await fetch(`${BOT_RESPONDER}/retry_message`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    console.log("← Bot-responder retry status:", response.status);
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("Retry error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /edit — edit an existing message (mobile API) ───────────────────────
app.post("/edit", async (req, res) => {
  try {
    const { botId, message, conversationId } = req.body;
    if (!botId || !message || !conversationId) {
      return res.status(400).json({ error: "botId, message, and conversationId are required" });
    }
    const token = await getFreshToken();
    const safeConversationId = conversationId && conversationId.includes(CHAI_UID)
      ? conversationId
      : `${CHAI_UID}_${botId}`;
    const payload = {
      user_uid:        CHAI_UID,
      bot_uid:         botId,
      conversation_id: safeConversationId,
      text:            message,
    };
    const response = await fetch(`${BOT_RESPONDER}/edit_message`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "idempotency-key": require("crypto").randomUUID(),
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    console.log("← Bot-responder edit status:", response.status);
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("Edit error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /message — delete a specific message (mobile API) ─────────────────
app.delete("/message", async (req, res) => {
  try {
    const { conversationId, messageId } = req.body;
    if (!conversationId || !messageId) {
      return res.status(400).json({ error: "conversationId and messageId are required" });
    }
    const token = await getFreshToken();
    const url = `https://bot-responder-eu-65663778556.europe-west2.run.app/${conversationId}/messages/${messageId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "idempotency-key": require("crypto").randomUUID(),
      },
    });
    const text = await response.text();
    console.log("← Delete status:", response.status);
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("Delete error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /history — fetch conversation message history (mobile API) ─────────
app.post("/history", async (req, res) => {
  try {
    const { conversationId, limit, lastTs } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }
    const token = await getFreshToken();
    const url = `${BOT_RESPONDER}/${conversationId}/paginate`;
    const payload = { user_uid: CHAI_UID, limit: limit || 10, last_ts: lastTs || null };
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    console.log("← History status:", response.status);
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("History error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /memory — save bot memory/backstory for a conversation (mobile API) ─
app.patch("/memory", async (req, res) => {
  try {
    const { conversationId, backstory } = req.body;
    if (!conversationId || backstory === undefined) {
      return res.status(400).json({ error: "conversationId and backstory are required" });
    }
    const token = await getFreshToken();
    const url = `${BOT_RESPONDER}/conversations/${conversationId}`;
    const payload = { user_uid: CHAI_UID, bot_config: { backstory } };
    const response = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    console.log("← Memory save status:", response.status);
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("Memory save error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /token ────────────────────────────────────────────────────────────────
app.get("/token", async (req, res) => {
  try {
    const token = await getFreshToken();
    res.json({ token, uid: CHAI_UID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /image?url=... ────────────────────────────────────────────────────────
app.get("/image", async (req, res) => {
  try {
    const imageUrl = decodeURIComponent(req.query.url);
    const response = await fetch(imageUrl, { redirect: "follow" });
    console.log(`[/image] fetching: ${imageUrl}, status: ${response.status}`);
    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream image fetch failed with status ${response.status}`, url: imageUrl });
    }
    const contentType = response.headers.get("content-type") || "";
    const definitelyNotImage = /^(text\/|application\/json|application\/xml)/i.test(contentType);
    if (definitelyNotImage) {
      return res.status(502).json({ error: `Upstream did not return an image (content-type: ${contentType})`, url: imageUrl });
    }
    const buffer = await response.arrayBuffer();
    const outgoingContentType = contentType.startsWith("image/") ? contentType : "image/jpeg";
    res.setHeader("Content-Type", outgoingContentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("[/image] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /user/:userId — get creator profile (mobile API) ─────────────────────
app.get("/user/:userId", async (req, res) => {
  try {
    const token = await getFreshToken();
    const response = await fetch(
      `https://chai-user-service-65663778556.us-central1.run.app/users/${req.params.userId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const text = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream user service failed with status ${response.status}`, upstreamBody: text.substring(0, 500) });
    }
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(502).json({ error: "Upstream user service returned non-JSON response" });
    }
  } catch (err) {
    console.error("[/user] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /personas — list saved personas (mobile API) ──────────────────────────
app.get("/personas", async (req, res) => {
  try {
    const token = await getFreshToken();
    const response = await fetch(
      "https://chai-user-service-65663778556.us-central1.run.app/personas",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const text = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream persona service failed with status ${response.status}`, upstreamBody: text.substring(0, 500) });
    }
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(502).json({ error: "Upstream persona service returned non-JSON response" });
    }
  } catch (err) {
    console.error("[/personas GET] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /personas — create a new persona (mobile API) ────────────────────────
app.post("/personas", async (req, res) => {
  try {
    const { name, description, image_url } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const token = await getFreshToken();
    const payload = { name, description: description || "", image_url: image_url || null, is_system_persona: false };
    const response = await fetch(
      "https://chai-user-service-65663778556.us-central1.run.app/personas",
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    );
    const text = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream persona service failed with status ${response.status}`, upstreamBody: text.substring(0, 500) });
    }
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(502).json({ error: "Upstream persona service returned non-JSON response" });
    }
  } catch (err) {
    console.error("[/personas POST] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /personas/default — set active persona (mobile API) ────────────────
app.patch("/personas/default", async (req, res) => {
  try {
    const { default_persona_id } = req.body;
    if (!default_persona_id) return res.status(400).json({ error: "default_persona_id is required" });
    const token = await getFreshToken();
    const response = await fetch(
      "https://chai-user-service-65663778556.us-central1.run.app/personas/default",
      { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ default_persona_id }) }
    );
    const text = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream persona service failed with status ${response.status}`, upstreamBody: text.substring(0, 500) });
    }
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(502).json({ error: "Upstream persona service returned non-JSON response" });
    }
  } catch (err) {
    console.error("[/personas/default PATCH] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status: "Chai Proxy running (mobile API + website API for chat)",
  configured: {
    firebase_api_key: !!FIREBASE_API_KEY,
    chai_uid: !!CHAI_UID,
    refresh_token: !!REFRESH_TOKEN,
  },
}));

if (require.main === module) {
  app.listen(3001, () => console.log("Chai Proxy running on http://localhost:3001"));
}
module.exports = app;