/**
 * Wunschmusik Background Server v2
 * ──────────────────────────────────
 * Runs on Render.com (free Web Service)
 *
 * Handles ALL background tasks independently of the browser:
 * 1. Spotify token refresh every 30 minutes
 * 2. Admin heartbeat every 8 seconds
 * 3. Queue sync – sends wished songs to Spotify every 5 seconds
 * 4. Now playing detection – removes played songs from queue
 */

const express  = require('express');
const fetch    = require('node-fetch');
const admin    = require('firebase-admin');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID  = '09a4629ec6654363987f901734d6d9db';
const REFRESH_INTERVAL   = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL = 8  * 1000;
const POLL_INTERVAL      = 5  * 1000;
const SERVER_TAB_ID      = 'server-' + Date.now();

// ── STATE ─────────────────────────────────────────────────────────────────────
let accessToken      = null;
let tokenExpires     = 0;
let queuedTrackIds   = [];
let currentlyPlaying = null;
let deviceId         = null;

// ── FIREBASE INIT ─────────────────────────────────────────────────────────────
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId:  'msgym-d2a85'
  });
  db = admin.firestore();
  console.log('✅ Firebase initialized');
} catch(e) {
  console.error('❌ Firebase init failed:', e.message);
  process.exit(1);
}

// ── SPOTIFY FETCH ─────────────────────────────────────────────────────────────
async function spFetch(url, opts = {}) {
  if (!accessToken) return null;
  return fetch(url, {
    ...opts,
    headers: { 'Authorization': `Bearer ${accessToken}`, ...(opts.headers || {}) }
  });
}

// ── TOKEN REFRESH ─────────────────────────────────────────────────────────────
async function refreshToken() {
  try {
    const snap = await db.collection('config').doc('spotify').get();
    if (!snap.exists) { console.log('⚠️  No Spotify config'); return; }
    const data = snap.data();
    tokenExpires = data.expires || 0;
    accessToken  = data.token  || null;

    if (tokenExpires - Date.now() > 15 * 60 * 1000) {
      console.log(`⏰ Token valid for ${Math.round((tokenExpires-Date.now())/60000)} min`);
      return;
    }
    if (!data.refresh) { console.log('⚠️  No refresh token'); return; }

    console.log('🔄 Refreshing token...');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: data.refresh, client_id: SPOTIFY_CLIENT_ID
      })
    });
    const d = await res.json();
    if (d.access_token) {
      accessToken  = d.access_token;
      tokenExpires = Date.now() + (d.expires_in || 3600) * 1000;
      await db.collection('config').doc('spotify').set({
        token: d.access_token, refresh: d.refresh_token || data.refresh,
        expires: tokenExpires, updated: new Date().toISOString()
      }, { merge: true });
      console.log(`✅ Token refreshed – ${d.expires_in}s`);
    } else {
      console.error('❌ Refresh failed:', d.error_description || d.error);
      accessToken = null;
    }
  } catch(e) { console.error('❌ refreshToken:', e.message); }
}

// ── HEARTBEAT ─────────────────────────────────────────────────────────────────
async function writeHeartbeat() {
  try {
    await db.collection('state').doc('admin-heartbeat').set({
      tabId: SERVER_TAB_ID, alive: Date.now(),
      updated: new Date().toISOString(), source: 'server'
    });
  } catch(e) {}
}

// ── LOAD DEVICE ───────────────────────────────────────────────────────────────
async function loadDevice() {
  try {
    const res = await spFetch('https://api.spotify.com/v1/me/player/devices');
    if (!res || !res.ok) return;
    const data   = await res.json();
    const active = (data.devices || []).find(d => d.is_active);
    if (active) deviceId = active.id;
    else if (data.devices?.length) deviceId = data.devices[0].id;
  } catch(e) {}
}

