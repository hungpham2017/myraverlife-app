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
  const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const ID_LENGTH = 12;
  const PUBLISH_INTERVAL_MS = 60000;

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
  function formatId(id) { return id.match(/.{1,4}/g).join('-'); }

  const state = loadState();
  if (!state.myQRid) {
    state.myQRid = genQRid();
    saveState();
  }

  // friendData[qrid] = { lat, lng, ts, _unsub? }
  const friendData = {};

  // ── CSS injection ─────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .ff-page { max-width: 480px; margin: 0 auto; padding: 16px 16px 40px; }
    .ff-qr-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 14px; padding: 22px 18px 20px; text-align: center;
      margin-bottom: 18px;
    }
    .ff-qr-placeholder {
      width: 200px; height: 200px; margin: 0 auto 14px;
      background: linear-gradient(135deg, rgba(255,79,163,0.12), rgba(0,212,255,0.12));
      border: 1px dashed rgba(255,255,255,0.18); border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
      font-family: ui-monospace, monospace; font-size: 13px; font-weight: 700;
      letter-spacing: 1px; color: var(--text); padding: 14px; line-height: 1.6;
    }
    .ff-code {
      font-family: ui-monospace, monospace; font-size: 17px; font-weight: 700;
      letter-spacing: 1.5px; color: var(--text); margin: 6px 0 10px;
    }
    .ff-hint { font-size: 13px; color: var(--muted); margin: 0; line-height: 1.45; }
    .ff-status {
      display: inline-block; margin-top: 10px;
      font-size: 11px; font-weight: 600; letter-spacing: 0.4px;
      padding: 3px 9px; border-radius: 999px;
    }
    .ff-status.ok { background: rgba(46,160,67,0.18); color: #5dd07a; }
    .ff-status.bad { background: rgba(255,80,80,0.18); color: #ff8080; }
    .ff-status.idle { background: rgba(255,255,255,0.06); color: var(--muted); }
    .ff-actions { display: flex; flex-direction: column; gap: 10px; margin-bottom: 28px; }
    .ff-btn {
      width: 100%; padding: 13px 16px; border-radius: 10px;
      border: 1px solid var(--border); background: var(--surface);
      color: var(--text); font-size: 14.5px; font-weight: 600;
      cursor: pointer; text-align: center; letter-spacing: 0.2px;
    }
    .ff-btn:active { transform: scale(0.98); }
    .ff-btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
    .ff-btn-secondary {
      background: transparent; color: var(--muted);
      border-color: rgba(255,255,255,0.08);
    }
    .ff-following {
      margin-top: 8px; padding: 14px 16px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px;
    }
    .ff-following h4 {
      margin: 0 0 10px; font-size: 12px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.6px; color: var(--muted);
    }
    .ff-following-empty { font-size: 13px; color: var(--muted); margin: 0; }
    .ff-friend-row {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .ff-friend-row:last-child { border-bottom: 0; }
    .ff-friend-dot {
      width: 28px; height: 28px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      color: white; font-size: 11px; font-weight: 700; flex-shrink: 0;
    }
    .ff-friend-meta { flex: 1; min-width: 0; }
    .ff-friend-name {
      font-size: 14px; font-weight: 600; color: var(--text);
      line-height: 1.2;
    }
    .ff-friend-sub {
      font-size: 11.5px; color: var(--muted); margin-top: 2px;
      font-variant-numeric: tabular-nums;
    }
    .ff-friend-fresh-green { color: #5dd07a; }
    .ff-friend-fresh-yellow { color: #f5b942; }
    .ff-friend-fresh-grey { color: var(--muted); }
    .ff-friend-x {
      cursor: pointer; padding: 4px 8px; color: var(--muted);
      font-size: 16px; line-height: 1; flex-shrink: 0;
    }
    .ff-friend-x:hover { color: var(--accent); }
  `;
  document.head.appendChild(style);

  // ── Firebase ──────────────────────────────────────────────────────────
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
          friendData[f.qrid]._unsub = friendData[f.qrid]._unsub;  // preserve
          maybeRerender();
        }
      };
      ref.on('value', handler);
      friendData[f.qrid] = friendData[f.qrid] || {};
      friendData[f.qrid]._unsub = () => ref.off('value', handler);
    });
    // Clean up unsubscribed friends
    Object.keys(friendData).forEach(qrid => {
      if (!state.following.some(f => f.qrid === qrid)) {
        if (friendData[qrid]._unsub) friendData[qrid]._unsub();
        delete friendData[qrid];
      }
    });
  }

  function startSyncLoop() {
    if (publishTimer) return;
    publishMyLocation();
    publishTimer = setInterval(publishMyLocation, PUBLISH_INTERVAL_MS);
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function colorForInitial(initial) {
    let h = 0;
    for (let i = 0; i < initial.length; i++) h = (h * 31 + initial.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 72%, 58%)`;
  }
  function freshnessLabel(ts) {
    if (!ts) return { text: 'no fix yet', cls: 'ff-friend-fresh-grey' };
    const ago = Date.now() - ts;
    const m = Math.floor(ago / 60000);
    if (m < 1) return { text: 'just now', cls: 'ff-friend-fresh-green' };
    if (m < 2) return { text: '1 min ago', cls: 'ff-friend-fresh-green' };
    if (m < 15) return { text: m + ' min ago', cls: 'ff-friend-fresh-yellow' };
    if (m < 60) return { text: m + ' min ago', cls: 'ff-friend-fresh-grey' };
    const h = Math.floor(m / 60);
    if (h < 24) return { text: h + (h === 1 ? ' hr' : ' hrs') + ' ago', cls: 'ff-friend-fresh-grey' };
    return { text: Math.floor(h / 24) + 'd ago', cls: 'ff-friend-fresh-grey' };
  }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ── Render ────────────────────────────────────────────────────────────
  let activeMainEl = null;       // tracks if Friends tab is currently rendered
  let rerenderInterval = null;   // refreshes "X min ago" labels while tab is open

  function maybeRerender() {
    if (activeMainEl && activeMainEl.isConnected) render(activeMainEl);
  }

  function render(mainEl) {
    activeMainEl = mainEl;
    if (rerenderInterval) clearInterval(rerenderInterval);
    rerenderInterval = setInterval(() => {
      if (activeMainEl && activeMainEl.isConnected) render(activeMainEl);
      else { clearInterval(rerenderInterval); rerenderInterval = null; }
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
      followingHTML = state.following.map((f, i) => {
        const data = friendData[f.qrid] || {};
        const fresh = freshnessLabel(data.ts);
        const sub = data.lat
          ? `<span class="${fresh.cls}">${escapeHTML(fresh.text)}</span> · ${data.lat.toFixed(4)}, ${data.lng.toFixed(4)}`
          : `<span class="ff-friend-fresh-grey">${escapeHTML(fresh.text)}</span>`;
        return `
          <div class="ff-friend-row">
            <div class="ff-friend-dot" style="background:${colorForInitial(f.initial)}">${escapeHTML(f.initial)}</div>
            <div class="ff-friend-meta">
              <div class="ff-friend-name">${escapeHTML(f.initial)}</div>
              <div class="ff-friend-sub">${sub}</div>
            </div>
            <div class="ff-friend-x" data-remove="${i}" aria-label="Remove">✕</div>
          </div>
        `;
      }).join('');
    }

    mainEl.innerHTML = `
      <div class="ff-page">
        <div class="ff-qr-card">
          <div class="ff-qr-placeholder">QR coming soon<br><span style="opacity:0.6;font-weight:500">(real QR<br>in next pass)</span></div>
          <div class="ff-code">${code}</div>
          <p class="ff-hint">Show this code to friends to put you on their map.</p>
          ${statusLabel ? `<span class="ff-status ${statusCls}">● ${statusLabel}</span>` : ''}
        </div>
        <div class="ff-actions">
          <button class="ff-btn ff-btn-primary" id="ff-scan">📷 Scan a friend's code</button>
          <button class="ff-btn" id="ff-share">📤 Share my code</button>
          <button class="ff-btn ff-btn-secondary" id="ff-replace">↻ Replace my code</button>
        </div>
        <div class="ff-following">
          <h4>Following (${state.following.length})</h4>
          ${followingHTML}
        </div>
      </div>
    `;

    mainEl.querySelector('#ff-scan').onclick = onScan(mainEl);
    mainEl.querySelector('#ff-share').onclick = onShare;
    mainEl.querySelector('#ff-replace').onclick = onReplace(mainEl);
    mainEl.querySelectorAll('[data-remove]').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        const i = +el.dataset.remove;
        const f = state.following[i];
        if (!confirm(`Stop following ${f.initial}?`)) return;
        if (friendData[f.qrid] && friendData[f.qrid]._unsub) friendData[f.qrid]._unsub();
        delete friendData[f.qrid];
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

  function onScan(mainEl) {
    return () => {
      const raw = prompt('Paste your friend\'s code:');
      if (!raw) return;
      const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (cleaned.length !== ID_LENGTH) {
        alert(`That doesn't look like a valid code. Codes are ${ID_LENGTH} characters.`);
        return;
      }
      if (cleaned === state.myQRid) { alert(`That's your own code.`); return; }
      if (state.following.some(f => f.qrid === cleaned)) { alert('Already following them.'); return; }
      const nick = prompt('Set their initial(s) for the dot (1–2 letters):');
      if (!nick) return;
      const initial = nick.trim().slice(0, 2).toUpperCase() || '?';
      state.following.push({ qrid: cleaned, initial });
      saveState();
      subscribeAllFriends();
      render(mainEl);
    };
  }

  async function onShare() {
    const code = formatId(state.myQRid);
    const url = `https://myraver.life/?friend=${state.myQRid}`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Add me on myraver.life',
          text: `My code: ${code}`,
          url,
        });
      } else {
        await navigator.clipboard.writeText(code);
        alert('Code copied to clipboard.');
      }
    } catch (e) {}
  }

  function onReplace(mainEl) {
    return () => {
      if (!confirm('Replace your code? Friends will need to scan the new one.')) return;
      // Wipe the old server entry so the old code stops resolving.
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
    addFriendFromUrl(qrid, initial) {
      const cleaned = String(qrid).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (cleaned.length !== ID_LENGTH) return false;
      if (cleaned === state.myQRid) return false;
      if (state.following.some(f => f.qrid === cleaned)) return false;
      state.following.push({ qrid: cleaned, initial: (initial || '?').slice(0, 2).toUpperCase() });
      saveState();
      subscribeAllFriends();
      return true;
    },
  };
})();
