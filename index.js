const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

// ── Website API (no regional blocks, no subscription checks) ──────────────────
// Instead of the mobile API which has regional paywall + anti-proxy detection,
// we use Chai's public website API which works from anywhere without restrictions.
// The only requirement: a valid Bearer token (Firebase JWT), refreshed automatically.

const WEBSITE_API_BASE = "https://www.chai-ai.com/api";
const FIREBASE_REFRESH_URL = "https://securetoken.googleapis.com/v1/token";

// Firebase Web API key for chai-ai.com's project — from the `?key=` query param
// on the identitytoolkit.googleapis.com calls. Not a secret, safe to hardcode/env.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSy..."; // ← fill in

// ── In-memory token state ──────────────────────────────────────────────────────
// NOTE: On serverless platforms (Vercel), this only persists within a single
// warm instance — it is NOT guaranteed to survive between requests, since a
// new instance may spin up at any time. This is a best-effort cache; the real
// safety net is that /chat will auto-refresh whenever the API rejects a token,
// as long as a refreshToken is available. For fully reliable persistence across
// cold starts, move this state into Vercel KV, Redis, or a small DB table.
let authToken = null;      // current idToken (short-lived, ~1hr)
let refreshToken = null;   // long-lived refresh token
let tokenExpiresAt = null; // ms epoch timestamp when idToken expires

function setAuthToken(token, refresh, expiresInSeconds) {
  authToken = token;
  if (refresh) refreshToken = refresh;
  if (expiresInSeconds) {
    tokenExpiresAt = Date.now() + Number(expiresInSeconds) * 1000;
  }
  console.log("✅ Auth token set", tokenExpiresAt ? `(expires ${new Date(tokenExpiresAt).toISOString()})` : "");
}

// Refreshes the idToken using the stored refreshToken. Returns the new idToken.
async function refreshAuthToken() {
  if (!refreshToken) {
    throw new Error("No refresh token available. POST /token with a refreshToken first.");
  }
  if (!FIREBASE_API_KEY || FIREBASE_API_KEY === "AIzaSy...") {
    throw new Error("FIREBASE_API_KEY is not configured on the proxy.");
  }

  console.log("🔄 Refreshing auth token...");
  const response = await fetch(`${FIREBASE_REFRESH_URL}?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("❌ Refresh failed:", data);
    throw new Error(data.error?.message || "Token refresh failed");
  }

  // Firebase may rotate the refresh token — always store whatever comes back.
  setAuthToken(data.id_token, data.refresh_token, data.expires_in);
  return data.id_token;
}

// Returns a valid idToken, refreshing first if it's missing/near-expiry.
async function getValidToken() {
  const isExpiringSoon = tokenExpiresAt && Date.now() > tokenExpiresAt - 60_000; // 60s buffer
  if (!authToken || isExpiringSoon) {
    if (refreshToken) {
      return await refreshAuthToken();
    }
  }
  return authToken;
}

// Wraps a call to the Chai website API; if it comes back 401, refresh once and retry.
async function callChaiApi(url, options) {
  let token = await getValidToken();
  if (!token) {
    const err = new Error("No auth token available. POST /token first.");
    err.status = 401;
    throw err;
  }

  let response = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });

  if (response.status === 401 && refreshToken) {
    console.log("↻ Got 401, refreshing token and retrying once...");
    token = await refreshAuthToken();
    response = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
  }

  return response;
}

// ── GET /feed ─────────────────────────────────────────────────────────────────
app.get("/feed", async (req, res) => {
  try {
    // Website API doesn't have a feed endpoint, so return a placeholder
    res.json({
      error: "Feed not available via website API",
      note: "Use /search instead to find bots"
    });
  } catch (err) {
    console.error("[/feed] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /search?q=xxx ─────────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  try {
    // Website API doesn't have a search endpoint
    res.json({
      error: "Search not available via website API",
      note: "You need to find conversation IDs separately"
    });
  } catch (err) {
    console.error("[/search] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /chat — send message to a conversation ─────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }

    // Allow a token to be passed explicitly (header or body) as an override/fallback,
    // but normally getValidToken()/callChaiApi() handles refresh automatically.
    const headerToken = req.headers["authorization"]?.replace(/^Bearer\s+/i, "");
    const bodyToken = req.body.token;
    if (headerToken || bodyToken) {
      authToken = headerToken || bodyToken;
    }

    console.log("→ Sending message to conversation:", conversationId);
    const response = await callChaiApi(`${WEBSITE_API_BASE}/conversations/${conversationId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message || "" }),
    });

    const text = await response.text();
    console.log("← Website API status:", response.status);
    console.log("← Website API body:", text.substring(0, 500));

    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── POST /token — set the auth token / refresh token ─────────────────────────
// Body can include any of: { token, refreshToken, expiresIn }
// - token:        sets the current idToken directly
// - refreshToken: enables automatic refresh going forward
// - expiresIn:    seconds until `token` expires (defaults to 3600 if omitted)
app.post("/token", (req, res) => {
  const { token, refreshToken: rt, expiresIn } = req.body;
  if (!token && !rt) {
    return res.status(400).json({ error: "Provide at least `token` or `refreshToken` in body" });
  }
  setAuthToken(token || authToken, rt, expiresIn || (token ? 3600 : undefined));
  res.json({
    status: "Token set",
    token_preview: authToken ? authToken.substring(0, 50) + "..." : null,
    has_refresh_token: !!refreshToken,
    expires_at: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null,
  });
});

// ── GET /token — get current token state ─────────────────────────────────────
app.get("/token", (req, res) => {
  if (!authToken) {
    return res.status(401).json({ error: "No token set" });
  }
  res.json({
    token: authToken,
    has_refresh_token: !!refreshToken,
    expires_at: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null,
  });
});

// ── POST /token/refresh — force a manual refresh right now ───────────────────
app.post("/token/refresh", async (req, res) => {
  try {
    const newToken = await refreshAuthToken();
    res.json({
      status: "Token refreshed",
      token_preview: newToken.substring(0, 50) + "...",
      expires_at: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ 
  status: "Chai Proxy running (website API)",
  note: "POST /token with { token, refreshToken } once — /chat will auto-refresh from then on",
  token_state: {
    has_token: !!authToken,
    has_refresh_token: !!refreshToken,
    expires_at: tokenExpiresAt ? new Date(tokenExpiresAt).toISOString() : null,
  }
}));

if (require.main === module) {
  app.listen(3001, () => console.log("Chai Proxy running on http://localhost:3001"));
}
module.exports = app;