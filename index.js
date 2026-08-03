const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

// ── Website API (no regional blocks, no subscription checks) ──────────────────
// We use Chai's public website API which works from anywhere without restrictions.
// Auth: a Firebase idToken (Bearer), minted fresh from a long-lived refreshToken
// on every request. This avoids relying on in-memory state, which does NOT
// reliably survive between requests on Vercel serverless (different instances,
// cold starts). The refreshToken itself is stable and set once as an env var.

const WEBSITE_API_BASE = "https://www.chai-ai.com/api";
const FIREBASE_REFRESH_URL = "https://securetoken.googleapis.com/v1/token";

// ── Configuration — set these in Vercel → Settings → Environment Variables ────
// FIREBASE_API_KEY:   the Firebase Web API key (from ?key=... on identitytoolkit calls)
// CHAI_REFRESH_TOKEN: your long-lived Google/Firebase refresh token (from login response)
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "";
let CHAI_REFRESH_TOKEN = process.env.CHAI_REFRESH_TOKEN || "";

if (!FIREBASE_API_KEY) console.warn("⚠️  FIREBASE_API_KEY is not set");
if (!CHAI_REFRESH_TOKEN) console.warn("⚠️  CHAI_REFRESH_TOKEN is not set");

// ── Per-invocation idToken cache ───────────────────────────────────────────────
// Best-effort only: helps when the same instance handles back-to-back requests
// (common in short bursts), but every request still checks expiry and refreshes
// if needed, so correctness never depends on this surviving.
let cachedIdToken = null;
let cachedExpiresAt = 0;

// Mints a fresh idToken from the refresh token. Updates the cache and, if
// Firebase rotates the refresh token, updates that too (in-memory only —
// see note below about rotation).
async function mintIdToken() {
  if (!CHAI_REFRESH_TOKEN) {
    const err = new Error("CHAI_REFRESH_TOKEN is not configured on the proxy.");
    err.status = 500;
    throw err;
  }
  if (!FIREBASE_API_KEY) {
    const err = new Error("FIREBASE_API_KEY is not configured on the proxy.");
    err.status = 500;
    throw err;
  }

  const response = await fetch(`${FIREBASE_REFRESH_URL}?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: CHAI_REFRESH_TOKEN,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("❌ Refresh failed:", data);
    const err = new Error(data.error?.message || "Token refresh failed");
    err.status = 401;
    throw err;
  }

  cachedIdToken = data.id_token;
  cachedExpiresAt = Date.now() + Number(data.expires_in) * 1000;

  // Firebase CAN rotate the refresh token. If it does, the new one only lives
  // in this instance's memory and will be lost on the next cold start — at
  // that point CHAI_REFRESH_TOKEN (the env var) gets used again. In practice
  // Google rarely rotates on a simple refresh_token grant, so this is a
  // low-probability edge case, but worth knowing about.
  if (data.refresh_token && data.refresh_token !== CHAI_REFRESH_TOKEN) {
    console.log("ℹ️  Refresh token rotated (in-memory only for this instance)");
    CHAI_REFRESH_TOKEN = data.refresh_token;
  }

  console.log("✅ Minted fresh idToken, expires", new Date(cachedExpiresAt).toISOString());
  return cachedIdToken;
}

// Returns a valid idToken — reuses the cache if it's still fresh for this
// instance, otherwise mints a new one via the refresh token.
async function getIdToken() {
  const stillFresh = cachedIdToken && Date.now() < cachedExpiresAt - 60_000; // 60s buffer
  if (stillFresh) return cachedIdToken;
  return await mintIdToken();
}

// Calls the Chai website API with a valid token; on 401, mints a fresh token
// once and retries (covers the case where Chai rejects a token we thought
// was still valid).
async function callChaiApi(url, options) {
  let token = await getIdToken();

  let response = await fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });

  if (response.status === 401) {
    console.log("↻ Got 401 from Chai API, minting fresh token and retrying once...");
    cachedIdToken = null; // force a real mint, not a cache hit
    token = await mintIdToken();
    response = await fetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
  }

  return response;
}

// ── GET /feed ─────────────────────────────────────────────────────────────────
app.get("/feed", async (req, res) => {
  res.json({
    error: "Feed not available via website API",
    note: "Use /search instead to find bots",
  });
});

// ── GET /search?q=xxx ─────────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  res.json({
    error: "Search not available via website API",
    note: "You need to find conversation IDs separately",
  });
});

// ── POST /chat — send message to a conversation ─────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
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

// ── GET /token — check current token state (debug) ───────────────────────────
app.get("/token", async (req, res) => {
  try {
    const token = await getIdToken();
    res.json({
      token_preview: token.substring(0, 50) + "...",
      expires_at: new Date(cachedExpiresAt).toISOString(),
      has_refresh_token: !!CHAI_REFRESH_TOKEN,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── POST /token/refresh — force a fresh mint right now (debug) ───────────────
app.post("/token/refresh", async (req, res) => {
  try {
    const token = await mintIdToken();
    res.json({
      status: "Token refreshed",
      token_preview: token.substring(0, 50) + "...",
      expires_at: new Date(cachedExpiresAt).toISOString(),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status: "Chai Proxy running (website API)",
  note: "Auth is fully automatic via CHAI_REFRESH_TOKEN env var — no manual token setting needed",
  configured: {
    firebase_api_key: !!FIREBASE_API_KEY,
    refresh_token: !!CHAI_REFRESH_TOKEN,
  },
}));

if (require.main === module) {
  app.listen(3001, () => console.log("Chai Proxy running on http://localhost:3001"));
}
module.exports = app;