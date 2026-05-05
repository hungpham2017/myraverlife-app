// findfriend.js — Find Friends feature for myraverlife.
//
// Self-contained module. Injects its own CSS, manages its own DOM and
// localStorage state. Exposes window.findFriends with a tiny public API
// that index.html calls when the Friends tab is active.
//
// PHASE 1 SCOPE (current):
//   - Persistent local QR id (12 chars, stored in localStorage)
//   - Friends screen UI: code display + 3 buttons (scan / share / replace)
//   - Manual code paste flow (camera scanning comes later)
//   - Local "following" list, persisted
//   - Firebase RTDB sync: anonymous auth + publish my location every 60s
//   - Subscribe to followed friends' locations, show last-known + freshness
//
// PHASE 2 (not yet):
//   - Real QR rendering
//   - Camera scanning
//   - Map "Show friends" toggle + friend dots + bottom sheet + long-press

(function () {
  'use strict';

  // ── Firebase config (public; security comes from RTDB rules) ──────────
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyAuXsmFF6qVT89be78TbFO0u8ld6j0NaFg',
    authDomain: 'myraverlife.firebaseapp.com',
    databaseURL: 'https://myraverlife-default-rtdb.firebaseio.com',
    projectId: 'myraverlife',
    storageBucket: 'myraverlife.firebasestorage.app',
    messagingSenderId: '753386582338',
    appId: '1:753386582338:web:00414de877a07a82e8d8db',
  };

  // ── Local state ───────────────────────────────────────────────────────
  const STORAGE_KEY = 'myraverlife-friends-v1';
  const LOCATIONS_KEY = 'myraverlife-friend-locations-v1';  // last-known cache
  const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const ID_LENGTH = 6;            // shorter = easier to share verbally + smaller QR
  const ID_LENGTH_MIN = 6;        // accept legacy longer codes too (back-compat)
  const ID_LENGTH_MAX = 16;
  // Publish every 30s to maximize the chance of catching a brief signal
  // window at the festival (where cell coverage flickers in/out). The
  // payload is ~80 bytes so this is cheap on data + battery.
  const PUBLISH_INTERVAL_MS = 30000;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { myQRid: null, following: [] };
  }
  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function genQRid() {
    let out = '';
    const arr = new Uint32Array(ID_LENGTH);
    crypto.getRandomValues(arr);
    for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET[arr[i] % ID_ALPHABET.length];
    return out;
  }
  function formatId(id) {
    // 6 chars → bare 'K3FQ72' (clean, no dash needed at this length).
    // Longer legacy codes get 4-char chunks separated by dashes for readability.
    if (id.length <= 7) return id;
    return id.match(/.{1,4}/g).join('-');
  }

  const state = loadState();
  if (!state.myQRid) {
    state.myQRid = genQRid();
    saveState();
  }

  // friendData[qrid] = { lat, lng, ts, _unsub? }
  // Hydrated from localStorage so "last seen X" persists across browser
  // refreshes and is visible offline before Firebase reconnects.
  const friendData = (function () {
    try {
      const raw = localStorage.getItem(LOCATIONS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Strip any stale _unsub fns (they don't survive serialization, but
        // be defensive in case someone hand-edits).
        Object.keys(parsed).forEach(k => { delete parsed[k]._unsub; });
        return parsed;
      }
    } catch (e) {}
    return {};
  })();
  // Clean up orphan cached locations — entries for friends the user is no
  // longer following. Without this, removed-friend data lingers forever.
  (function pruneOrphans() {
    let mutated = false;
    Object.keys(friendData).forEach(qrid => {
      if (!state.following.some(f => f.qrid === qrid)) {
        delete friendData[qrid];
        mutated = true;
      }
    });
    if (mutated) {
      try {
        const out = {};
        Object.keys(friendData).forEach(k => {
          const d = friendData[k];
          out[k] = { lat: d.lat, lng: d.lng, ts: d.ts };
        });
        localStorage.setItem(LOCATIONS_KEY, JSON.stringify(out));
      } catch (e) {}
    }
  })();
  function persistFriendData() {
    try {
      // Save only the data fields, not in-memory _unsub callbacks.
      const out = {};
      Object.keys(friendData).forEach(k => {
        const d = friendData[k];
        if (d && (d.lat != null || d.ts != null)) {
          out[k] = { lat: d.lat, lng: d.lng, ts: d.ts };
        }
      });
      localStorage.setItem(LOCATIONS_KEY, JSON.stringify(out));
    } catch (e) {}
  }

  // ── CSS injection ─────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .ff-page { max-width: 480px; margin: 0 auto; padding: 16px 16px 40px; }
    .ff-qr-card {
      text-align: center;
      margin-bottom: 14px;
      padding: 0 0 4px;
    }
    .ff-qr {
      width: 160px; height: 160px;
      margin: 0 auto 10px;
      padding: 8px;
      background: white;
      border-radius: 10px;
      box-shadow: 0 3px 14px rgba(0,0,0,0.22);
    }
    .ff-qr svg { width: 100%; height: 100%; display: block; }
    .ff-code {
      font-family: ui-monospace, monospace; font-size: 18px; font-weight: 700;
      letter-spacing: 1.5px; color: var(--text); margin: 2px 0 8px;
    }
    .ff-hint {
      font-size: 13px; color: var(--text); margin: 0; line-height: 1.45;
      font-weight: 500;
    }
    .ff-hint b { color: var(--accent); font-weight: 700; }
    .ff-status {
      display: inline-block; margin-top: 10px;
      font-size: 11px; font-weight: 600; letter-spacing: 0.4px;
      padding: 3px 9px; border-radius: 999px;
    }
    .ff-status.ok { background: rgba(46,160,67,0.18); color: #5dd07a; }
    .ff-status.bad { background: rgba(255,80,80,0.18); color: #ff8080; }
    .ff-status.idle { background: rgba(255,255,255,0.06); color: var(--muted); }
    .ff-actions { display: flex; gap: 6px; margin-bottom: 16px; }
    .ff-btn {
      flex: 1;
      min-height: 34px;
      padding: 7px 6px;
      border-radius: 9px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-size: 11px; font-weight: 600;
      cursor: pointer;
      letter-spacing: 0.1px;
      text-align: center;
      line-height: 1.2;
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.08s ease;
    }
    .ff-btn:active { transform: scale(0.96); }
    .ff-btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    .ff-btn-secondary {
      background: transparent;
      color: var(--muted);
      border-color: rgba(255,255,255,0.08);
    }
    .ff-following {
      margin-top: 4px; padding: 14px 16px 6px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px;
      max-height: 50vh; overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    .ff-following h4 {
      margin: 0 0 8px;
      font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.7px; color: var(--muted);
      display: flex; align-items: baseline; gap: 7px;
      position: sticky; top: 0;
      background: var(--surface);
      padding: 4px 0 6px;
      z-index: 1;
    }
    .ff-following h4 .count {
      font-size: 13px; font-weight: 800;
      color: var(--text); letter-spacing: 0;
    }
    .ff-following-empty { font-size: 13px; color: var(--muted); margin: 6px 0 12px; }
    .ff-friend-row {
      display: flex; align-items: center; gap: 11px;
      padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .ff-friend-row:last-child { border-bottom: 0; }
    .ff-friend-dot {
      width: 32px; height: 32px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      color: white; font-size: 12px; font-weight: 700; flex-shrink: 0;
    }
    .ff-friend-meta { flex: 1; min-width: 0; }
    .ff-friend-name {
      font-size: 14.5px; font-weight: 600; color: var(--text);
      line-height: 1.2;
    }
    .ff-friend-sub {
      font-size: 11.5px; color: var(--muted); margin-top: 3px;
      font-variant-numeric: tabular-nums;
      display: flex; align-items: center; gap: 5px;
    }
    .ff-fresh-bullet {
      display: inline-block; width: 7px; height: 7px; border-radius: 50%;
      flex-shrink: 0;
    }
    .ff-fresh-green  { background: #5dd07a; }
    .ff-fresh-yellow { background: #f5b942; }
    .ff-fresh-grey   { background: rgba(255,255,255,0.3); }
    .ff-friend-x {
      cursor: pointer; padding: 4px 8px; color: var(--muted);
      font-size: 16px; line-height: 1; flex-shrink: 0;
    }
    .ff-friend-x:hover { color: var(--accent); }

    /* Custom modal — replaces native alert/confirm/prompt for consistent
       look across iOS Safari, Chrome, etc. */
    .ff-modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999;
      padding: 16px;
      animation: ffModalFade 0.18s ease-out;
    }
    @keyframes ffModalFade { from { opacity: 0; } to { opacity: 1; } }
    .ff-modal {
      background: #1c1f29;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 20px 20px 16px;
      max-width: 340px;
      width: 100%;
      box-shadow: 0 12px 48px rgba(0,0,0,0.55);
      animation: ffModalScale 0.18s cubic-bezier(0.2, 0.8, 0.4, 1);
    }
    @keyframes ffModalScale {
      from { transform: scale(0.94); opacity: 0; }
      to   { transform: scale(1);    opacity: 1; }
    }
    .ff-modal-text {
      color: var(--text); font-size: 14.5px;
      line-height: 1.5; margin: 2px 0 14px;
    }
    .ff-modal-text b { color: var(--accent); }
    .ff-modal-input {
      width: 100%; padding: 10px 12px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 9px; color: var(--text);
      font-size: 14.5px; margin-bottom: 14px;
      box-sizing: border-box;
    }
    .ff-modal-input:focus {
      outline: none; border-color: var(--accent);
    }
    .ff-modal-actions {
      display: flex; gap: 8px; justify-content: flex-end;
    }
    .ff-modal-btn {
      padding: 9px 18px;
      border-radius: 9px;
      border: 1px solid rgba(255,255,255,0.1);
      background: transparent;
      color: var(--text);
      font-size: 13.5px; font-weight: 600;
      cursor: pointer;
      min-width: 76px;
      transition: transform 0.08s ease;
    }
    .ff-modal-btn:active { transform: scale(0.97); }
    .ff-modal-btn-primary {
      background: var(--accent); border-color: var(--accent); color: white;
    }
    .ff-modal-btn-danger {
      background: #c93b3b; border-color: #c93b3b; color: white;
    }

    /* Camera scanner viewfinder */
    .ff-scan-modal { padding: 14px 14px 12px; }
    .ff-scan-title {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 14px; font-weight: 700; color: var(--text);
      margin-bottom: 10px;
    }
    .ff-scan-close {
      background: none; border: none; color: var(--muted);
      font-size: 22px; line-height: 1; cursor: pointer; padding: 0 4px;
    }
    .ff-scan-video-wrap {
      position: relative;
      width: 100%; aspect-ratio: 1 / 1;
      background: #000; border-radius: 12px;
      overflow: hidden;
    }
    .ff-scan-video-wrap video {
      width: 100%; height: 100%; object-fit: cover;
      display: block;
    }
    .ff-scan-overlay {
      position: absolute; inset: 14%;
      border: 2px solid rgba(255, 79, 163, 0.85);
      border-radius: 14px;
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.35);
      pointer-events: none;
    }
    .ff-scan-hint {
      font-size: 12px; color: var(--muted);
      text-align: center;
      margin: 12px 0 8px;
      line-height: 1.4;
    }
    .ff-scan-hint b { color: var(--text); }
    .ff-scan-paste-btn {
      width: 100%;
      padding: 10px 14px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 9px;
      color: var(--text);
      font-size: 13.5px; font-weight: 600;
      cursor: pointer;
    }
    .ff-explainer {
      font-size: 11px; color: var(--text);
      margin: 0 0 12px; padding: 7px 10px;
      line-height: 1.4;
      background: rgba(255, 79, 163, 0.07);
      border-left: 2px solid var(--accent);
      border-radius: 4px;
    }
    .ff-safety {
      font-size: 11px; color: var(--muted);
      margin: 0 0 14px; padding: 8px 12px;
      line-height: 1.4;
      background: rgba(255, 200, 60, 0.06);
      border-left: 2px solid rgba(255, 200, 60, 0.55);
      border-radius: 4px;
    }
  `;
  document.head.appendChild(style);

  // ── Firebase (compat SDK loaded from gstatic CDN in index.html) ───────
  let fbApp = null, fbDb = null, fbAuthed = false;
  let firebaseStatus = 'idle';  // 'idle' | 'connecting' | 'ok' | 'bad'
  let publishTimer = null;

  async function initFirebase() {
    if (fbApp) return true;
    if (typeof firebase === 'undefined') {
      firebaseStatus = 'bad';
      return false;
    }
    try {
      firebaseStatus = 'connecting';
      fbApp = firebase.initializeApp(FIREBASE_CONFIG);
      await firebase.auth().signInAnonymously();
      fbDb = firebase.database();
      fbAuthed = true;
      firebaseStatus = 'ok';
      return true;
    } catch (e) {
      console.warn('[findfriend] Firebase init failed:', e);
      firebaseStatus = 'bad';
      return false;
    }
  }

  function publishMyLocation() {
    if (!fbAuthed || !fbDb) return;
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        fbDb.ref('loc/' + state.myQRid).set({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          ts: Date.now(),
        }).catch(() => {});
      },
      () => { /* permission denied or unavailable — silent */ },
      { enableHighAccuracy: false, maximumAge: 30000, timeout: 8000 }
    );
  }

  function subscribeAllFriends() {
    if (!fbAuthed || !fbDb) return;
    state.following.forEach(f => {
      if (friendData[f.qrid] && friendData[f.qrid]._unsub) return;  // already subscribed
      const ref = fbDb.ref('loc/' + f.qrid);
      const handler = (snap) => {
        const v = snap.val();
        if (v && typeof v.lat === 'number' && typeof v.lng === 'number') {
          friendData[f.qrid] = Object.assign({}, friendData[f.qrid], v);
          persistFriendData();  // cache locally so it survives refresh / works offline
          maybeRerender();
          // Notify the map (or any other consumer) that a friend's location updated.
          window.dispatchEvent(new CustomEvent('myraver-friend-update', {
            detail: { qrid: f.qrid, lat: v.lat, lng: v.lng, ts: v.ts },
          }));
        }
      };
      ref.on('value', handler);
      friendData[f.qrid] = friendData[f.qrid] || {};
      friendData[f.qrid]._unsub = () => ref.off('value', handler);
    });
    let mutated = false;
    Object.keys(friendData).forEach(qrid => {
      if (!state.following.some(f => f.qrid === qrid)) {
        if (friendData[qrid]._unsub) friendData[qrid]._unsub();
        delete friendData[qrid];
        mutated = true;
      }
    });
    if (mutated) persistFriendData();
  }

  function startSyncLoop() {
    if (publishTimer) return;
    publishMyLocation();
    publishTimer = setInterval(publishMyLocation, PUBLISH_INTERVAL_MS);
  }

  // Opportunistic publish: fire IMMEDIATELY whenever there's a signal
  // window we can grab. At LVMS the cell coverage flickers — even a
  // 200ms window can flush the queue. The more triggers, the more
  // chances we catch one.
  function attachOpportunisticTriggers() {
    window.addEventListener('online', () => {
      if (fbAuthed) publishMyLocation();
    });
    // When index.html resolves user GPS, rerender so distances appear.
    window.addEventListener('myraver-userpos-update', () => maybeRerender());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && fbAuthed) publishMyLocation();
    });
  }
  attachOpportunisticTriggers();

  // Boot sync at app load (not just when Friends tab is rendered) if the
  // user is actively using the feature. Test: do they have any friends
  // following them — i.e., is there reason to broadcast our position?
  // Proxy: state.following.length > 0 (they've scanned someone, so they
  // care about the friends mesh).
  if (state.following.length > 0) {
    initFirebase().then((ok) => {
      if (ok) {
        startSyncLoop();
        subscribeAllFriends();
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function colorForInitial(initial) {
    let h = 0;
    for (let i = 0; i < initial.length; i++) h = (h * 31 + initial.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 72%, 58%)`;
  }
  function freshnessLabel(ts) {
    if (!ts) return { text: 'waiting for first sync', cls: 'ff-fresh-grey' };
    const ago = Date.now() - ts;
    const m = Math.floor(ago / 60000);
    if (m < 1) return { text: 'last seen just now', cls: 'ff-fresh-green' };
    if (m < 2) return { text: 'last seen 1 min ago', cls: 'ff-fresh-green' };
    if (m < 15) return { text: 'last seen ' + m + ' min ago', cls: 'ff-fresh-yellow' };
    if (m < 60) return { text: 'last seen ' + m + ' min ago', cls: 'ff-fresh-grey' };
    const h = Math.floor(m / 60);
    if (h < 24) return { text: 'last seen ' + h + (h === 1 ? ' hr' : ' hrs') + ' ago', cls: 'ff-fresh-grey' };
    return { text: 'last seen ' + Math.floor(h / 24) + 'd ago', cls: 'ff-fresh-grey' };
  }
  function deriveInitial(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return '?';
    return trimmed.slice(0, 2).toUpperCase();
  }

  // Distance helpers — kept here so findfriend.js doesn't depend on
  // index.html's main app scope.
  function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180, Δλ = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(Δφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function formatImperialDistance(m) {
    const ft = m * 3.28084;
    if (ft < 1320) return Math.round(ft / 50) * 50 + ' ft';
    const mi = m / 1609.344;
    if (mi < 10)   return mi.toFixed(1) + ' mi';
    if (mi < 100)  return Math.round(mi) + ' mi';
    return Math.round(mi / 10) * 10 + ' mi';
  }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ── Modal system (replaces native alert/confirm/prompt) ───────────────
  function showModal(opts) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'ff-modal-backdrop';
      const modal = document.createElement('div');
      modal.className = 'ff-modal';

      const text = document.createElement('p');
      text.className = 'ff-modal-text';
      text.innerHTML = opts.message;
      modal.appendChild(text);

      let inputEl = null;
      if (opts.input) {
        inputEl = document.createElement('input');
        inputEl.className = 'ff-modal-input';
        inputEl.type = 'text';
        inputEl.value = opts.defaultValue || '';
        inputEl.placeholder = opts.placeholder || '';
        if (opts.maxLength) inputEl.maxLength = opts.maxLength;
        inputEl.autocapitalize = opts.autocapitalize || 'off';
        inputEl.autocomplete = 'off';
        inputEl.spellcheck = false;
        modal.appendChild(inputEl);
      }

      const actions = document.createElement('div');
      actions.className = 'ff-modal-actions';

      function close() {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
      }
      function onKey(e) {
        if (e.key === 'Escape') { close(); resolve(null); }
        else if (e.key === 'Enter' && (!inputEl || document.activeElement === inputEl)) {
          const v = inputEl ? inputEl.value : true;
          close();
          resolve(v);
        }
      }
      document.addEventListener('keydown', onKey);

      if (!opts.primaryOnly) {
        const cancel = document.createElement('button');
        cancel.className = 'ff-modal-btn';
        cancel.textContent = opts.cancelLabel || 'Cancel';
        cancel.onclick = () => { close(); resolve(null); };
        actions.appendChild(cancel);
      }
      const ok = document.createElement('button');
      ok.className = 'ff-modal-btn ' + (opts.danger ? 'ff-modal-btn-danger' : 'ff-modal-btn-primary');
      ok.textContent = opts.primaryLabel || 'OK';
      ok.onclick = () => {
        const v = inputEl ? inputEl.value : true;
        close();
        resolve(v);
      };
      actions.appendChild(ok);

      modal.appendChild(actions);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      setTimeout(() => {
        const target = inputEl || ok;
        target.focus();
        if (inputEl && inputEl.value) inputEl.select();
      }, 30);
    });
  }
  function ffAlert(message) {
    return showModal({ message, primaryOnly: true });
  }
  function ffConfirm(message, opts) {
    opts = opts || {};
    return showModal({
      message,
      primaryLabel: opts.primaryLabel || 'Confirm',
      cancelLabel: opts.cancelLabel || 'Cancel',
      danger: !!opts.danger,
    }).then(v => v !== null);
  }
  function ffPrompt(message, opts) {
    opts = opts || {};
    return showModal({
      message,
      input: true,
      defaultValue: opts.defaultValue,
      placeholder: opts.placeholder,
      maxLength: opts.maxLength,
      autocapitalize: opts.autocapitalize,
      primaryLabel: opts.primaryLabel || 'OK',
    }).then(v => (v === null || v === '') ? null : String(v).trim());
  }
  function renderQRSvg(text) {
    if (typeof qrcode === 'undefined') return '';  // lib not loaded
    try {
      // type=0 lets the lib auto-pick the smallest size for the data.
      // EC level 'M' is a good balance (15% damage tolerance + small QR).
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ scalable: true, margin: 0 });
    } catch (e) {
      console.warn('[findfriend] QR render failed:', e);
      return '';
    }
  }

  // Render QR as a high-res PNG File for inclusion in navigator.share so
  // the iOS share sheet shows "Save Image" → users can save the QR to
  // their Photos app and show friends later (no app/internet needed at
  // the moment of showing).
  function renderQRAsPNGFile(text) {
    return new Promise((resolve) => {
      if (typeof qrcode === 'undefined') { resolve(null); return; }
      try {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        const svg = qr.createSvgTag({ scalable: true, margin: 1 });
        const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        const img = new Image();
        img.onload = () => {
          const SIZE = 512;  // big enough to look crisp in Photos
          const canvas = document.createElement('canvas');
          canvas.width = SIZE; canvas.height = SIZE;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, SIZE, SIZE);
          ctx.drawImage(img, 0, 0, SIZE, SIZE);
          URL.revokeObjectURL(url);
          canvas.toBlob((blob) => {
            if (!blob) return resolve(null);
            resolve(new File([blob], 'myraverlife-code.png', { type: 'image/png' }));
          }, 'image/png');
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
      } catch (e) { resolve(null); }
    });
  }

  // ── Render ────────────────────────────────────────────────────────────
  let activeMainEl = null;       // tracks if Friends tab is currently rendered
  let rerenderInterval = null;   // refreshes "X min ago" labels while tab is open

  // Only re-render if the Friends tab is still mounted. The user may have
  // switched to Map / Lineup / etc. in the meantime — in that case main
  // contains a different tab's UI and rewriting it would clobber that.
  function isFriendsTabActive() {
    return activeMainEl && activeMainEl.isConnected && activeMainEl.querySelector('.ff-page');
  }
  function maybeRerender() {
    if (isFriendsTabActive()) render(activeMainEl);
  }

  function render(mainEl) {
    activeMainEl = mainEl;
    if (rerenderInterval) clearInterval(rerenderInterval);
    rerenderInterval = setInterval(() => {
      if (isFriendsTabActive()) render(activeMainEl);
      else {
        clearInterval(rerenderInterval);
        rerenderInterval = null;
        activeMainEl = null;
      }
    }, 30000);

    const code = formatId(state.myQRid);
    const statusLabel = ({
      ok: 'syncing',
      connecting: 'connecting...',
      bad: 'sync offline',
      idle: '',
    })[firebaseStatus] || '';
    const statusCls = ({
      ok: 'ok', connecting: 'idle', bad: 'bad', idle: 'idle',
    })[firebaseStatus] || 'idle';

    let followingHTML;
    if (state.following.length === 0) {
      followingHTML = `<p class="ff-following-empty">No one yet. Scan a friend's code to add them.</p>`;
    } else {
      const userPos = window._lastUserPos;
      followingHTML = state.following.map((f, i) => {
        const data = friendData[f.qrid] || {};
        const fresh = freshnessLabel(data.ts);
        const displayName = f.name || f.initial || '?';
        const initial = f.initial || deriveInitial(displayName);
        // Distance from user (only if we have both points).
        let distLine = '';
        if (userPos && data.lat != null) {
          const distM = haversineMeters(userPos.lat, userPos.lng, data.lat, data.lng);
          distLine = ' · ' + formatImperialDistance(distM) + ' from you';
        }
        return `
          <div class="ff-friend-row">
            <div class="ff-friend-dot" style="background:${colorForInitial(initial)}">${escapeHTML(initial)}</div>
            <div class="ff-friend-meta">
              <div class="ff-friend-name">${escapeHTML(displayName)}</div>
              <div class="ff-friend-sub">
                <span class="ff-fresh-bullet ${fresh.cls}"></span>
                <span>${escapeHTML(fresh.text)}${distLine}</span>
              </div>
            </div>
            <div class="ff-friend-x" data-remove="${i}" aria-label="Remove">✕</div>
          </div>
        `;
      }).join('');
    }

    const shareUrl = `https://myraver.life/?friend=${state.myQRid}`;
    const qrSvg = renderQRSvg(shareUrl);
    mainEl.innerHTML = `
      <div class="ff-page">
        <div class="ff-qr-card">
          <div class="ff-qr">${qrSvg}</div>
          <div class="ff-code">${code}</div>
          <p class="ff-hint">Friends scan the QR or paste this code to <b>find you on the Map</b>.</p>
          ${statusLabel ? `<span class="ff-status ${statusCls}">● ${statusLabel}</span>` : ''}
        </div>
        <div class="ff-actions">
          <button class="ff-btn ff-btn-primary" id="ff-scan">Scan</button>
          <button class="ff-btn" id="ff-share">Share</button>
          <button class="ff-btn ff-btn-secondary" id="ff-replace">New</button>
        </div>
        <p class="ff-explainer">
          Anyone with your code sees your <b>last-seen</b> location, not
          live tracking. Even a brief window of weak signal is enough to update.
        </p>
        <div class="ff-following">
          <h4>Following<span class="count">${state.following.length}</span></h4>
          ${followingHTML}
        </div>
      </div>
    `;

    mainEl.querySelector('#ff-scan').onclick = onScan(mainEl);
    mainEl.querySelector('#ff-share').onclick = onShare;
    mainEl.querySelector('#ff-replace').onclick = onReplace(mainEl);
    mainEl.querySelectorAll('[data-remove]').forEach(el => {
      el.onclick = async (e) => {
        e.stopPropagation();
        const i = +el.dataset.remove;
        const f = state.following[i];
        const displayName = f.name || f.initial || 'this friend';
        const ok = await ffConfirm(
          `Stop following <b>${escapeHTML(displayName)}</b>?`,
          { primaryLabel: 'Remove', danger: true }
        );
        if (!ok) return;
        if (friendData[f.qrid] && friendData[f.qrid]._unsub) friendData[f.qrid]._unsub();
        delete friendData[f.qrid];
        persistFriendData();
        state.following.splice(i, 1);
        saveState();
        render(mainEl);
      };
    });

    // Lazy-init Firebase on first visit; trigger sync as needed.
    initFirebase().then((ok) => {
      if (ok) {
        startSyncLoop();
        subscribeAllFriends();
        if (firebaseStatus !== 'ok') maybeRerender();
      } else {
        if (firebaseStatus !== 'bad') maybeRerender();
      }
    });
  }

  // Extract a friend qrid from arbitrary scanned text. Accepts:
  //   - Raw 6+ char code: "K3FQ72"
  //   - Formatted code: "K3F-Q72"
  //   - Full deeplink URL: "https://myraver.life/?friend=K3FQ72"
  function extractQrid(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    // Try URL parse first
    try {
      const u = new URL(s);
      const f = u.searchParams.get('friend');
      if (f) {
        const cleaned = f.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (cleaned.length >= ID_LENGTH_MIN && cleaned.length <= ID_LENGTH_MAX) return cleaned;
      }
    } catch (e) { /* not a URL */ }
    // Fallback: assume bare code
    const cleaned = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned.length >= ID_LENGTH_MIN && cleaned.length <= ID_LENGTH_MAX) return cleaned;
    return null;
  }

  // Common path after we've extracted a qrid (from scan or paste).
  async function addFriendByQrid(mainEl, qrid) {
    if (qrid === state.myQRid) { await ffAlert(`That's your own code.`); return; }
    if (state.following.some(f => f.qrid === qrid)) { await ffAlert('Already following them.'); return; }
    const name = await ffPrompt(`Add this friend?<br><span style="font-family:ui-monospace,monospace;font-size:13px;color:var(--muted)">${formatId(qrid)}</span>`, {
      placeholder: 'Their name (e.g., John Summit)',
      primaryLabel: 'Add',
    });
    if (!name) return;
    const wasEmpty = state.following.length === 0;
    state.following.push({ qrid, name, initial: deriveInitial(name) });
    saveState();
    subscribeAllFriends();
    render(mainEl);
    // First-friend special case: explain why we need location BEFORE the
    // OS prompt fires. After this, browser asks once and we're set.
    if (wasEmpty) await maybeAskLocationPermission();
  }

  // Show a friendly explainer modal before triggering the browser's
  // native geolocation permission prompt. Only shown once per device
  // (flag in localStorage). User taps OK → native prompt fires.
  async function maybeAskLocationPermission() {
    if (localStorage.getItem('myraverlife-loc-asked-v1') === '1') return;
    if (!navigator.geolocation) return;
    // If already granted/denied, no prompt needed.
    try {
      if (navigator.permissions) {
        const p = await navigator.permissions.query({ name: 'geolocation' });
        if (p.state === 'granted' || p.state === 'denied') {
          localStorage.setItem('myraverlife-loc-asked-v1', '1');
          return;
        }
      }
    } catch (e) {}
    const ok = await ffConfirm(
      `<b>Share your location with friends?</b><br><br>` +
      `Friends needs your location so you appear on their map. ` +
      `Tap <b>Allow</b> when your phone asks.`,
      { primaryLabel: 'OK', cancelLabel: 'Not now' }
    );
    localStorage.setItem('myraverlife-loc-asked-v1', '1');
    if (!ok) return;
    // Trigger the native prompt by actually requesting position.
    navigator.geolocation.getCurrentPosition(
      () => {},  // success — sync loop will start using it
      () => {}   // denied — fail silently; user can retry on Map tab
    );
  }

  // Scanner modal: opens back camera, scans QR live, falls back to paste.
  async function openCameraScanner(mainEl) {
    if (typeof QrScanner === 'undefined') {
      // Lib didn't load — fall back to paste.
      return openPasteFallback(mainEl);
    }
    QrScanner.WORKER_PATH = './vendor/qr-scanner-worker.min.js';

    const backdrop = document.createElement('div');
    backdrop.className = 'ff-modal-backdrop';
    backdrop.innerHTML = `
      <div class="ff-modal ff-scan-modal">
        <div class="ff-scan-title">
          <span>Scan friend's code</span>
          <button class="ff-scan-close" type="button" aria-label="Close">×</button>
        </div>
        <div class="ff-scan-video-wrap">
          <video playsinline muted></video>
          <div class="ff-scan-overlay"></div>
        </div>
        <p class="ff-scan-hint">Point at their <b>QR code</b>. Detects automatically.</p>
        <button type="button" class="ff-scan-paste-btn">Or paste a code instead</button>
      </div>
    `;
    document.body.appendChild(backdrop);

    const video = backdrop.querySelector('video');
    const closeBtn = backdrop.querySelector('.ff-scan-close');
    const pasteBtn = backdrop.querySelector('.ff-scan-paste-btn');
    let scanner = null, closed = false;

    function close() {
      if (closed) return;
      closed = true;
      try { if (scanner) { scanner.stop(); scanner.destroy(); } } catch (e) {}
      backdrop.remove();
    }
    closeBtn.onclick = close;
    pasteBtn.onclick = () => { close(); openPasteFallback(mainEl); };
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    try {
      scanner = new QrScanner(video, async (result) => {
        const text = (result && result.data) || result;
        const qrid = extractQrid(text);
        if (!qrid) return;  // not our format — keep scanning
        close();
        await addFriendByQrid(mainEl, qrid);
      }, {
        preferredCamera: 'environment',
        highlightScanRegion: false,
        highlightCodeOutline: false,
        maxScansPerSecond: 5,
      });
      await scanner.start();
    } catch (err) {
      close();
      console.warn('[findfriend] Camera unavailable:', err);
      await ffAlert(
        `Camera unavailable — likely permission denied or no camera. ` +
        `You can paste the code instead.`
      );
      openPasteFallback(mainEl);
    }
  }

  // Paste fallback when scanner isn't available or user prefers typing.
  async function openPasteFallback(mainEl) {
    const raw = await ffPrompt(
      'Paste your friend\'s code',
      { placeholder: 'e.g., K3FQ72', autocapitalize: 'characters', primaryLabel: 'Next' }
    );
    if (!raw) return;
    const qrid = extractQrid(raw);
    if (!qrid) {
      await ffAlert(`That doesn't look like a valid code.`);
      return;
    }
    await addFriendByQrid(mainEl, qrid);
  }

  function onScan(mainEl) {
    return () => openCameraScanner(mainEl);
  }

  async function onShare() {
    const code = formatId(state.myQRid);
    const url = `https://myraver.life/?friend=${state.myQRid}`;
    const text = `My code: ${code}`;

    // Try image-share first — gets "Save Image" in iOS share sheet so
    // users can save the QR to Photos and show friends later, even
    // offline at the festival.
    try {
      const file = await renderQRAsPNGFile(url);
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: 'Add me on myraver.life',
          text,
          url,
          files: [file],
        });
        return;
      }
    } catch (e) { /* fall through to text-only share */ }

    // Fallback: text + URL only.
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Add me on myraver.life',
          text,
          url,
        });
      } else {
        await navigator.clipboard.writeText(code);
        await ffAlert('Code copied to clipboard.');
      }
    } catch (e) {}
  }

  function onReplace(mainEl) {
    return async () => {
      const ok = await ffConfirm(
        'Get a new code? Friends using your <b>old</b> code will stop seeing you.',
        { primaryLabel: 'New code', danger: true }
      );
      if (!ok) return;
      // Wipe the old server entry so the old code stops resolving for them.
      if (fbDb && fbAuthed) fbDb.ref('loc/' + state.myQRid).remove().catch(() => {});
      state.myQRid = genQRid();
      saveState();
      render(mainEl);
    };
  }

  // ── Public API ────────────────────────────────────────────────────────
  window.findFriends = {
    render,
    getMyQRid() { return state.myQRid; },
    getFollowing() { return state.following.slice(); },
    getFriendData(qrid) {
      const d = friendData[qrid];
      if (!d) return null;
      return { lat: d.lat, lng: d.lng, ts: d.ts };
    },
    colorForInitial,
    freshnessLabel,
    // Expose modal helpers for use elsewhere (e.g., the ?friend= deeplink
    // handler in index.html).
    alert: ffAlert,
    confirm: ffConfirm,
    prompt: ffPrompt,
    addFriendFromUrl(qrid, initial) {
      const cleaned = String(qrid).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (cleaned.length < ID_LENGTH_MIN || cleaned.length > ID_LENGTH_MAX) return false;
      if (cleaned === state.myQRid) return false;
      if (state.following.some(f => f.qrid === cleaned)) return false;
      const init = (initial || '?').slice(0, 2).toUpperCase();
      state.following.push({ qrid: cleaned, name: initial || '?', initial: init });
      saveState();
      subscribeAllFriends();
      return true;
    },
  };
})();
