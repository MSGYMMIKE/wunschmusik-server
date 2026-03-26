/**
 * Wunschmusik Background Server v3
 * ──────────────────────────────────
 * FIXES in v3:
 * - FIX 1: Server ist der EINZIGE Queue-Sender (admin.html sendet nicht mehr)
 * - FIX 2: Bei Spotify-Pause (204) werden Songs trotzdem gequeued wenn Gerät bekannt
 * - FIX 3: Beim Start Spotify-Queue abfragen um Duplikate nach Neustart zu vermeiden
 * - FIX 4: Token-Refresh Mutex verhindert Race Condition
 */

const express = require('express');
const fetch   = require('node-fetch');
const admin   = require('firebase-admin');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID  = '09a4629ec6654363987f901734d6d9db';
const REFRESH_INTERVAL   = 10 * 60 * 1000; // alle 10min – sicherer als 15min
const HEARTBEAT_INTERVAL = 60 * 1000; // 60s statt 8s – spart ~9500 Firebase Writes/Tag
const POLL_INTERVAL      = 10 * 1000; // 10s statt 5s – spart ~8600 Firebase Writes/Tag
const SERVER_TAB_ID      = 'server-' + Date.now();

// ── STATE ─────────────────────────────────────────────────────────────────────
let accessToken      = null;
let tokenExpires     = 0;
let queuedTrackIds   = [];   // IDs bereits an Spotify gesendet (In-Memory)
let currentlyPlaying = null;
let deviceId         = null;
let refreshInProgress = false; // FIX 4: Mutex für Token-Refresh

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

// ── TOKEN WATCHER (onSnapshot) ───────────────────────────────────────────────
// Erkennt neuen Token SOFORT wenn Admin Spotify neu verbindet – kein 15-Min-Wait
function startTokenWatcher() {
  db.collection('config').doc('spotify').onSnapshot(async snap => {
    if (!snap.exists) return;
    const d = snap.data();
    if (!d.token || !d.expires) return;
    // Neuer Token erkannt → sofort übernehmen
    if (d.token !== accessToken && d.expires > Date.now()) {
      accessToken  = d.token;
      tokenExpires = d.expires;
      console.log('🔑 New token detected via onSnapshot – activating immediately');
      await loadDevice();
      await syncQueue(); // sofort Songs senden
    }
  }, err => console.error('❌ Token watcher error:', err.message));
}

// ── SPOTIFY FETCH ─────────────────────────────────────────────────────────────
async function spFetch(url, opts = {}) {
  if (!accessToken) return null;
  return fetch(url, {
    ...opts,
    headers: { 'Authorization': `Bearer ${accessToken}`, ...(opts.headers || {}) }
  });
}

