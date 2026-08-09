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

// ── Website credentials — MULTIPLE accounts for automatic fallback ──────────
// Each website account has its own daily message cap (~4/day observed). When
// one account gets rate-limited, /chat automatically tries the next one.
//
// Set WEBSITE_ACCOUNTS as a JSON array in Vercel, e.g.:
// [{"uid":"o5YR55rHXBYiPTVt4Lx2rw9wu0q1","refreshToken":"AMf-vBz..."}, {"uid":"...","refreshToken":"..."}]
//
// All website accounts share the SAME Firebase project/API key (it's the same
// chai-ai.com app, just different logged-in users), so one key covers all of them.
const WEBSITE_API_KEY = process.env.WEBSITE_FIREBASE_API_KEY || "";
let WEBSITE_ACCOUNTS = [];
try {
  WEBSITE_ACCOUNTS = JSON.parse(process.env.WEBSITE_ACCOUNTS || "[]");
} catch (e) {
  console.error("❌ Failed to parse WEBSITE_ACCOUNTS env var as JSON:", e.message);
}

const WEBSITE_API_BASE = "https://www.chai-ai.com/api";

for (const [name, val] of Object.entries({
  MOBILE_API_KEY, MOBILE_UID, MOBILE_REFRESH_TOKEN, WEBSITE_API_KEY,
})) {
  if (!val) console.warn(`⚠️  ${name} is not set`);
}
if (WEBSITE_ACCOUNTS.length === 0) {
  console.warn("⚠️  WEBSITE_ACCOUNTS is empty or invalid — /chat will have no accounts to use");
} else {
  console.log(`ℹ️  Loaded ${WEBSITE_ACCOUNTS.length} website account(s) for /chat fallback`);
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

    console.log(`🔄 Refreshing ${label} token...`);
    try {
      const res = await fetch(
        `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
        }
      );
      const data = await res.json();
      console.log(`🔄 ${label} token refresh response:`, JSON.stringify(data));
      if (!data.id_token) {
        throw new Error(`${label} token refresh failed: ` + JSON.stringify(data));
      }

      cachedToken = data.id_token;
      tokenExpiry = Date.now() + 3500 * 1000; // 58 minutes
      console.log(`✅ ${label} Firebase token refreshed`);
      return cachedToken;
    } catch (error) {
      console.error(`❌ ${label} token refresh error:`, error.message, error.stack);
      throw error;
    }
  };
}

const getMobileToken = createTokenGetter("MOBILE", MOBILE_API_KEY, MOBILE_REFRESH_TOKEN);

// One independent token cache PER website account, so we're not re-minting
// tokens for an account we're not currently using.
const websiteTokenGetters = WEBSITE_ACCOUNTS.map((acct, i) =>
  createTokenGetter(`WEBSITE[${i}]:${acct.uid}`, WEBSITE_API_KEY, acct.refreshToken)
);

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

// Remembers which conversationId each (account, bot) pair is actually using,
// since each account gets its own timestamp when a conversation is created —
// reusing one account's timestamp for another account 500s (conversation
// doesn't exist for them). Best-effort, in-memory only (resets on cold start,
// but that's fine — a fresh conversationId gets created again automatically).
const accountBotConversations = new Map(); // key: "accountIndex:botId" -> conversationId

// ── POST /chat (WEBSITE API, rotates across multiple accounts on 429) ────────
app.post("/chat", async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }
    if (WEBSITE_ACCOUNTS.length === 0) {
      return res.status(500).json({ error: "No website accounts configured (WEBSITE_ACCOUNTS is empty)." });
    }

    // Extracts just the botId out of "<uid>__bot_<botId>_<timestamp>"
    function getBotId(convId) {
      const idx = convId.indexOf("__bot_");
      if (idx === -1) return null;
      const rest = convId.substring(idx + "__bot_".length); // "<botId>_<timestamp>"
      return rest.replace(/_\d+$/, "");
    }
    const botId = getBotId(conversationId);
    const originalUid = botId ? conversationId.substring(0, conversationId.indexOf("__bot_")) : null;

    async function sendAs(accountIndex, convId) {
      const account = WEBSITE_ACCOUNTS[accountIndex];
      const token = await websiteTokenGetters[accountIndex]();
      const resp = await fetch(`${WEBSITE_API_BASE}/conversations/${convId}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Origin: "https://www.chai-ai.com",
          Referer: `https://www.chai-ai.com/chat/${convId}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
        },
        body: JSON.stringify({ content: message || "" }),
      });
      const bodyText = await resp.text();
      return { resp, bodyText };
    }

    function isMessageLimitError(bodyText) {
      try {
        return JSON.parse(bodyText)?.detail?.error === "message_limit_reached";
      } catch {
        return false;
      }
    }

    let response, text, usedAccountIndex, finalConversationId;

    for (let i = 0; i < WEBSITE_ACCOUNTS.length; i++) {
      const account = WEBSITE_ACCOUNTS[i];
      let convId;

      if (!botId) {
        // Couldn't parse the format at all — just pass through as-is.
        convId = conversationId;
      } else if (account.uid === originalUid) {
        // This IS the account the conversationId was originally built for —
        // use it exactly as given.
        convId = conversationId;
      } else {
        // Different account: reuse a previously-established conversationId
        // for this (account, bot) pair if we have one, otherwise mint a
        // brand new one (new timestamp) — this account has never talked to
        // this bot under this ID before, so a borrowed timestamp won't exist.
        const cacheKey = `${i}:${botId}`;
        convId = accountBotConversations.get(cacheKey) || `${account.uid}__bot_${botId}_${Date.now()}`;
        accountBotConversations.set(cacheKey, convId);
      }

      console.log(`→ Trying website account [${i}] (${account.uid}) for conversation:`, convId);
      const result = await sendAs(i, convId);
      response = result.resp;
      text = result.bodyText;

      if (response.status !== 429 && response.status !== 500) {
        usedAccountIndex = i;
        finalConversationId = convId;
        break; // success, or a real (non-retryable) failure — stop trying more accounts
      }
      if (response.status === 429 && !isMessageLimitError(text)) {
        usedAccountIndex = i;
        finalConversationId = convId;
        break; // a 429 that ISN'T our rate-limit signature — treat as final
      }
      console.log(`↻ Account [${i}] (${account.uid}) failed (status ${response.status}), trying next account...`);
    }

    console.log("← Website API status:", response.status);
    console.log("← Website API body:", text.substring(0, 500));

    if (response.status === 429) {
      return res.status(429).json({
        error: "all_accounts_rate_limited",
        detail: `All ${WEBSITE_ACCOUNTS.length} configured account(s) have hit their daily message limit.`,
      });
    }

    try {
      const parsed = JSON.parse(text);
      if (finalConversationId !== conversationId) {
        parsed._newConversationId = finalConversationId;
      }
      parsed._accountIndex = usedAccountIndex; // useful for debugging/logging
      res.status(response.status).json(parsed);
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

app.get("/token/website/:index", async (req, res) => {
  try {
    const i = parseInt(req.params.index, 10);
    if (!WEBSITE_ACCOUNTS[i]) {
      return res.status(404).json({ error: `No website account at index ${i}. Have ${WEBSITE_ACCOUNTS.length} account(s).` });
    }
    const token = await websiteTokenGetters[i]();
    res.json({ token, uid: WEBSITE_ACCOUNTS[i].uid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({
  status: "Chai Proxy running (true hybrid, multi-account chat fallback)",
  note: "Feed/search/botinfo use MOBILE credentials. Chat rotates across WEBSITE_ACCOUNTS on daily rate limit.",
  configured: {
    mobile: { api_key: !!MOBILE_API_KEY, uid: !!MOBILE_UID, refresh_token: !!MOBILE_REFRESH_TOKEN },
    website: { api_key: !!WEBSITE_API_KEY, accounts: WEBSITE_ACCOUNTS.length, uids: WEBSITE_ACCOUNTS.map(a => a.uid) },
  },
}));

if (require.main === module) {
  app.listen(3001, () => console.log("Chai Proxy running on http://localhost:3001"));
}
module.exports = app;