// ── QUEUE SYNC ────────────────────────────────────────────────────────────────
async function syncQueue() {
  if (!accessToken || tokenExpires < Date.now()) return;
  try {
    // Poll player
    const playerRes = await spFetch('https://api.spotify.com/v1/me/player');
    if (!playerRes) return;

    if (playerRes.status === 401) {
      accessToken = null; await refreshToken(); return;
    }
    if (playerRes.status === 204 || !playerRes.ok) {
      await loadDevice();
      currentlyPlaying = null;
      await db.collection('state').doc('nowplaying').set(
        { item: null, progressMs: 0, durationMs: 0, updated: Date.now() }
      ).catch(() => {});
      return;
    }

    const player  = await playerRes.json();
    if (!player?.item) return;

    const trackId = player.item.id;
    const prog    = player.progress_ms || 0;
    const dur     = player.item.duration_ms || 1;
    if (player.device?.id) deviceId = player.device.id;

    // Write now playing for members
    await db.collection('state').doc('nowplaying').set({
      item: player.item, progressMs: prog, durationMs: dur, updated: Date.now()
    }).catch(() => {});

    // Track change detection
    if (trackId !== currentlyPlaying) {
      console.log(`🎵 Now: ${player.item.name} – ${player.item.artists?.[0]?.name}`);
      currentlyPlaying = trackId;
      queuedTrackIds   = queuedTrackIds.filter(id => id !== trackId);

      // Remove from Firebase queue if this track was a wished song (check all positions)
      try {
        const qSnap  = await db.collection('state').doc('queue').get();
        if (qSnap.exists) {
          const tracks  = qSnap.data().tracks || [];
          const updated = tracks.filter(t => t.id !== trackId);
          if (updated.length !== tracks.length) {
            await db.collection('state').doc('queue').set(
              { tracks: updated, updated: Date.now() }
            );
            console.log(`✂️  Removed from queue: ${player.item.name}`);
          }
        }
      } catch(e) {}
    }

    // Send new wish songs to Spotify queue
    const qSnap = await db.collection('state').doc('queue').get();
    if (!qSnap.exists) return;
    const toSend = (qSnap.data().tracks || []).filter(t => !queuedTrackIds.includes(t.id));

    for (const track of toSend) {
      if (!track.uri) continue;
      const url = deviceId
        ? `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(track.uri)}&device_id=${deviceId}`
        : `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(track.uri)}`;
      const res = await spFetch(url, { method: 'POST' });
      if (res && (res.status === 204 || res.ok)) {
        queuedTrackIds.push(track.id);
        console.log(`➕ Queued: ${track.name} (by ${track.wishedBy || '?'})`);
      } else {
        const err = res ? await res.json().catch(() => ({})) : {};
        console.error(`❌ Queue failed: ${track.name} –`, err?.error?.message);
        break;
      }
      await new Promise(r => setTimeout(r, 300));
    }
  } catch(e) { console.error('❌ syncQueue:', e.message); }
}

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const app = express();
app.get('/', (req, res) => res.json({
  status: 'running', service: 'Wunschmusik Server v2',
  uptime: Math.round(process.uptime()) + 's',
  tokenValid: tokenExpires > Date.now(),
  tokenExpiresIn: Math.round((tokenExpires - Date.now()) / 60000) + ' min',
  currentlyPlaying, queuedTracks: queuedTrackIds.length, deviceId
}));
app.get('/health', (req, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));

// ── SELF-PING ─────────────────────────────────────────────────────────────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(async () => {
    try { await fetch(`${RENDER_URL}/health`); console.log('🏓 ping'); } catch(e) {}
  }, 10 * 60 * 1000);
}

// ── START ─────────────────────────────────────────────────────────────────────
console.log('🎵 Wunschmusik Server v2');
console.log(`🔄 Token refresh: every ${REFRESH_INTERVAL/60000} min`);
console.log(`💓 Heartbeat: every ${HEARTBEAT_INTERVAL/1000}s`);
console.log(`🎶 Queue sync: every ${POLL_INTERVAL/1000}s`);

(async () => {
  await refreshToken();
  await loadDevice();

  // Pre-fill queuedTrackIds from Firebase queue on startup
  // This prevents re-sending songs that were already queued before server restart
  try {
    const qSnap = await db.collection('state').doc('queue').get();
    if (qSnap.exists) {
      queuedTrackIds = (qSnap.data().tracks || []).map(t => t.id);
      console.log(`📋 Pre-loaded ${queuedTrackIds.length} queued track IDs from Firebase`);
    }
  } catch(e) {}

  await writeHeartbeat();
  await syncQueue();
})();

setInterval(refreshToken,   REFRESH_INTERVAL);
setInterval(writeHeartbeat, HEARTBEAT_INTERVAL);
setInterval(syncQueue,      POLL_INTERVAL);
