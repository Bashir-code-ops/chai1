const express = require("express");
const cors = require("cors");
const app = express();
const crypto = require("crypto");
app.use(cors());
app.use(express.json());

// ================== BYPASS CONFIGURATION ==================
// Pool of multiple Firebase accounts (mobile + website)
const MOBILE_CREDENTIALS = [
  { apiKey: process.env.MOBILE_KEY_1 || "", uid: process.env.MOBILE_UID_1 || "", refreshToken: process.env.MOBILE_REFRESH_1 || "" },
  { apiKey: process.env.MOBILE_KEY_2 || "", uid: process.env.MOBILE_UID_2 || "", refreshToken: process.env.MOBILE_REFRESH_2 || "" },
  { apiKey: process.env.MOBILE_KEY_3 || "", uid: process.env.MOBILE_UID_3 || "", refreshToken: process.env.MOBILE_REFRESH_3 || "" },
];

const WEBSITE_CREDENTIALS = [
  { apiKey: process.env.WEBSITE_KEY_1 || "", uid: process.env.WEBSITE_UID_1 || "", refreshToken: process.env.WEBSITE_REFRESH_1 || "" },
  { apiKey: process.env.WEBSITE_KEY_2 || "", uid: process.env.WEBSITE_UID_2 || "", refreshToken: process.env.WEBSITE_REFRESH_2 || "" },
  { apiKey: process.env.WEBSITE_KEY_3 || "", uid: process.env.WEBSITE_UID_3 || "", refreshToken: process.env.WEBSITE_REFRESH_3 || "" },
];

// Proxy rotation pool (residential/mobile IPs)
const PROXY_LIST = process.env.PROXY_LIST ? process.env.PROXY_LIST.split(",") : [];
const USE_PROXY_ROTATION = PROXY_LIST.length > 0;

// ================== UTILITY FUNCTIONS ==================
// Random delays to mimic human behavior
const randomDelay = (min=100, max=3000) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min)) + min));

// Generate random request fingerprints
function generateFingerprint() {
  const devices = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 13; SM-S901U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];
  const languages = ['en-US,en;q=0.9', 'es-ES,es;q=0.8', 'fr-FR,fr;q=0.7', 'de-DE,de;q=0.6'];
  return {
    'User-Agent': devices[Math.floor(Math.random() * devices.length)],
    'Accept-Language': languages[Math.floor(Math.random() * languages.length)],
    'X-Client-Version': `chai-mobile/${Math.floor(Math.random() * 500) + 100}`,
    'X-Forwarded-For': `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
  };
}

// Rotating fetch with proxy support
async function rotatingFetch(url, options = {}) {
  await randomDelay(200, 1500); // Artificial delay
  
  const headers = { ...options.headers, ...generateFingerprint() };
  
  // Proxy rotation logic
  if (USE_PROXY_ROTATION && Math.random() > 0.7) { // 30% chance to use proxy
    const proxy = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
    const [proxyHost, proxyPort] = proxy.split(':');
    const HttpsProxyAgent = require('https-proxy-agent');
    options.agent = new HttpsProxyAgent(`http://${proxyHost}:${proxyPort}`);
    console.log(`↻ Using proxy: ${proxyHost}:${proxyPort}`);
  }
  
  return fetch(url, { ...options, headers });
}

// ================== TOKEN MANAGEMENT ==================
const tokenCache = new Map();

