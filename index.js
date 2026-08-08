const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

// ── Hybrid Approach with Auto-Refresh ────────────────────────────────────────
// Mobile API: Feed, search, bot discovery
// Website API: Chat (using auto-refreshing Firebase JWT)

// ── Firebase Credentials (for both mobile and website API) ───────────────────
const FIREBASE_API_KEY = "AIzaSyDlCazdn_bziqDVwQkDroR8eK4GVaEHawU";
const CHAI_UID         = "o5YR55rHXBYiPTVt4Lx2rw9wu0q1";
const REFRESH_TOKEN    = "AMf-vBxCRi4zdN22KUr5zLBlEVieHi3bXJvTFg2Oy-yh0acOD3DE9_D1nK9Ehxt1LXMLQmgMa79xvT1Tbj5cpmrUxBQIIZz5etU9nCrhftZujMd_YK6HHjiq8S_g9JyIT_mcVvZCea0jVv-lBG3vsyUjDa-cf02w5TYtmuu5gHCrW6ZI4CzJoxEFTqrk0WaccvxsCLRUDCGE3xBzXzlUMgxpd3A0zxki864Mgd0-vkUtWh4pqneWOVqF037tQITPy7udR5e8w3Nf76IanVERzwmvrAQs4qZPgavr-OofpiA91fXwt9Xz3x6NUjW8zgxBVOsb9EN0Av4aY5hKkzRQUId6H0gGcxBcaC-YR5vFBPKYmbMl6SxD1sX_MKrf6R6zzn9PkLCAtNBzTcuWJjenL_hecLMvxB-UeWZygdohg4YuXDEHQ1E27VA";

// ── Website API Base ────────────────────────────────────────────────────────
const WEBSITE_API_BASE = "https://www.chai-ai.com/api";

// ── Token Cache (auto-refreshes) ────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getFreshToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  console.log("Refreshing Firebase token...");
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN }),
    }
  );
  const data = await res.json();
  if (!data.id_token) {
    throw new Error("Token refresh failed: " + JSON.stringify(data));
  }

  cachedToken = data.id_token;
  tokenExpiry = Date.now() + 3500 * 1000; // 58 minutes
  console.log("✅ Firebase token refreshed (auto)");
  return cachedToken;
}

// ── GET /feed (mobile API) ──────────────────────────────────────────────────
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

// ── GET /search (mobile API) ────────────────────────────────────────────────
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

// ── POST /chat (website API with auto-refreshing token) ──────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }

    const token = await getFreshToken(); // Auto-refreshes if needed

    console.log("→ Sending to website API:", conversationId);
    const response = await fetch(`${WEBSITE_API_BASE}/conversations/${conversationId}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
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

// ── GET /botinfo (mobile API) ───────────────────────────────────────────────
app.get("/botinfo/:botId", async (req, res) => {
  try {
    const token = await getFreshToken();
    const response = await fetch(
      `https://bot-service-us1-65663778556.us-central1.run.app/v2/chatbots/${req.params.botId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const text = await response.text();
    console.log(`[/botinfo] botId=${req.params.botId} upstream status: ${response.status}`);
    if (!response.ok) {
      return res.status(response.status).json({
        error: `Upstream bot service failed with status ${response.status}`,
      });
    }
    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch (parseErr) {
      res.status(502).json({ error: "Upstream bot service returned non-JSON response" });
    }
  } catch (err) {
    console.error("[/botinfo] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /image (proxy bot images) ───────────────────────────────────────────
app.get("/image", async (req, res) => {
  try {
    const imageUrl = decodeURIComponent(req.query.url);
    const response = await fetch(imageUrl, { redirect: "follow" });

    console.log(`[/image] fetching: ${imageUrl}`);
    console.log(`[/image] upstream status: ${response.status}`);

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Upstream image fetch failed with status ${response.status}`,
      });
    }

    const contentType = response.headers.get("content-type") || "";
    const definitelyNotImage = /^(text\/|application\/json|application\/xml)/i.test(contentType);
    if (definitelyNotImage) {
      return res.status(502).json({
        error: `Upstream did not return an image (content-type: ${contentType})`,
      });
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

// ── Health check ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ 
  status: "Chai Proxy running (hybrid with auto-refresh)",
  note: "Feed/search use mobile API. Chat uses website API with auto-refreshing Firebase JWT.",
  features: ["Feed", "Search", "Chat (no regional blocks)", "Bot info", "Image proxy"]
}));

if (require.main === module) {
  app.listen(3001, () => console.log("Chai Proxy running on http://localhost:3001"));
}
module.exports = app;