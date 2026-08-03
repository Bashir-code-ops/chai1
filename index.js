const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

// ── Website API (no regional blocks, no subscription checks) ──────────────────
// Instead of the mobile API which has regional paywall + anti-proxy detection,
// we use Chai's public website API which works from anywhere without restrictions.
// The only requirement: a valid Bearer token (Firebase JWT).

const WEBSITE_API_BASE = "https://www.chai-ai.com/api";

// You'll need to extract a Bearer token from chai-ai.com.
// Token format: eyJhbGciOiJSUzI1NiI... (Firebase JWT)
// Extract by: visiting chai-ai.com, opening DevTools → Network tab, sending a message,
// copying the "Authorization: Bearer ..." header value.
let authToken = null;

function setAuthToken(token) {
  authToken = token;
  console.log("✅ Auth token set");
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
    if (!authToken) {
      return res.status(401).json({ error: "Auth token not set. Use POST /token to set it." });
    }

    console.log("→ Sending message to conversation:", conversationId);
    const response = await fetch(`${WEBSITE_API_BASE}/conversations/${conversationId}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`,
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
      res.status(response.status).json(data);
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /token — set the auth token ─────────────────────────────────────────
app.post("/token", (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: "token is required in body" });
  }
  setAuthToken(token);
  res.json({ status: "Token set", token_preview: token.substring(0, 50) + "..." });
});

// ── GET /token — get current token ───────────────────────────────────────────
app.get("/token", (req, res) => {
  if (!authToken) {
    return res.status(401).json({ error: "No token set" });
  }
  res.json({ token: authToken });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ 
  status: "Chai Proxy running (website API)",
  note: "POST /token to set auth token, then POST /chat to send messages"
}));

if (require.main === module) {
  app.listen(3001, () => console.log("Chai Proxy running on http://localhost:3001"));
}
module.exports = app;