async function getFreshToken(credentialSet, label) {
  const { apiKey, refreshToken } = credentialSet;
  const cacheKey = `${label}_${apiKey}_${refreshToken}`;
  
  if (tokenCache.has(cacheKey)) {
    const { token, expiry } = tokenCache.get(cacheKey);
    if (Date.now() < expiry) return token;
  }
  
  console.log(`🔄 Refreshing ${label} token for UID: ${credentialSet.uid.substring(0, 8)}...`);
  
  try {
    const res = await rotatingFetch(
      `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
      }
    );
    
    const data = await res.json();
    if (!data.id_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
    
    const token = data.id_token;
    const expiry = Date.now() + 3000 * 1000; // 50 minutes
    tokenCache.set(cacheKey, { token, expiry, credentialSet });
    
    console.log(`✅ ${label} token refreshed for UID: ${credentialSet.uid.substring(0, 8)}`);
    return token;
  } catch (error) {
    console.error(`❌ ${label} token refresh error:`, error.message);
    throw error;
  }
}

// Credential rotation with load balancing
function getRotatedCredential(credentialPool, routeType) {
  if (credentialPool.length === 0) throw new Error(`No ${routeType} credentials configured`);
  
  // Simple round-robin with some randomness
  const index = Math.floor(Math.random() * credentialPool.length);
  const cred = credentialPool[index];
  
  // Log rotation for debugging
  console.log(`🔄 ${routeType} using credential ${index + 1}/${credentialPool.length} (UID: ${cred.uid.substring(0, 8)}...)`);
  
  return cred;
}

// ================== MODIFIED ROUTES ==================
// GET /feed with rotation
app.get("/feed", async (req, res) => {
  try {
    const cred = getRotatedCredential(MOBILE_CREDENTIALS, "MOBILE");
    const token = await getFreshToken(cred, "MOBILE");
    
    const response = await rotatingFetch(
      "https://chai-feed-service-65663778556.us-central1.run.app/feeds/strict-or-lax-acquisition-resolved-feed",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    
    const text = await response.text();
    console.log(`[/feed] status: ${response.status}, UID: ${cred.uid.substring(0, 8)}...`);
    
    if (!response.ok) {
      // If failed, try with another credential immediately
      console.warn(`[/feed] Failed with UID ${cred.uid.substring(0, 8)}..., rotating...`);
      const backupCred = getRotatedCredential(MOBILE_CREDENTIALS.filter(c => c.uid !== cred.uid), "MOBILE_BACKUP");
      const backupToken = await getFreshToken(backupCred, "MOBILE_BACKUP");
      
      const backupResponse = await rotatingFetch(
        "https://chai-feed-service-65663778556.us-central1.run.app/feeds/strict-or-lax-acquisition-resolved-feed",
        { headers: { Authorization: `Bearer ${backupToken}` } }
      );
      
      const backupText = await backupResponse.text();
      try {
        return res.status(backupResponse.status).json(JSON.parse(backupText));
      } catch {
        return res.status(backupResponse.status).send(backupText);
      }
    }
    
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("[/feed] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /search with rotation
app.get("/search", async (req, res) => {
  try {
    const cred = getRotatedCredential(MOBILE_CREDENTIALS, "MOBILE");
    const token = await getFreshToken(cred, "MOBILE");
    const query = req.query.q || "";
    
    const response = await rotatingFetch(
      `https://bot-service-us1-65663778556.us-central1.run.app/v2/search?text=${encodeURIComponent(query)}&limit=20&offset=${req.query.offset || 0}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    
    const text = await response.text();
    console.log(`[/search] q="${query}", status: ${response.status}, UID: ${cred.uid.substring(0, 8)}...`);
    
    if (!response.ok) {
      // Inject dummy request to obfuscate pattern
      await rotatingFetch(`https://bot-service-us1-65663778556.us-central1.run.app/v2/search?text=${encodeURIComponent("dummy")}&limit=1`, {
        headers: { Authorization: `Bearer ${token}` }
      }).catch(() => {});
    }
    
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("[/search] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /chat with website rotation
app.post("/chat", async (req, res) => {
  try {
    const { conversationId, message } = req.body;
    if (!conversationId) return res.status(400).json({ error: "conversationId required" });
    
    const cred = getRotatedCredential(WEBSITE_CREDENTIALS, "WEBSITE");
    const token = await getFreshToken(cred, "WEBSITE");
    
    // Auto-correct UID in conversationId
    let safeConversationId = conversationId;
    const botMarkerIndex = conversationId.indexOf("__bot_");
    if (botMarkerIndex !== -1) {
      const currentUid = conversationId.substring(0, botMarkerIndex);
      if (currentUid !== cred.uid) {
        safeConversationId = cred.uid + conversationId.substring(botMarkerIndex);
        console.log(`↻ Rewrote conversationId UID: ${currentUid.substring(0, 8)}... → ${cred.uid.substring(0, 8)}...`);
      }
    }
    
    console.log(`→ Chat to website API with UID: ${cred.uid.substring(0, 8)}...`);
    const response = await rotatingFetch(
      `https://www.chai-ai.com/api/conversations/${safeConversationId}/send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: message || "" }),
      }
    );
    
    const text = await response.text();
    console.log(`← Chat status: ${response.status}, UID: ${cred.uid.substring(0, 8)}...`);
    
    try {
      res.status(response.status).json(JSON.parse(text));
    } catch {
      res.status(response.status).send(text);
    }
  } catch (err) {
    console.error("[/chat] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================== DUMMY TRAFFIC GENERATOR ==================
// Generate noise to mask your real traffic pattern
setInterval(() => {
  if (MOBILE_CREDENTIALS.length > 0 && Math.random() > 0.5) {
    const cred = MOBILE_CREDENTIALS[Math.floor(Math.random() * MOBILE_CREDENTIALS.length)];
    getFreshToken(cred, "DUMMY").then(token => {
      // Make dummy requests to various endpoints
      const dummyEndpoints = [
        "https://bot-service-us1-65663778556.us-central1.run.app/v2/search?text=dummy&limit=1",
        "https://chai-feed-service-65663778556.us-central1.run.app/feeds/strict-or-lax-acquisition-resolved-feed?limit=1"
      ];
      const endpoint = dummyEndpoints[Math.floor(Math.random() * dummyEndpoints.length)];
      rotatingFetch(endpoint, { headers: { Authorization: `Bearer ${token}` } })
        .then(() => console.log(`👻 Dummy request to ${endpoint.split('/')[2]}`))
        .catch(() => {});
    }).catch(() => {});
  }
}, 30000 + Math.random() * 60000); // Every 30-90 seconds

// ================== START SERVER ==================
app.get("/", (req, res) => res.json({
  status: "Enhanced Chai Proxy with Bypass Techniques",
  features: [
    "Credential rotation (multiple accounts)",
    "Request fingerprint spoofing",
    "Proxy rotation support",
    "Random delays & jitter",
    "Dummy traffic generation",
    "Automatic failover"
  ],
  stats: {
    mobile_accounts: MOBILE_CREDENTIALS.filter(c => c.apiKey).length,
    website_accounts: WEBSITE_CREDENTIALS.filter(c => c.apiKey).length,
    proxies_available: PROXY_LIST.length,
    token_cache_size: tokenCache.size
  },
  warning: "Use at your own risk - this violates ToS"
}));

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`🚀 Enhanced Chai Proxy running on port ${PORT}`);
    console.log(`🔧 Loaded ${MOBILE_CREDENTIALS.filter(c => c.apiKey).length} mobile accounts`);
    console.log(`🔧 Loaded ${WEBSITE_CREDENTIALS.filter(c => c.apiKey).length} website accounts`);
    console.log(`⚠️  WARNING: This proxy implements aggressive bypass techniques`);
  });
}

module.exports = app;
