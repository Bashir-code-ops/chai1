const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

// ── Credentials ──────────────────────────────────────────────────────────────
const FIREBASE_API_KEY = "AIzaSyDlCazdn_bziqDVwQkDroR8eK4GVaEHawU";
const CHAI_UID         = "aBzTrfumzcgckMzHDhEOsX7ROdY2";
const REFRESH_TOKEN="AMf-vBzzxSfVrwrQbZxfQUgzAKMkpx2BXjtSryY2NlSjVIBkuItZUIkC3poO4HQE0ITGhrFANiyQVKJO81SAwXxKUL_9wNVAQW6d28YgG93lOoHkm3LL3DvuMIIv5JxOIrM2ZB7pYY5QDeRxl-yzidwVenyrWfASQmRqvC0tzK8Kudfv5BkM3L-C7ORrN3elceV0eDOAoDr2QMRtCRJK_jrRlendhQS2lK84c0y_cwRgnED10K2GVovqgOHTBISgk_Y_sCk4CoCtSIlCUoCUOiHD942PdH1uZ2baHysjymyQlLNbNsSe00rn8z3bDr4igwTtgd3I95wBT_y2h83AvtI8Bo6N6kLSLg1G9shJ3sWQ1Hc2h7pPfpKf77Y5s_txnjf4TWmGJLyAQFsfGz4Z9mbfk2154dXZZQ";
const BOT_RESPONDER    = "https://bot-responder-eu-shdxwd54ta-nw.a.run.app";

// ── US proxy (routes ONLY the /chat call through a proxied fetch) ────────────
// IMPORTANT: setGlobalDispatcher() affects ALL fetch calls on this server
// instance (Vercel reuses warm instances), which broke /feed, /search, and
// /image last time. This version creates a SEPARATE proxied fetch function
// that is only used for the one call to Chai's bot-responder, leaving the
// normal global `fetch` completely untouched for every other route.
const US_PROXY = "http://halxyrty:jwaaocr80yo2@191.96.254.138:6185/";
let scopedProxyFetch = null;