// ── TOKEN REFRESH (mit Mutex) ─────────────────────────────────────────────────
async function refreshToken() {
  if (refreshInProgress) return; // FIX 4: kein paralleler Refresh
  refreshInProgress = true;
  try {
    const snap = await db.collection('config').doc('spotify').get();
    if (!snap.exists) { console.log('⚠️  No Spotify config'); return; }
    const data = snap.data();
    tokenExpires = data.expires || 0;
    accessToken  = data.token  || null;

    if (tokenExpires - Date.now() > 30 * 60 * 1000) {
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
  finally { refreshInProgress = false; } // FIX 4: immer freigeben
}

// ── HEARTBEAT ─────────────────────────────────────────────────────────────────
async function writeHeartbeat() {
  try {
    await db.collection('state').doc('admin-heartbeat').set({
      tabId: SERVER_TAB_ID, alive: Date.now(),
      updated: new Date().toISOString(), source: 'server'
    });
  } catch(e) { console.error('❌ Heartbeat write failed:', e.message); }
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

// ── SEND PENDING SONGS TO SPOTIFY ─────────────────────────────────────────────
// Ausgelagert damit sowohl syncQueue() als auch der 204-Pfad es aufrufen können
async function sendPendingSongs() {
  if (!deviceId) return;
  try {
    const qSnap = await db.collection('state').doc('queue').get();
    if (!qSnap.exists) return;
    const toSend = (qSnap.data().tracks || []).filter(t => !queuedTrackIds.includes(t.id));
    for (const track of toSend) {
      if (!track.uri) continue;
      const url = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(track.uri)}&device_id=${deviceId}`;
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
  } catch(e) { console.error('❌ sendPendingSongs:', e.message); }
}

// ── QUEUE SYNC ────────────────────────────────────────────────────────────────
let syncRunning = false;
async function syncQueue() {
  if (syncRunning) return;
  if (!accessToken || tokenExpires < Date.now()) { await refreshToken(); return; } // Token abgelaufen → sofort erneuern
  syncRunning = true;
  try {
    const playerRes = await spFetch('https://api.spotify.com/v1/me/player');
    if (!playerRes) return;

    if (playerRes.status === 401) {
      accessToken = null; await refreshToken(); return;
    }

    // FIX 2: Bei 204 (Spotify pausiert/kein aktiver Player) trotzdem Songs senden
    if (playerRes.status === 204 || !playerRes.ok) {
      await loadDevice();
      currentlyPlaying = null;
      await db.collection('state').doc('nowplaying').set(
        { item: null, progressMs: 0, durationMs: 0, updated: Date.now() }
      ).catch(() => {});
      // FIX 2: Wenn Gerät bekannt → Songs trotzdem in Queue stellen
      if (deviceId) {
        await sendPendingSongs();
      } else {
        console.log('⚠️  Kein Spotify-Gerät – Songs warten auf Gerät');
      }
      return;
    }

    const player = await playerRes.json();
    if (!player?.item) return;

    const trackId = player.item.id;
    const prog    = player.progress_ms || 0;
    const dur     = player.item.duration_ms || 1;
    if (player.device?.id) deviceId = player.device.id;

    // Now Playing in Firebase schreiben
    await db.collection('state').doc('nowplaying').set({
      item: player.item, progressMs: prog, durationMs: dur, updated: Date.now()
    }).catch(() => {});

    // Track-Wechsel erkennen
    if (trackId !== currentlyPlaying) {
      console.log(`🎵 Now: ${player.item.name} – ${player.item.artists?.[0]?.name}`);
      currentlyPlaying = trackId;
      queuedTrackIds   = queuedTrackIds.filter(id => id !== trackId);

      // Gespielten Song aus Firebase-Queue entfernen (mit Transaction – verhindert Race mit Admin-Tab)
      try {
        let removed = false;
        await db.runTransaction(async tx => {
          const ref   = db.collection('state').doc('queue');
          const snap  = await tx.get(ref);
          if (!snap.exists) return;
          const tracks  = snap.data().tracks || [];
          const updated = tracks.filter(t => t.id !== trackId);
          if (updated.length !== tracks.length) {
            tx.set(ref, { tracks: updated, updated: Date.now() });
            removed = true;
          }
        });
        if (removed) console.log(`✂️  Removed from queue: ${player.item.name}`);
      } catch(e) { console.error('❌ Queue remove failed:', e.message); }
    }

    // Neue Songs an Spotify senden
    await sendPendingSongs();

  } catch(e) { console.error('❌ syncQueue:', e.message); }
  finally { syncRunning = false; }
}

// ── EXPRESS ───────────────────────────────────────────────────────────────────
const app = express();
app.get('/', (req, res) => res.json({
  status: 'running', service: 'Wunschmusik Server v3',
  uptime: Math.round(process.uptime()) + 's',
  tokenValid: tokenExpires > Date.now(),
  tokenExpiresIn: Math.round((tokenExpires - Date.now()) / 60000) + ' min',
  currentlyPlaying, queuedTracks: queuedTrackIds.length, deviceId
}));
app.get('/health', (req, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));

// ── SELF-PING (verhindert Render-Sleep) ───────────────────────────────────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(async () => {
    try { await fetch(`${RENDER_URL}/health`); console.log('🏓 ping'); } catch(e) {}
  }, 4 * 60 * 1000);
}

// ── DEVICE KEEP-ALIVE ─────────────────────────────────────────────────────────
setInterval(async () => {
  if (!accessToken) return;
  try {
    await loadDevice();
    if (deviceId) console.log(`🔌 Device OK: ${deviceId}`);
    else console.log('⚠️  Kein Spotify-Gerät – bitte Spotify am Studio-PC starten');
  } catch(e) {}
}, 2 * 60 * 1000);

// ── START ─────────────────────────────────────────────────────────────────────
console.log('🎵 Wunschmusik Server v3');
console.log(`🔄 Token refresh: every ${REFRESH_INTERVAL/60000} min`);
console.log(`💓 Heartbeat: every ${HEARTBEAT_INTERVAL/1000}s`);
console.log(`🎶 Queue sync: every ${POLL_INTERVAL/1000}s`);

(async () => {
  await refreshToken();
  await loadDevice();

  // FIX 3: Spotify-Queue abfragen um Duplikate nach Neustart zu vermeiden
  try {
    if (accessToken && deviceId) {
      const spQRes = await spFetch('https://api.spotify.com/v1/me/player/queue');
      if (spQRes?.ok) {
        const spQData = await spQRes.json();
        const spotifyQueueIds = (spQData.queue || []).map(t => t.id);
        // Alle Songs die schon in Spotifys Queue sind → als gesendet markieren
        const fbSnap = await db.collection('state').doc('queue').get();
        if (fbSnap.exists) {
          const fbTracks = fbSnap.data().tracks || [];
          queuedTrackIds = fbTracks
            .filter(t => spotifyQueueIds.includes(t.id))
            .map(t => t.id);
          console.log(`📋 ${queuedTrackIds.length}/${fbTracks.length} songs already in Spotify queue – skipping`);
        }
      } else {
        console.log('🔄 Starting fresh – all queued songs will be re-sent to Spotify');
      }
    } else {
      console.log('🔄 Starting fresh – no device yet');
    }
  } catch(e) {
    console.log('🔄 Starting fresh (queue check failed):', e.message);
  }

  startTokenWatcher(); // Sofort reagieren wenn Admin neuen Token speichert
  await writeHeartbeat();
  await syncQueue();
})();

setInterval(refreshToken,   REFRESH_INTERVAL);
setInterval(writeHeartbeat, HEARTBEAT_INTERVAL);
setInterval(syncQueue,      POLL_INTERVAL);
