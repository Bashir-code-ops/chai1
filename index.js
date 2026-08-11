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
      // NEVER log `data` directly — it contains a live refresh_token and
      // id_token in plaintext. Log only non-sensitive shape info.
      if (!data.id_token) {
        console.error(`🔄 ${label} token refresh response had no id_token. Keys present:`, Object.keys(data));
        throw new Error(`${label} token refresh failed (no id_token returned)`);
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

// Shared bot-info fetch, used by both the /botinfo route and the
// conversation-init logic below (which needs bot_name/bot_uid to satisfy
// the website API's create-conversation validation).
async function fetchBotInfo(botId) {
  const token = await getMobileToken();
  const response = await fetch(
    `https://bot-service-us1-65663778556.us-central1.run.app/v2/chatbots/${botId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`bot-service returned ${response.status}: ${text.substring(0, 300)}`);
  }
  return JSON.parse(text);
}

// ── GET /botinfo/:botId (mobile API) ──────────────────────────────────────────
app.get("/botinfo/:botId", async (req, res) => {
  try {
    const info = await fetchBotInfo(req.params.botId);
    console.log(`[/botinfo] botId=${req.params.botId} upstream ok`);
    res.json(info);
  } catch (err) {
    console.error("[/botinfo] error:", err.message);
    res.status(502).json({ error: err.message });
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

// Hits the endpoint that "opens" a brand-new conversation on the website side
// before the first /send — mirrors what a real browser does when a chat
// window is first opened, so the conversation exists server-side before we
// try to post a message into it.
function initHeaders(token, convId) {
  return {
    Authorization: `Bearer ${token}`,
    Origin: "https://www.chai-ai.com",
    Referer: `https://www.chai-ai.com/chat/${convId}`,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
}

const GOT_OPTS = {
  responseType: "text",
  throwHttpErrors: false,
  headerGeneratorOptions: {
    browsers: [{ name: "chrome", minVersion: 120 }],
    devices: ["desktop"],
    operatingSystems: ["windows"],
  },
};

// Website-side persona lookup — mobile /botinfo 404'd for this bot id in
// testing, so bot metadata (real name, greeting/first_message) likely needs
// to come from the website's own API instead of the mobile bot-service.
async function fetchPersonaPrefill(token, botId, convId) {
  const { gotScraping } = await import("got-scraping");
  const resp = await gotScraping.get(`${WEBSITE_API_BASE}/persona/prefill`, {
    searchParams: { bot_id: botId, bot_uid: botId },
    headers: initHeaders(token, convId),
    ...GOT_OPTS,
  });
  console.log(`🔎 persona/prefill?bot_id=${botId}&bot_uid=${botId} -> ${resp.statusCode} | body: ${resp.body}`);
  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    throw new Error(`persona/prefill returned ${resp.statusCode}`);
  }
  return JSON.parse(resp.body);
}

// Creates a brand-new conversation before the first /send. Chai's backend
// requires conversation_id, bot_id, bot_uid, bot_name, and first_message,
// and — critically — does NOT honor the conversation_id we send; it mints
// its own (different format) and returns it. Every /send afterward MUST use
// that real id, not the one we constructed, or it 500s.
async function initializeConversation(accountIndex, botId, convId, userMessage) {
  const account = WEBSITE_ACCOUNTS[accountIndex];
  const token = await websiteTokenGetters[accountIndex]();
  const { gotScraping } = await import("got-scraping"); // ESM-only package

  // Look up bot metadata from both sources concurrently — persona/prefill
  // and mobile botInfo each 4xx/5xx independently depending on the bot, so
  // we try both and use whichever succeeds.
  const [personaResult, botInfoResult] = await Promise.allSettled([
    fetchPersonaPrefill(token, botId, convId),
    fetchBotInfo(botId),
  ]);
  const persona = personaResult.status === "fulfilled" ? personaResult.value : null;
  if (personaResult.status === "rejected") {
    console.error(`❌ fetchPersonaPrefill failed for ${botId}: ${personaResult.reason.message}`);
  }
  const botInfo = botInfoResult.status === "fulfilled" ? botInfoResult.value : null;
  if (botInfoResult.status === "rejected") {
    console.error(`❌ fetchBotInfo failed for ${botId}: ${botInfoResult.reason.message}`);
  } else {
    console.log(`🔎 botInfo for ${botId}:`, JSON.stringify(botInfo).substring(0, 800));
  }

  const botName = persona?.name || persona?.botName || botInfo?.name || botInfo?.botName || botInfo?.displayName || "Bot";
  const botUid = persona?.uid || persona?.creatorUid || botInfo?.uid || botInfo?.creatorUid || botInfo?.creator_uid || botId;
  const firstMessage =
    persona?.first_message || persona?.firstMessage || persona?.greeting || userMessage || "Hello!";

  try {
    const postResp = await gotScraping.post(`${WEBSITE_API_BASE}/conversations`, {
      headers: { ...initHeaders(token, convId), "Content-Type": "application/json" },
      json: {
        conversation_id: convId,
        bot_id: botId,
        bot_uid: botUid,
        bot_name: botName,
        first_message: firstMessage,
      },
      ...GOT_OPTS,
    });
    console.log(`🔎 init POST /conversations -> ${postResp.statusCode} | body: ${postResp.body}`);
    if (postResp.statusCode >= 200 && postResp.statusCode < 300) {
      let realId = null;
      try {
        realId = JSON.parse(postResp.body)?.conversation_id || null;
      } catch {
        // fall through with realId = null
      }
      if (realId && realId !== convId) {
        console.log(`↪️  Server assigned a different conversation_id: ${realId} (requested: ${convId})`);
      } else if (!realId) {
        console.error(`⚠️  2xx response had no parseable conversation_id — /send will likely still fail.`);
      }
      console.log(`✨ Conversation created via POST for account ${account.uid}`);
      return realId;
    } else {
      console.error(`❌ POST /conversations still not 2xx for ${convId} (status ${postResp.statusCode}).`);
      return null;
    }
  } catch (e) {
    console.error(`❌ init POST threw for ${convId}: ${e.message}`);
    return null;
  }
}

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
      try {
        const { gotScraping } = await import("got-scraping"); // ESM-only package
        const gotResp = await gotScraping.post(`${WEBSITE_API_BASE}/conversations/${convId}/send`, {
          headers: { ...initHeaders(token, convId), "Content-Type": "application/json" },
          json: { content: message || "" },
          ...GOT_OPTS,
        });
        if (gotResp.statusCode >= 500) {
          const h = gotResp.headers || {};
          console.error(
            `🩺 /send 500 diag [acct ${accountIndex}] server=${h.server || "?"} content-type=${h["content-type"] || "?"} cf-ray=${h["cf-ray"] || "none"} x-vercel-id=${h["x-vercel-id"] || "none"}`
          );
        }
        return {
          resp: { status: gotResp.statusCode, ok: gotResp.statusCode >= 200 && gotResp.statusCode < 300 },
          bodyText: gotResp.body,
        };
      } catch (gotErr) {
        console.error(`got-scraping request failed for account [${accountIndex}]:`, gotErr.message);
        return { resp: { status: 500, ok: false }, bodyText: `got-scraping error: ${gotErr.message}` };
      }
    }

    function isMessageLimitError(bodyText) {
      try {
        const errCode = JSON.parse(bodyText)?.detail?.error || "";
        return errCode.startsWith("message_limit_reached");
      } catch {
        return false;
      }
    }

    let response, text, usedAccountIndex, finalConversationId;

    for (let i = 0; i < WEBSITE_ACCOUNTS.length; i++) {
      const account = WEBSITE_ACCOUNTS[i];
      let convId;

      if (!botId) {
        convId = conversationId;
      } else if (account.uid === originalUid) {
        convId = conversationId;
      } else {
        const cacheKey = `${i}:${botId}`;
        const existingId = accountBotConversations.get(cacheKey);
        if (existingId) {
          convId = existingId;
        } else {
          const requestedId = `${account.uid}__bot_${botId}_${Date.now()}`;
          console.log(`🆕 New conversation detected. Initializing...`);
          const realId = await initializeConversation(i, botId, requestedId, message);
          convId = realId || requestedId;
          accountBotConversations.set(cacheKey, convId);
        }
      }

      console.log(`→ Trying website account [${i}] (${account.uid}) for conversation:`, convId);
      const result = await sendAs(i, convId);
      response = result.resp;
      text = result.bodyText;

      if (response.status !== 429 && response.status !== 500) {
        usedAccountIndex = i;
        finalConversationId = convId;
        break;
      }
      if (response.status === 429 && !isMessageLimitError(text)) {
        usedAccountIndex = i;
        finalConversationId = convId;
        break;
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
      parsed._accountIndex = usedAccountIndex;
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
  status: "Chai Proxy running (true hybrid, multi-account chat fallback, auto-init new conversations)",
  note: "Feed/search/botinfo use MOBILE credentials. Chat rotates across WEBSITE_ACCOUNTS on daily rate limit, and auto-creates conversations that don't exist yet.",
  configured: {
    mobile: { api_key: !!MOBILE_API_KEY, uid: !!MOBILE_UID, refresh_token: !!MOBILE_REFRESH_TOKEN },
    website: { api_key: !!WEBSITE_API_KEY, accounts: WEBSITE_ACCOUNTS.length, uids: WEBSITE_ACCOUNTS.map(a => a.uid) },
  },
}));

if (require.main === module) {
  app.listen(3001, () => console.log("Chai Proxy running on http://localhost:3001"));
}
module.exports = app;