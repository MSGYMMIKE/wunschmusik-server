/**
 * Wunschmusik Background Server
 * ─────────────────────────────
 * Runs on Render.com (free tier, Web Service)
 * - Refreshes Spotify token every 30 minutes
 * - Writes admin heartbeat every 8 seconds
 * - Completely independent of the browser/admin tab
 */

const express  = require('express');
const fetch    = require('node-fetch');
const admin    = require('firebase-admin');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID = '09a4629ec6654363987f901734d6d9db';
const REFRESH_INTERVAL  = 30 * 60 * 1000;  // 30 minutes
const HEARTBEAT_INTERVAL = 8 * 1000;        // 8 seconds
const SERVER_TAB_ID     = 'server-' + Date.now(); // unique ID for this server instance

// ── FIREBASE INIT ─────────────────────────────────────────────────────────────
// Firebase credentials come from environment variable FIREBASE_SERVICE_ACCOUNT
// Set this in Render dashboard as a JSON string
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'msgym-d2a85'
  });
  db = admin.firestore();
  console.log('✅ Firebase initialized');
} catch(e) {
  console.error('❌ Firebase init failed:', e.message);
  process.exit(1);
}

// ── TOKEN REFRESH ─────────────────────────────────────────────────────────────
async function refreshToken() {
  try {
    const snap = await db.collection('config').doc('spotify').get();
    if (!snap.exists) {
      console.log('⚠️  No Spotify config found – waiting for admin to connect');
      return;
    }
    const data    = snap.data();
    const refresh = data.refresh;
    const expires = data.expires || 0;

    // Only refresh if token expires within 15 minutes
    if (expires - Date.now() > 15 * 60 * 1000) {
      console.log(`⏰ Token still valid for ${Math.round((expires - Date.now()) / 60000)} min – skipping refresh`);
      return;
    }

    if (!refresh) {
      console.log('⚠️  No refresh token – admin needs to reconnect Spotify');
      return;
    }

    console.log('🔄 Refreshing Spotify token...');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refresh,
        client_id:     SPOTIFY_CLIENT_ID
      })
    });

    const d = await res.json();
    if (d.access_token) {
      await db.collection('config').doc('spotify').set({
        token:   d.access_token,
        refresh: d.refresh_token || refresh,
        expires: Date.now() + (d.expires_in || 3600) * 1000,
        updated: new Date().toISOString()
      }, { merge: true });
      console.log(`✅ Token refreshed – valid for ${d.expires_in || 3600}s`);
    } else {
      console.error('❌ Token refresh failed:', d.error, d.error_description);
    }
  } catch(e) {
    console.error('❌ refreshToken error:', e.message);
  }
}

// ── HEARTBEAT ─────────────────────────────────────────────────────────────────
async function writeHeartbeat() {
  try {
    await db.collection('state').doc('admin-heartbeat').set({
      tabId:   SERVER_TAB_ID,
      alive:   Date.now(),
      updated: new Date().toISOString(),
      source:  'server' // so admin UI can show "Server aktiv" instead of "Admin-Tab aktiv"
    });
  } catch(e) {
    // Silent – heartbeat failures are non-critical
  }
}

// ── EXPRESS (keeps Render service alive) ──────────────────────────────────────
const app = express();

app.get('/', (req, res) => {
  res.json({
    status:  'running',
    service: 'Wunschmusik Background Server',
    uptime:  Math.round(process.uptime()) + 's',
    time:    new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ── SELF-PING (prevents Render free tier from sleeping) ──────────────────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(async () => {
    try {
      await fetch(`${RENDER_URL}/health`);
      console.log('🏓 Self-ping OK');
    } catch(e) {}
  }, 10 * 60 * 1000); // every 10 minutes
  console.log(`🏓 Self-ping enabled: ${RENDER_URL}/health`);
}

// ── START JOBS ────────────────────────────────────────────────────────────────
console.log('🎵 Wunschmusik Background Server starting...');

// Immediate first run
refreshToken();
writeHeartbeat();

// Scheduled runs
setInterval(refreshToken,  REFRESH_INTERVAL);
setInterval(writeHeartbeat, HEARTBEAT_INTERVAL);

console.log(`⏱️  Token refresh: every ${REFRESH_INTERVAL/60000} minutes`);
console.log(`💓 Heartbeat: every ${HEARTBEAT_INTERVAL/1000} seconds`);
