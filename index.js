const express = require("express");
const cors = require("cors");
const https = require("https");
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: "text/plain" }));

const FIREBASE_API_KEY = "AIzaSyD9Yd1ur8O76K_3ldWdcQEATJB_W-6wods";
const CHAI_UID = "5UjcH6R0zWYwzLciAX7lz9F3Sz02";
const REFRESH_TOKEN = "AMf-vBxABjgCQ0SoRCymcdUbckokYPr9aPJ7-zsy6cFeXMioykMeSSGJiF4Vpi1tqic6HqzfaTmNWDPAo1Z-WBAEFGAuY_tGRt_fyujgs4zhwj7FnvFIp-ZKWM4RsX8sO5qwVZ6gRVFn5eo8kehreZbOCblhhqMMqgaR-EgI_whH4uVWONzzR_QqZnOfWA_yRrEuxAQy4YwoA6znvXbLNz-v21MJbhrzLQiZ6Vc--XuUWqD9Z09f5W2KLfU-8Zq96LPygwE2LS-BLQCqrLCxFzQEVOLRH_422e68fhEbmwv3cvJitPo3LoPas1VO4XCAvULjjT0HC6SjbG6ko03H1VW-NOCCbOTpmlXfrvIUVO-g0bcCsCYLZIL0WMgz5V9PvJ1LYPz4QKBv";
const NEXT_ACTION = "40c310248f7ddff7be9b149fd121cc0806f8ba6f75";

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
  cachedToken = data.id_token;
  tokenExpiry = Date.now() + (3500 * 1000);
  return cachedToken;
}

app.post("/chat/:conversationId", async (req, res) => {
  try {
    const { conversationId } = req.params;
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Body type:', typeof req.body);
    console.log('Body:', JSON.stringify(req.body)?.substring(0, 300));
    const token = await getFreshToken();
    const chaiUrl = `https://web.chai-research.com/chat/${conversationId}`;
    const response = await fetch(chaiUrl, {
      method: "POST",
      headers: {
        "Accept": "text/x-component",
        "Content-Type": "text/plain;charset=UTF-8",
        "next-action": NEXT_ACTION,
        "Origin": "https://web.chai-research.com",
        "Referer": `https://web.chai-research.com/chat/${conversationId}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Cookie": `firebaseToken=${token}`,
      },
      body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    });
    const text = await response.text();
    res.status(response.status).send(text);
  } catch (error) {
    console.error('Proxy error:', error.stack || error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/token", async (req, res) => {
  try {
    const token = await getFreshToken();
    res.json({ token, uid: CHAI_UID });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => res.json({ status: "Chai Proxy running!" }));

if (require.main === module) {
  app.listen(3001, () => console.log("Chai Proxy running on http://localhost:3001"));
}
module.exports = app;