async function getScopedProxyFetch() {
  if (scopedProxyFetch) return scopedProxyFetch;
  const { ProxyAgent, fetch: undiciFetch } = await import('undici');
  const dispatcher = new ProxyAgent(US_PROXY);
  // Wrap undici's own fetch with the dispatcher baked in, so callers never
  // need to pass a `dispatcher` option themselves (which caused the earlier
  // version-mismatch bug).
  scopedProxyFetch = (url, options = {}) => undiciFetch(url, { ...options, dispatcher });
  console.log("✅ Scoped proxy fetch ready (not global)");
  return scopedProxyFetch;
}

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
      console.error(`[/feed] upstream failed with status ${response.status}, body: ${text.substring(0, 500)}`);
      return res.status(response.status).json({
        error: `Upstream feed service failed with status ${response.status}`,
        upstreamBody: text.substring(0, 500),
      });
    }
    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch (parseErr) {
      console.error(`[/feed] upstream returned non-JSON despite ${response.status}: ${text.substring(0, 500)}`);
      res.status(502).json({
        error: "Upstream feed service returned non-JSON response",
        upstreamBody: text.substring(0, 500),
      });
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
      console.error(`[/search] upstream failed with status ${response.status}, body: ${text.substring(0, 500)}`);
      return res.status(response.status).json({
        error: `Upstream search service failed with status ${response.status}`,
        upstreamBody: text.substring(0, 500),
      });
    }
    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch (parseErr) {
      console.error(`[/search] upstream returned non-JSON despite ${response.status}: ${text.substring(0, 500)}`);
      res.status(502).json({
        error: "Upstream search service returned non-JSON response",
        upstreamBody: text.substring(0, 500),
      });
    }
  } catch (err) {
    console.error("[/search] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /chat ────────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const { botId, message, conversationId } = req.body;
    if (!botId) {
      return res.status(400).json({ error: "botId is required" });
    }
    const token = await getFreshToken();
    const proxiedFetch = await getScopedProxyFetch();

    // Ignore any conversationId that doesn't belong to the current account
    // (e.g. left over in localStorage from a previously-used Chai account)
    const safeConversationId = conversationId && conversationId.includes(CHAI_UID)
      ? conversationId
      : `${CHAI_UID}_${botId}`;

    const payload = {
      user_uid:        CHAI_UID,
      bot_uid:         botId,
      conversation_id: safeConversationId,
      text:            message || "",
      model:           "default",
      guanaco:         false,
      remote_config_ids: [
        "",
        "default",
        "default",
        "default",
        "premium_30_ultra_70",
        "default",
        "20260727_compliance_ai_android_existing_users_gemma4_moderation_with_glm5_bo1_as_initial_messages_and_regex_and",
        "20260629_virtual_currency_new_users_and_baseline_and",
        "20260701_combined_ad_frequency_functions_test_new_users_messages_before_ad_by_volume",
        "ads_every_16_messages_for_us_users_rollout_signed_up_after_07182025_16_messages_per_ad",
        "0311_free_trial_temu_usa_rollout_and"
      ],
      user_state: {
        account_creation_timestamp: 1783642170503,
        location: "/",
        operating_system: "android",
        nsfw_enabled: true,
        app_version: "0.4.380",
        appsflyer_uid: "1785368765507-1823846103555474666",
        device_id: "1b1e812a7324824b",
        subscribed: false,
        ultra: false
      }
    };
    console.log("→ Sending to bot-responder:", JSON.stringify(payload));
    const response = await proxiedFetch(`${BOT_RESPONDER}/send_message`, {
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
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("Chat error:", err.message, err.cause || '');
    res.status(500).json({ error: err.message, cause: err.cause?.message || null });
  }
});

// ── POST /retry — regenerate the bot's last response ────────────────────────────
app.post("/retry", async (req, res) => {
  try {
    const { botId, message, conversationId } = req.body;
    if (!botId || !message || !conversationId) {
      return res.status(400).json({ error: "botId, message, and conversationId are required" });
    }
    const token = await getFreshToken();
    const proxiedFetch = await getScopedProxyFetch();
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
    const response = await proxiedFetch(`${BOT_RESPONDER}/retry_message`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    console.log("← Bot-responder retry status:", response.status);
    console.log("← Bot-responder retry body:", text.substring(0, 500));
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

// ── POST /edit — edit an existing message ────────────────────────────────────
app.post("/edit", async (req, res) => {
  try {
    const { botId, message, conversationId } = req.body;
    if (!botId || !message || !conversationId) {
      return res.status(400).json({ error: "botId, message, and conversationId are required" });
    }
    const token = await getFreshToken();
    const proxiedFetch = await getScopedProxyFetch();
    const safeConversationId = conversationId && conversationId.includes(CHAI_UID)
      ? conversationId
      : `${CHAI_UID}_${botId}`;
    const payload = {
      user_uid:        CHAI_UID,
      bot_uid:         botId,
      conversation_id: safeConversationId,
      text:            message,
    };
    console.log("→ Sending edit to bot-responder:", JSON.stringify(payload));
    const response = await proxiedFetch(`${BOT_RESPONDER}/edit_message`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
        "idempotency-key": require("crypto").randomUUID(),
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    console.log("← Bot-responder edit status:", response.status);
    console.log("← Bot-responder edit body:", text.substring(0, 500));
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

// ── DELETE /message — delete a specific message from a conversation ─────────────
app.delete("/message", async (req, res) => {
  try {
    const { conversationId, messageId } = req.body;
    if (!conversationId || !messageId) {
      return res.status(400).json({ error: "conversationId and messageId are required" });
    }
    const token = await getFreshToken();
    const proxiedFetch = await getScopedProxyFetch();
    const url = `https://bot-responder-eu-65663778556.europe-west2.run.app/${conversationId}/messages/${messageId}`;
    console.log("→ Deleting message:", url);
    const response = await proxiedFetch(url, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "idempotency-key": require("crypto").randomUUID(),
      },
    });
    const text = await response.text();
    console.log("← Delete status:", response.status);
    console.log("← Delete body:", text.substring(0, 500));
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

// ── POST /history — fetch conversation message history (paginate) ──────────────
app.post("/history", async (req, res) => {
  try {
    const { conversationId, limit, lastTs } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required" });
    }
    const token = await getFreshToken();
    const proxiedFetch = await getScopedProxyFetch();
    const url = `${BOT_RESPONDER}/${conversationId}/paginate`;
    const payload = {
      user_uid: CHAI_UID,
      limit: limit || 10,
      last_ts: lastTs || null,
    };
    console.log("→ Fetching history:", url, JSON.stringify(payload));
    const response = await proxiedFetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    console.log("← History status:", response.status);
    console.log("← History body:", text.substring(0, 800));
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

// ── PATCH /memory — save bot memory/backstory for a conversation ────────────────
app.patch("/memory", async (req, res) => {
  try {
    const { conversationId, backstory } = req.body;
    if (!conversationId || backstory === undefined) {
      return res.status(400).json({ error: "conversationId and backstory are required" });
    }
    const token = await getFreshToken();
    const proxiedFetch = await getScopedProxyFetch();
    const url = `${BOT_RESPONDER}/conversations/${conversationId}`;
    const payload = {
      user_uid: CHAI_UID,
      bot_config: { backstory },
    };
    console.log("→ Saving memory:", url, JSON.stringify(payload));
    const response = await proxiedFetch(url, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    console.log("← Memory save status:", response.status);
    console.log("← Memory save body:", text.substring(0, 500));
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

    console.log(`[/image] fetching: ${imageUrl}`);
    console.log(`[/image] upstream status: ${response.status}, content-type: ${response.headers.get("content-type")}`);

    if (!response.ok) {
      console.error(`[/image] upstream failed with status ${response.status} for ${imageUrl}`);
      return res.status(response.status).json({
        error: `Upstream image fetch failed with status ${response.status}`,
        url: imageUrl,
      });
    }

    const contentType = response.headers.get("content-type") || "";
    // Chai's own CDN (images.chai.ml) sometimes sends "application/octet-stream"
    // for genuinely valid images, so we can't strictly require an "image/" prefix.
    // Only reject content-types that are clearly NOT image data (html error pages, json, text).
    const definitelyNotImage = /^(text\/|application\/json|application\/xml)/i.test(contentType);
    if (definitelyNotImage) {
      console.error(`[/image] rejected non-image content-type "${contentType}" for ${imageUrl}`);
      return res.status(502).json({
        error: `Upstream did not return an image (content-type: ${contentType})`,
        url: imageUrl,
      });
    }

    const buffer = await response.arrayBuffer();
    // If upstream sent a generic/octet-stream type, force a sane image content-type
    // so the browser actually renders it instead of treating it as a download/blob.
    const outgoingContentType = contentType.startsWith("image/") ? contentType : "image/jpeg";
    res.setHeader("Content-Type", outgoingContentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("[/image] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /user/:userId — get creator profile ───────────────────────────────────
app.get("/user/:userId", async (req, res) => {
  try {
    const token = await getFreshToken();
    const response = await fetch(
      `https://chai-user-service-65663778556.us-central1.run.app/users/${req.params.userId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const text = await response.text();
    console.log(`[/user] userId=${req.params.userId} upstream status: ${response.status}`);
    if (!response.ok) {
      console.error(`[/user] upstream failed with status ${response.status}, body: ${text.substring(0, 500)}`);
      return res.status(response.status).json({
        error: `Upstream user service failed with status ${response.status}`,
        upstreamBody: text.substring(0, 500),
      });
    }
    try {
      const data = JSON.parse(text);
      res.status(response.status).json(data);
    } catch (parseErr) {
      console.error(`[/user] upstream returned non-JSON despite ${response.status}: ${text.substring(0, 500)}`);
      res.status(502).json({
        error: "Upstream user service returned non-JSON response",
        upstreamBody: text.substring(0, 500),
      });
    }
  } catch (err) {
    console.error("[/user] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /personas — list the user's saved personas ────────────────────────────
app.get("/personas", async (req, res) => {
  try {
    const token = await getFreshToken();
    const response = await fetch(
      "https://chai-user-service-65663778556.us-central1.run.app/personas",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const text = await response.text();
    console.log(`[/personas GET] upstream status: ${response.status}`);
    if (!response.ok) {
      console.error(`[/personas GET] upstream failed with status ${response.status}, body: ${text.substring(0, 500)}`);
      return res.status(response.status).json({
        error: `Upstream persona service failed with status ${response.status}`,
        upstreamBody: text.substring(0, 500),
      });
    }
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch (parseErr) {
      console.error(`[/personas GET] upstream returned non-JSON: ${text.substring(0, 500)}`);
      res.status(502).json({ error: "Upstream persona service returned non-JSON response" });
    }
  } catch (err) {
    console.error("[/personas GET] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /personas — create a new persona ──────────────────────────────────────
app.post("/personas", async (req, res) => {
  try {
    const { name, description, image_url } = req.body;
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }
    const token = await getFreshToken();
    const payload = {
      name,
      description: description || "",
      image_url: image_url || null,
      is_system_persona: false,
    };
    console.log("[/personas POST] creating:", JSON.stringify(payload));
    const response = await fetch(
      "https://chai-user-service-65663778556.us-central1.run.app/personas",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );
    const text = await response.text();
    console.log(`[/personas POST] upstream status: ${response.status}`);
    if (!response.ok) {
      console.error(`[/personas POST] upstream failed with status ${response.status}, body: ${text.substring(0, 500)}`);
      return res.status(response.status).json({
        error: `Upstream persona service failed with status ${response.status}`,
        upstreamBody: text.substring(0, 500),
      });
    }
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch (parseErr) {
      console.error(`[/personas POST] upstream returned non-JSON: ${text.substring(0, 500)}`);
      res.status(502).json({ error: "Upstream persona service returned non-JSON response" });
    }
  } catch (err) {
    console.error("[/personas POST] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /personas/default — set the active persona ───────────────────────────
app.patch("/personas/default", async (req, res) => {
  try {
    const { default_persona_id } = req.body;
    if (!default_persona_id) {
      return res.status(400).json({ error: "default_persona_id is required" });
    }
    const token = await getFreshToken();
    console.log("[/personas/default PATCH] setting default:", default_persona_id);
    const response = await fetch(
      "https://chai-user-service-65663778556.us-central1.run.app/personas/default",
      {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ default_persona_id }),
      }
    );
    const text = await response.text();
    console.log(`[/personas/default PATCH] upstream status: ${response.status}`);
    if (!response.ok) {
      console.error(`[/personas/default PATCH] upstream failed with status ${response.status}, body: ${text.substring(0, 500)}`);
      return res.status(response.status).json({
        error: `Upstream persona service failed with status ${response.status}`,
        upstreamBody: text.substring(0, 500),
      });
    }
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch (parseErr) {
      console.error(`[/personas/default PATCH] upstream returned non-JSON: ${text.substring(0, 500)}`);
      res.status(502).json({ error: "Upstream persona service returned non-JSON response" });
    }
  } catch (err) {
    console.error("[/personas/default PATCH] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Chai Proxy running (mobile API)" }));

if (require.main === module) {
  app.listen(3001, () => console.log("Chai Proxy running on http://localhost:3001"));
}
module.exports = app;