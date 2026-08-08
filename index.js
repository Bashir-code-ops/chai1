const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

// ── TRUE Hybrid: two SEPARATE Firebase projects/accounts ─────────────────────
// The mobile app and the website are different Firebase projects, even for the
// same Chai account — a token minted in one project is NOT valid in the other.
// So we keep two fully independent credential sets and token caches.
//
//   MOBILE credentials → feed / search / botinfo / image (unrestricted)
//   WEBSITE credentials → chat only (avoids bot-responder's regional block)

// ── Mobile credentials ─────────────────────────────────────────────────────
const MOBILE_API_KEY      = process.env.MOBILE_FIREBASE_API_KEY || "";
const MOBILE_UID          = process.env.MOBILE_CHAI_UID || "";
const MOBILE_REFRESH_TOKEN = process.env.MOBILE_REFRESH_TOKEN || "";

// ── Website credentials ─────────────────────────────────────────────────────
const WEBSITE_API_KEY      = process.env.WEBSITE_FIREBASE_API_KEY || "";
const WEBSITE_UID          = process.env.WEBSITE_CHAI_UID || "";
const WEBSITE_REFRESH_TOKEN = process.env.WEBSITE_REFRESH_TOKEN || "";

const WEBSITE_API_BASE = "https://www.chai-ai.com/api";

for (const [name, val] of Object.entries({
  MOBILE_API_KEY, MOBILE_UID, MOBILE_REFRESH_TOKEN,
  WEBSITE_API_KEY, WEBSITE_UID, WEBSITE_REFRESH_TOKEN,
})) {
  if (!val) console.warn(`⚠️  ${name} is not set`);
}

// ── Generic token-cache factory — one instance per credential set ────────────
function createTokenGetter(label, apiKey, refreshToken) {
  let cachedToken = null;
  let tokenExpiry = 0;

  return async function getFreshToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
    if (!apiKey || !refreshToken) {
      throw new Error(`${label}: API key / refresh token not configured on the proxy.`);
    }

    console.log(`Refreshing ${label} Firebase token...`);
    const res = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
      }
    );
    const data = await res.json();
    if (!data.id_token) {
      throw new Error(`${label} token refresh failed: ` + JSON.stringify(data));
    }

    cachedToken = data.id_token;
    tokenExpiry = Date.now() + 3500 * 1000; // 58 minutes
    console.log(`✅ ${label} Firebase token refreshed`);
    return cachedToken;
  };
}

const getMobileToken  = createTokenGetter("MOBILE", MOBILE_API_KEY, MOBILE_REFRESH_TOKEN);
const getWebsiteToken = createTokenGetter("WEBSITE", WEBSITE_API_KEY, WEBSITE_REFRESH_TOKEN);

// ── GET /feed (mobile API) ──────────────────────────────────────────────────
app.get("/feed", async (req, res) => {
  try {
    const token = await getMobileToken();
    const response = await fetch(
      "https://chai-feed-service-65663778556.us-central1.run.app/feeds/strict-or-lax-acquisition-resolved-feed",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const text = await response.text();
    console.log(`[/feed] upstream status: ${response.status}`);
    if (!response.ok) {
      console.error(`[/feed] upstream body: ${text.substring(0, 500)}`);
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

// ── GET /search (mobile API) ────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  try {
    const token = await getMobileToken();
    const query = req.query.q || "";
    const response = await fetch(
      `https://bot-service-us1-65663778556.us-central1.run.app/v2/search?text=${encodeURIComponent(query)}&limit=20&offset=${req.query.offset || 0}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const text = await response.text();
    console.log(`[/search] q="${query}" upstream status: ${response.status}`);
    if (!response.ok) {
      console.error(`[/search] upstream body: ${text.substring(0, 500)}`);
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

// ── GET /botinfo/:botId (mobile API) ──────────────────────────────────────────
app.get("/botinfo/:botId", async (req, res) => {
  try {
    const token = await getMobileToken();
    const response = await fetch(
      `https://bot-service-us1-65663778556.us-central1.run.app/v2/chatbots/${req.params.botId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const text = await response.text();
    console.log(`[/botinfo] botId=${req.params.botId} upstream status: ${response.status}`);
    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream bot service failed with status ${response.status}`, upstreamBody: text.substring(0, 500) });
    }
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(502).json({ error: "Upstream bot service returned non-JSON response" });
    }
  } catch (err) {
    console.error("[/botinfo] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /image (proxy bot images — no auth needed) ────────────────────────────
app.get("/image", async (req, res) => {
  try {
    const imageUrl = decodeURIComponent(req.query.url);
    const response = await fetch(imageUrl, { redirect: "follow" });
    console.log(`[/image] fetching: ${imageUrl}, status: ${response.status}`);
    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream image fetch failed with status ${response.status}` });
    }
    const contentType = response.headers.get("content-type") || "";
    const definitelyNotImage = /^(text\/|application\/json|application\/xml)/i.test(contentType);
    if (definitelyNotImage) {
      return res.status(502).json({ error: `Upstream did not return an image (content-type: ${contentType})` });
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

// ── POST /chat (WEBSITE API, website credentials — no regional block) ────────
app.post("/chat", async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }

    // The frontend may send a conversationId built with a DIFFERENT account's
    // UID (e.g. the mobile account), since it doesn't know /chat now runs on
    // the website account behind the scenes. Auto-correct the UID prefix so
    // callers never need to worry about which account is actually used here.
    // Conversation IDs look like: "<uid>__bot_<botId>_<timestamp>"
    let safeConversationId = conversationId;
    const botMarkerIndex = conversationId.indexOf("__bot_");
    if (botMarkerIndex !== -1) {
      const currentUid = conversationId.substring(0, botMarkerIndex);
      if (currentUid !== WEBSITE_UID) {
        safeConversationId = WEBSITE_UID + conversationId.substring(botMarkerIndex);
        console.log(`↻ Rewrote conversationId UID: ${currentUid} → ${WEBSITE_UID}`);
      }
    }

    const token = await getWebsiteToken();
    console.log("→ Sending to website API:", safeConversationId);
    const response = await fetch(`${WEBSITE_API_BASE}/conversations/${safeConversationId}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ content: message || "" }),
    });

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

// ── GET /token/mobile and /token/website — debug helpers ─────────────────────
app.get("/token/mobile", async (req, res) => {
  try {
    const token = await getMobileToken();
    res.json({ token, uid: MOBILE_UID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/token/website", async (req, res) => {
  try {
    const token = await getWebsiteToken();
    res.json({ token, uid: WEBSITE_UID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status: "Chai Proxy running (true hybrid: separate mobile + website credentials)",
  note: "Feed/search/botinfo use MOBILE credentials. Chat uses WEBSITE credentials.",
  configured: {
    mobile: { api_key: !!MOBILE_API_KEY, uid: !!MOBILE_UID, refresh_token: !!MOBILE_REFRESH_TOKEN },
    website: { api_key: !!WEBSITE_API_KEY, uid: !!WEBSITE_UID, refresh_token: !!WEBSITE_REFRESH_TOKEN },
  },
}));

if (require.main === module) {
  app.listen(3001, () => console.log("Chai Proxy running on http://localhost:3001"));
}
module.exports = app;