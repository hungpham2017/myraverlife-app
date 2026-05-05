// findfriend.js — Friends feature, "Connect phase" (no Firebase yet).
//
// Self-contained module. Owns its own CSS, DOM, and localStorage state.
// Exposes window.findFriends with a tiny public API that index.html
// calls when the Friends tab is active.
//
// SCOPE OF THIS PHASE:
//   - Persistent local QR id (6 chars)
//   - QR rendering (offline, qrcode.min.js)
//   - Camera scanning (qr-scanner.min.js)
//   - Modal system (alert / confirm / prompt) for consistent UX
//   - "Following" list stored locally
//   - NO Firebase, NO sync, NO map pins, NO location data
//
// The Firebase sync layer lands in a later phase, on top of this clean
// pure-JS foundation.

(function () {
  'use strict';

  // ── Local state ───────────────────────────────────────────────────────
  const STORAGE_KEY = 'myraverlife-friends-v1';
  const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const ID_LENGTH = 6;
  const ID_LENGTH_MIN = 6;
  const ID_LENGTH_MAX = 16;

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
    if (id.length <= 7) return id;
    return id.match(/.{1,4}/g).join('-');
  }

  const state = loadState();
  if (!state.myQRid) {
    state.myQRid = genQRid();
    saveState();
  }

  // ── F.2: Firebase init (no auth, no RTDB yet) ─────────────────────────
  // Idempotent. Called on Friends-tab open. window.fb is set by the
  // <script type="module"> loader in index.html.
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyAuXsmFF6qVT89be78TbFO0u8ld6j0NaFg',
    authDomain: 'myraverlife.firebaseapp.com',
    databaseURL: 'https://myraverlife-default-rtdb.firebaseio.com',
    projectId: 'myraverlife',
    storageBucket: 'myraverlife.firebasestorage.app',
    messagingSenderId: '753386582338',
    appId: '1:753386582338:web:00414de877a07a82e8d8db',
  };
  let fbApp = null;
  let fbAuth = null;
  let fbAuthed = false;
  let firebaseStatus = 'idle'; // 'idle' | 'connecting' | 'ok' | 'bad'
  // F.11: friendData cache hydrated from localStorage at boot — last-known
  // positions are visible IMMEDIATELY on refresh, even before Firebase
  // reconnects (festival weak-signal scenario).
  const LOCATIONS_KEY = 'myraverlife-friend-locations-v1';
  const friendData = (function () {
    try {
      const raw = localStorage.getItem(LOCATIONS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {};
  })(); // qrid → {lat, lng, ts}
  function persistFriendData() {
    try {
      const out = {};
      Object.keys(friendData).forEach(k => {
        const d = friendData[k];
        if (d && typeof d.lat === 'number') out[k] = { lat: d.lat, lng: d.lng, ts: d.ts };
      });
      localStorage.setItem(LOCATIONS_KEY, JSON.stringify(out));
    } catch (e) {}
  }
  // Prune cached locations for friends the user has since unfollowed
  // (state.following is the source of truth; locations cache shouldn't
  // outlive its friend).
  (function pruneOrphans() {
    let mutated = false;
    Object.keys(friendData).forEach(qrid => {
      if (!state.following.some(f => f.qrid === qrid)) {
        delete friendData[qrid];
        mutated = true;
      }
    });
    if (mutated) persistFriendData();
  })();
  function tryInitFirebase() {
    if (fbApp) return; // already inited, idempotent
    if (!window.fb) { console.log('[fb] window.fb not ready yet'); return; }
    try {
      firebaseStatus = 'connecting';
      fbApp = window.fb.initializeApp(FIREBASE_CONFIG);
      console.log('[fb] initializeApp OK, name=' + fbApp.name);
      maybeRerender();  // refresh status pill
    } catch (e) {
      firebaseStatus = 'bad';
      console.warn('[fb] initializeApp failed:', e);
      maybeRerender();
    }
  }
  // F.3: anonymous sign-in. Fire-and-forget — never awaited at IIFE/render
  // level so we can't hang the UI. Idempotent + in-flight guard so concurrent
  // calls before the promise resolves don't double-fire signInAnonymously.
  let _authInFlight = false;
  function tryAuth() {
    if (fbAuthed || _authInFlight) return;
    if (!fbApp || !window.fb) return;
    _authInFlight = true;
    if (!fbAuth) fbAuth = window.fb.getAuth(fbApp);
    window.fb.signInAnonymously(fbAuth).then((cred) => {
      _authInFlight = false;
      if (cred && cred.user) {
        fbAuthed = true;
        firebaseStatus = 'ok';
        console.log('[fb] auth OK, uid=' + cred.user.uid);
        startPublishLoop();  // F.4 + F.10: publish now + every 30s
        attachPublishTriggers();  // F.10: republish on online + visibility
        trySubscribeAllFriends();  // F.6
        maybeRerender();  // refresh status pill
      } else {
        firebaseStatus = 'bad';
        console.warn('[fb] auth returned no user');
        maybeRerender();
      }
    }).catch((e) => {
      _authInFlight = false;
      firebaseStatus = 'bad';
      console.warn('[fb] auth failed:', e);
      maybeRerender();
    });
  }
  // F.4 + F.10: publish my current GPS to RTDB at /loc/<myQRid>.
  // publishMyLocation() = the bare action, fires GPS + write.
  // startPublishLoop() = idempotent, fires immediately + every 30s.
  // Opportunistic triggers (online, visibilitychange) also call
  // publishMyLocation directly so brief signal windows are caught.
  let fbDb = null;
  let publishTimer = null;
  const PUBLISH_INTERVAL_MS = 30000;
  function publishMyLocation() {
    if (!fbAuthed || !fbApp || !window.fb) return;
    if (!navigator.geolocation) return;
    if (!fbDb) fbDb = window.fb.getDatabase(fbApp);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const path = 'loc/' + state.myQRid;
        window.fb.set(window.fb.ref(fbDb, path), {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          ts: Date.now(),
        }).then(() => {
          console.log('[fb] published my location to /' + path);
        }).catch((e) => {
          console.warn('[fb] publish failed:', e && (e.code || e.message || e));
        });
      },
      (err) => {
        console.warn('[fb] geolocation denied/failed:', err.message);
      },
      { enableHighAccuracy: false, maximumAge: 30000, timeout: 8000 }
    );
  }
  function startPublishLoop() {
    if (publishTimer) return; // already running, idempotent
    publishMyLocation(); // immediate first publish
    publishTimer = setInterval(publishMyLocation, PUBLISH_INTERVAL_MS);
    console.log('[fb] publish loop started (every ' + (PUBLISH_INTERVAL_MS / 1000) + 's)');
  }
  // F.12-style opportunistic triggers: republish on online + visibility.
  // At the festival, signal flickers; even a 200ms window can flush the queue.
  let _publishTriggersAttached = false;
  function attachPublishTriggers() {
    if (_publishTriggersAttached) return;
    _publishTriggersAttached = true;
    window.addEventListener('online', () => { if (fbAuthed) publishMyLocation(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && fbAuthed) publishMyLocation();
    });
  }
  // F.6: subscribe to ALL friends. Idempotent (skip already-subscribed),
  // and clean up subs for friends the user has removed. No UI changes —
  // F.7 wires data into the visible UI.
  const fbSubs = {}; // qrid → unsubscribe fn
  function trySubscribeAllFriends() {
    if (!fbAuthed || !fbApp || !window.fb) return;
    if (!fbDb) fbDb = window.fb.getDatabase(fbApp);
    // Subscribe to any friend we don't already have a sub for.
    state.following.forEach(f => {
      if (fbSubs[f.qrid]) return;
      const path = 'loc/' + f.qrid;
      const r = window.fb.ref(fbDb, path);
      const handler = (snap) => {
        const v = snap.val();
        console.log('[fb] data from /' + path + ':', v);
        if (v && typeof v.lat === 'number' && typeof v.lng === 'number') {
          friendData[f.qrid] = { lat: v.lat, lng: v.lng, ts: v.ts || Date.now() };
          persistFriendData();  // F.11: cache for next refresh / offline
          maybeRerender();  // F.7: paint freshness label
          // F.8: notify map (or any other consumer) that friend's location updated.
          window.dispatchEvent(new CustomEvent('myraver-friend-update', {
            detail: { qrid: f.qrid, lat: v.lat, lng: v.lng, ts: v.ts },
          }));
        }
      };
      window.fb.onValue(r, handler);
      fbSubs[f.qrid] = () => window.fb.off(r, 'value', handler);
      console.log('[fb] subscribed to /' + path);
    });
    // Drop subs for friends no longer in the list.
    Object.keys(fbSubs).forEach(qrid => {
      if (!state.following.some(f => f.qrid === qrid)) {
        try { fbSubs[qrid](); } catch (e) {}
        delete fbSubs[qrid];
        console.log('[fb] unsubscribed /loc/' + qrid + ' (friend removed)');
      }
    });
  }

  // ── CSS injection ─────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .ff-page {
      padding: 12px 12px 90px;
      max-width: 480px;
      margin: 0 auto;
    }
    .ff-qr-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px 12px 10px;
      text-align: center;
    }
    .ff-qr {
      width: 140px; height: 140px;
      margin: 0 auto 8px;
      background: #fff;
      border-radius: 10px;
      padding: 8px;
      box-shadow: 0 3px 14px rgba(0,0,0,0.22);
      display: flex; align-items: center; justify-content: center;
    }
    .ff-qr svg { width: 100%; height: 100%; display: block; }
    .ff-code {
      font-family: ui-monospace, Menlo, monospace;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 2px;
      color: var(--text);
      margin: 4px 0 2px;
    }
    .ff-hint {
      font-size: 12px;
      color: var(--muted);
      margin: 6px 4px 0;
      line-height: 1.45;
    }
    .ff-actions {
      display: flex; gap: 7px;
      margin: 12px 0 4px;
    }
    .ff-btn {
      flex: 1;
      min-height: 36px;
      padding: 8px 6px;
      border-radius: 9px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-size: 12.5px; font-weight: 600;
      letter-spacing: 0.15px;
      text-align: center;
      line-height: 1.2;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.08s ease, background 0.12s ease, border-color 0.12s ease;
    }
    .ff-btn:hover { border-color: rgba(255,255,255,0.18); }
    .ff-btn:active { transform: scale(0.96); }
    .ff-btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .ff-btn-primary:hover { background: var(--accent); border-color: var(--accent); filter: brightness(1.08); }
    .ff-btn-secondary {
      background: transparent;
      color: var(--muted);
      border-color: rgba(255,255,255,0.08);
    }
    .ff-btn-secondary:hover { color: var(--text); }
    .ff-explainer {
      font-size: 11.5px; color: var(--text);
      margin: 12px 0 0; padding: 8px 12px;
      line-height: 1.45;
      background: rgba(255, 79, 163, 0.07);
      border-left: 2px solid var(--accent);
      border-radius: 4px;
    }
    .ff-following {
      margin-top: 12px;
      padding: 10px 14px 4px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px;
      max-height: 50vh; overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    .ff-following h4 {
      margin: 0 0 6px;
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
      display: flex; align-items: center; gap: 10px;
      padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .ff-friend-row:last-child { border-bottom: 0; }
    .ff-friend-dot {
      width: 26px; height: 26px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      color: white; font-size: 10.5px; font-weight: 700; flex-shrink: 0;
    }
    .ff-friend-meta { flex: 1; min-width: 0; }
    .ff-friend-name {
      font-size: 13.5px; font-weight: 600; color: var(--text);
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
    .ff-status {
      display: inline-block; margin-top: 8px;
      font-size: 11px; font-weight: 600; letter-spacing: 0.3px;
      color: var(--muted);
    }
    .ff-status.ok   { color: #5dd07a; }
    .ff-status.bad  { color: #f5b942; }
    .ff-status.idle { color: var(--muted); }
    .ff-friend-x {
      cursor: pointer; padding: 4px 8px; color: var(--muted);
      font-size: 16px; line-height: 1; flex-shrink: 0;
    }
    .ff-friend-x:hover { color: var(--accent); }

    /* ── Modal system ── */
    .ff-modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000;
      padding: 20px;
    }
    .ff-modal {
      background: var(--bg); border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px 18px 14px;
      width: 100%; max-width: 360px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.5);
      animation: ffModalIn 0.16s cubic-bezier(0.2, 0.8, 0.4, 1);
    }
    @keyframes ffModalIn {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0);   }
    }
    .ff-modal-msg {
      font-size: 14px; color: var(--text); line-height: 1.45;
      margin: 0 0 14px;
    }
    .ff-modal-input {
      width: 100%;
      padding: 10px 12px;
      font-size: 14px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border); border-radius: 8px;
      box-sizing: border-box;
      margin: 0 0 14px;
      outline: none;
    }
    .ff-modal-input:focus { border-color: var(--accent); }
    .ff-modal-actions {
      display: flex; gap: 8px; justify-content: flex-end;
    }
    .ff-modal-btn {
      padding: 8px 16px; border-radius: 8px;
      font-size: 14px; font-weight: 600;
      border: 1px solid var(--border);
      background: var(--surface); color: var(--text);
      cursor: pointer;
    }
    .ff-modal-btn-primary {
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      border-color: transparent; color: #fff;
    }
    .ff-modal-btn-danger {
      background: #c0392b; border-color: transparent; color: #fff;
    }

    /* ── Camera scanner (in-app modal) ── */
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
  `;
  document.head.appendChild(style);

  // ── Helpers ───────────────────────────────────────────────────────────
  function colorForInitial(initial) {
    let h = 0;
    for (let i = 0; i < initial.length; i++) h = (h * 31 + initial.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 72%, 58%)`;
  }
  function deriveInitial(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return '?';
    return trimmed.slice(0, 2).toUpperCase();
  }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ── Modal system (replaces native alert / confirm / prompt) ───────────
  function showModal(opts) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'ff-modal-backdrop';
      const modal = document.createElement('div');
      modal.className = 'ff-modal';

      const msg = document.createElement('div');
      msg.className = 'ff-modal-msg';
      msg.innerHTML = opts.message || '';
      modal.appendChild(msg);

      let inputEl = null;
      if (opts.input) {
        inputEl = document.createElement('input');
        inputEl.className = 'ff-modal-input';
        inputEl.type = 'text';
        inputEl.value = opts.defaultValue || '';
        inputEl.placeholder = opts.placeholder || '';
        if (opts.maxLength) inputEl.maxLength = opts.maxLength;
        inputEl.autocapitalize = 'off';
        inputEl.autocomplete = 'off';
        inputEl.spellcheck = false;
        modal.appendChild(inputEl);
      }

      const actions = document.createElement('div');
      actions.className = 'ff-modal-actions';

      function close(value) {
        backdrop.remove();
        resolve(value);
      }

      if (!opts.primaryOnly) {
        const cancel = document.createElement('button');
        cancel.className = 'ff-modal-btn';
        cancel.textContent = opts.cancelLabel || 'Cancel';
        cancel.onclick = () => close(null);
        actions.appendChild(cancel);
      }
      const ok = document.createElement('button');
      ok.className = 'ff-modal-btn ' + (opts.danger ? 'ff-modal-btn-danger' : 'ff-modal-btn-primary');
      ok.textContent = opts.primaryLabel || 'OK';
      ok.onclick = () => close(opts.input ? inputEl.value : true);
      actions.appendChild(ok);

      if (inputEl) {
        inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); ok.click(); }
          if (e.key === 'Escape') { e.preventDefault(); close(null); }
        });
      }

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
      primaryLabel: opts.primaryLabel || 'OK',
    }).then(v => (v === null || v === '') ? null : String(v).trim());
  }

  // ── QR rendering (qrcode-generator lib) ───────────────────────────────
  function renderQRSvg(text) {
    if (typeof qrcode === 'undefined') return '';
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ scalable: true, margin: 0 });
    } catch (e) {
      console.warn('[findfriend] QR render failed:', e);
      return '';
    }
  }

  // ── F.7: freshness label + rerender helper ───────────────────────────
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
  // Distance helpers — kept here so findfriend.js doesn't depend on
  // index.html's scope. Tiny, copied from old friends branch.
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
  // Re-renders ONLY if Friends tab is currently mounted. Prevents recursion
  // (render → onValue handler → maybeRerender → render → ... is impossible
  // because rendering doesn't trigger onValue events; data flows one-way
  // RTDB → handler → friendData → render).
  function maybeRerender() {
    if (activeMainEl && activeMainEl.isConnected && activeMainEl.querySelector('.ff-page')) {
      render(activeMainEl);
    }
  }
  // When user GPS resolves (from index.html's locateUser), rerender so
  // the friends list can show "X ft from you".
  window.addEventListener('myraver-userpos-update', () => maybeRerender());

  // ── Render ────────────────────────────────────────────────────────────
  let activeMainEl = null;

  function render(mainEl) {
    activeMainEl = mainEl;
    const code = formatId(state.myQRid);

    // F.7: status pill labels.
    const statusLabel = ({
      ok: 'syncing', connecting: 'connecting...', bad: 'sync offline', idle: '',
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
        const displayName = f.name || f.initial || '?';
        const initial = f.initial || deriveInitial(displayName);
        // F.7: freshness label from RTDB data (or "waiting for first sync").
        const data = friendData[f.qrid] || {};
        const fresh = freshnessLabel(data.ts);
        // Distance from user (only if both points known).
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
              <div class="ff-friend-sub">${escapeHTML(fresh.text)}${escapeHTML(distLine)}</div>
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
          <p class="ff-hint">Friends scan the QR or paste this code to add you.</p>
          ${statusLabel ? `<span class="ff-status ${statusCls}">● ${statusLabel}</span>` : ''}
        </div>
        <div class="ff-actions">
          <button class="ff-btn ff-btn-primary" id="ff-scan">Scan</button>
          <button class="ff-btn" id="ff-share">Share</button>
          <button class="ff-btn ff-btn-secondary" id="ff-replace">New</button>
        </div>
        <p class="ff-explainer">
          Anyone with your code can see your <b>last-seen</b> location, not
          live tracking. Even a brief window of weak signal is enough to update.
        </p>
        <div class="ff-following">
          <h4>Following<span class="count">${state.following.length}</span></h4>
          ${followingHTML}
        </div>
      </div>
    `;

    mainEl.querySelector('#ff-scan').onclick = () => onScan(mainEl);
    mainEl.querySelector('#ff-share').onclick = onShare;
    mainEl.querySelector('#ff-replace').onclick = onReplace(mainEl);

    // F.2-F.10: init -> auth -> publish loop -> subscribe to all friends.
    // All idempotent, all fire-and-forget. No await anywhere up the call stack.
    tryInitFirebase();
    tryAuth();
    startPublishLoop();        // immediate publish + every 30s (idempotent)
    attachPublishTriggers();   // republish on online + visibility (idempotent)
    trySubscribeAllFriends();
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
        // F.11: drop cached location data for the unfollowed friend.
        if (fbSubs[f.qrid]) { try { fbSubs[f.qrid](); } catch (e) {} delete fbSubs[f.qrid]; }
        delete friendData[f.qrid];
        persistFriendData();
        state.following.splice(i, 1);
        saveState();
        render(mainEl);
      };
    });
  }

  // ── Scan flow ─────────────────────────────────────────────────────────
  function extractQrid(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    try {
      const u = new URL(s);
      const param = u.searchParams.get('friend');
      if (param) {
        const cleaned = param.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (cleaned.length >= ID_LENGTH_MIN && cleaned.length <= ID_LENGTH_MAX) return cleaned;
      }
    } catch (e) {}
    const cleaned = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned.length >= ID_LENGTH_MIN && cleaned.length <= ID_LENGTH_MAX) return cleaned;
    return null;
  }

  async function addFriendByQrid(mainEl, qrid) {
    if (qrid === state.myQRid) { await ffAlert(`That's your own code.`); return; }
    if (state.following.some(f => f.qrid === qrid)) { await ffAlert('Already following them.'); return; }
    const name = await ffPrompt(
      `Add this friend?<br><span style="font-family:ui-monospace,monospace;font-size:13px;color:var(--muted)">${formatId(qrid)}</span>`,
      { placeholder: 'Their name (e.g., John Summit)', primaryLabel: 'Add' }
    );
    if (!name) return;
    state.following.push({ qrid, name, initial: deriveInitial(name) });
    saveState();
    render(mainEl);
  }

  // In-app camera scanner modal: opens back camera, scans QR live,
  // falls back to paste on permission denial or unavailability.
  async function onScan(mainEl) {
    if (typeof QrScanner === 'undefined') {
      return pasteFlow(mainEl);
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
    pasteBtn.onclick = () => { close(); pasteFlow(mainEl); };
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
      pasteFlow(mainEl);
    }
  }

  async function pasteFlow(mainEl) {
    const raw = await ffPrompt(
      'Paste your friend\'s code:',
      { placeholder: 'e.g., K3FQ72', primaryLabel: 'Add' }
    );
    if (!raw) return;
    const qrid = extractQrid(raw);
    if (!qrid) { await ffAlert(`That doesn't look like a valid code.`); return; }
    addFriendByQrid(mainEl, qrid);
  }

  // ── Share ─────────────────────────────────────────────────────────────
  async function onShare() {
    const url = `https://myraver.life/?friend=${state.myQRid}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Add me on My Raver Life', text: `My code: ${formatId(state.myQRid)}`, url }); }
      catch (e) { /* user cancelled */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      await ffAlert(`Link copied:<br><span style="font-family:ui-monospace,monospace;font-size:13px;color:var(--muted)">${url}</span>`);
    } catch (e) {
      await ffAlert(`Your link:<br><span style="font-family:ui-monospace,monospace;font-size:13px;color:var(--muted)">${url}</span>`);
    }
  }

  // ── Replace QR id ─────────────────────────────────────────────────────
  function onReplace(mainEl) {
    return async () => {
      const ok = await ffConfirm(
        `Generate a new code? Friends with your old code won't see you anymore.`,
        { primaryLabel: 'New code', danger: true }
      );
      if (!ok) return;
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
    // F.8: map needs these to render friend pins.
    getFriendData(qrid) {
      const d = friendData[qrid];
      if (!d) return null;
      return { lat: d.lat, lng: d.lng, ts: d.ts };
    },
    colorForInitial,
    freshnessLabel,  // F.9: bottom sheet uses same format as Friends tab
    addFriendFromUrl(qrid, initial) {
      const cleaned = String(qrid).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (cleaned.length < ID_LENGTH_MIN || cleaned.length > ID_LENGTH_MAX) return false;
      if (cleaned === state.myQRid) return false;
      if (state.following.some(f => f.qrid === cleaned)) return false;
      const init = (initial || '?').slice(0, 2).toUpperCase();
      state.following.push({ qrid: cleaned, name: initial || '?', initial: init });
      saveState();
      return true;
    },
    alert: ffAlert,
    confirm: ffConfirm,
    prompt: ffPrompt,
  };
})();
