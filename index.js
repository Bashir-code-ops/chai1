const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

// ── Hybrid Approach ──────────────────────────────────────────────────────────
// Mobile API: Feed, search, bot discovery (works fine, no regional issues)
// Website API: Chat messages (no regional blocks, paywall is UI-only)

// ── Mobile API Credentials ───────────────────────────────────────────────────
const FIREBASE_API_KEY = "AIzaSyDlCazdn_bziqDVwQkDroR8eK4GVaEHawU";
const CHAI_UID         = "5UjcH6R0zWYwzLciAX7lz9F3Sz02";
const REFRESH_TOKEN    = "AMf-vBxABjgCQ0SoRCymcdUbckokYPr9aPJ7-zsy6cFeXMioykMeSSGJiF4Vpi1tqic6HqzfaTmNWDPAo1Z-WBAEFGAuY_tGRt_fyujgs4zhwj7FnvFIp-ZKWM4RsX8sO5qwVZ6gRVFn5eo8kehreZbOCblhhqMMqgaR-EgI_whH4uVWONzzR_QqZnOfWA_yRrEuxAQy4YwoA6znvXbLNz-v21MJbhrzLQiZ6Vc--XuUWqD9Z09f5W2KLfU-8Zq96LPygwE2LS-BLQCqrLCxFzQEVOLRH_422e68fhEbmwv3cvJitPo3LoPas1VO4XCAvULjjT0HC6SjbG6ko03H1VW-NOCCbOTpmlXfrvIUVO-g0bcCsCYLZIL0WMgz5V9PvJ1LYPz4QKBv";

// ── Website API Credentials ──────────────────────────────────────────────────
const WEBSITE_API_BASE = "https://www.chai-ai.com/api";
let websiteAuthToken = null;

function setWebsiteAuthToken(token) {
  websiteAuthToken = token;
  console.log("✅ Website auth token set");
}

// ── Mobile API Token Cache ───────────────────────────────────────────────────
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
  console.log("✅ Mobile API token refreshed");
  return cachedToken;
}

// ── GET /feed (mobile API) ───────────────────────────────────────────────────
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
      });
    }
    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch (parseErr) {
      res.status(502).json({ error: "Upstream feed service returned non-JSON response" });
    }
  } catch (err) {
    console.error("[/feed] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /search (mobile API) ─────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  try {
    const token = await getFreshToken();
    const query = req.query.q || "";
    const response = await fetch(
      `https://bot-service-us1-65663778556.us-central1.run.app/v2/search?text=${encodeURIComponent(query)}&limit=20&offset=${req.query.offset || 0}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const text = await response.text();
    console.log(`[/search] q="${query}" upstream status: ${response.status}`);
    if (!response.ok) {
      return res.status(response.status).json({
        error: `Upstream search service failed with status ${response.status}`,
      });
    }
    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch (parseErr) {
      res.status(502).json({ error: "Upstream search service returned non-JSON response" });
    }
  } catch (err) {
    console.error("[/search] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /chat (website API - no regional blocks) ──────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }
    if (!websiteAuthToken) {
      return res.status(401).json({ error: "Website auth token not set. Use POST /token to set it." });
    }

    console.log("→ Sending to website API:", conversationId);
    const response = await fetch(`${WEBSITE_API_BASE}/conversations/${conversationId}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${websiteAuthToken}`,
      },
      body: JSON.stringify({
        content: message || "",
      }),
    });

    const text = await response.text();
    console.log("← Website API status:", response.status);
    console.log("← Website API body:", text.substring(0, 500));

    try {
      const data = JSON.parse(text);
      // Always return the response, even if "refused": true
      // (the response text is still there, paywall is UI-only)
      res.status(response.status).json(data);
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /token (set website auth token) ─────────────────────────────────────
app.post("/token", (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: "token is required in body" });
  }
  setWebsiteAuthToken(token);
  res.json({ status: "Website auth token set", token_preview: token.substring(0, 50) + "..." });
});

// ── GET /token (get website auth token) ──────────────────────────────────────
app.get("/token", (req, res) => {
  if (!websiteAuthToken) {
    return res.status(401).json({ error: "No website auth token set" });
  }
  res.json({ token: websiteAuthToken });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ 
  status: "Chai Proxy running (hybrid)",
  note: "Feed/search use mobile API. Chat uses website API (no regional blocks).",
  setup: "POST /token to set website auth token from chai-ai.com"
}));

if (require.main === module) {
  app.listen(3001, () => console.log("Chai Proxy running on http://localhost:3001"));
}
module.exports = app;