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
    return {};
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

  // v210 schema: { myQRid, myName, currentGroup, groupMembers }
  // - currentGroup: null = idle (not in any group), myQRid = hosting,
  //   any other qrid = member of that user's group.
  // - myQRid is the persistent device identity for /loc and /presence.
  // - myName is set when user takes their first Host or Join action.
  // - groupMembers caches the current group's members for offline render.
  // Migration from earlier schema: drop legacy `following` array.
  const state = loadState();
  if (!state.myQRid) state.myQRid = genQRid();
  if (typeof state.myName !== 'string') state.myName = null;
  if (state.currentGroup === undefined) state.currentGroup = null;
  if (!state.groupMembers || typeof state.groupMembers !== 'object') state.groupMembers = {};
  if (!state.pins || typeof state.pins !== 'object') state.pins = {};
  if (typeof state._myPinActionTs !== 'number') state._myPinActionTs = 0;
  if (state.following) delete state.following;
  saveState();

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
  // Auto-purge cached friend locations older than 48h. Privacy on lost
  // or borrowed phones — stale data shouldn't linger forever.
  const FRIEND_DATA_TTL_MS = 48 * 60 * 60 * 1000;
  const friendData = (function () {
    try {
      const raw = localStorage.getItem(LOCATIONS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      const cutoff = Date.now() - FRIEND_DATA_TTL_MS;
      Object.keys(parsed).forEach(k => {
        if (!parsed[k] || !parsed[k].ts || parsed[k].ts < cutoff) delete parsed[k];
      });
      return parsed;
    } catch (e) { return {}; }
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
  // Prune cached locations for qrids no longer in current group.
  // When idle (no group), prune everything.
  (function pruneOrphans() {
    let mutated = false;
    const valid = new Set();
    if (state.currentGroup) {
      valid.add(state.currentGroup);  // host
      Object.keys(state.groupMembers || {}).forEach(q => valid.add(q));
    }
    Object.keys(friendData).forEach(qrid => {
      if (!valid.has(qrid)) {
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
        subscribeCurrentGroup();  // v210: subscribe to current group's circle
        watchConnection();  // pill tracks .info/connected, not just auth
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
    if (!state.currentGroup) return;  // idle, no audience expected
    if (!fbAuthed || !fbApp || !window.fb) return;
    if (!navigator.geolocation) return;
    if (!fbDb) fbDb = window.fb.getDatabase(fbApp);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const path = 'loc/' + state.myQRid;
        // Defensive cap: if pos.timestamp is suspiciously stale (>5 min old),
        // fall back to Date.now(). Protects against DevTools sensor overrides
        // returning ancient timestamps and other browser quirks.
        const fixAge = Date.now() - (pos.timestamp || 0);
        const ts = (fixAge > 5 * 60 * 1000) ? Date.now() : (pos.timestamp || Date.now());
        window.fb.set(window.fb.ref(fbDb, path), {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          ts,
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
  // Subscribe to RTDB's .info/connected so the status pill reflects real
  // connection state, not just initial auth success. Without this, the pill
  // stays green "syncing" forever even after the WebSocket dies.
  let _connWatchAttached = false;
  function watchConnection() {
    if (_connWatchAttached) return;
    if (!fbAuthed || !fbApp || !window.fb) return;
    if (!fbDb) fbDb = window.fb.getDatabase(fbApp);
    _connWatchAttached = true;
    window.fb.onValue(window.fb.ref(fbDb, '.info/connected'), (snap) => {
      const connected = snap.val() === true;
      firebaseStatus = connected ? 'ok' : 'bad';
      maybeRerender();
      if (connected) {
        writePresence();
        // Post-reconnect: if I'm a member and haven't confirmed the host
        // exists, validate now. Catches phantom groups that were joined
        // with bad codes while offline (where pre-validation was skipped).
        if (state.currentGroup && state.currentGroup !== state.myQRid && _hostSeenForGroup !== state.currentGroup) {
          if (!fbDb) fbDb = window.fb.getDatabase(fbApp);
          const hostRef = window.fb.ref(fbDb, 'circles/' + state.currentGroup + '/' + state.currentGroup);
          let resolved = false;
          const validateOnce = (s) => {
            if (resolved) return;
            resolved = true;
            try { window.fb.off(hostRef, 'value', validateOnce); } catch (e) {}
            if (!s.val() && state.currentGroup && _hostSeenForGroup !== state.currentGroup) {
              // Phantom — bump to idle.
              console.log('[fb] post-reconnect: host missing, bumping phantom group to idle');
              const oldHost = state.currentGroup;
              state.currentGroup = null;
              state.groupMembers = {};
              state.pins = {};
              saveState();
              if (currentGroupSub) { try { currentGroupSub(); } catch (e) {} currentGroupSub = null; }
              if (meetingsSub) { try { meetingsSub(); } catch (e) {} meetingsSub = null; }
              tearDownAllMemberSubs();
              try { window.fb.remove(window.fb.ref(fbDb, 'circles/' + oldHost + '/' + state.myQRid)); } catch (e) {}
              try { window.fb.remove(window.fb.ref(fbDb, 'meetings/' + oldHost + '/' + state.myQRid)); } catch (e) {}
              ffAlert(`Group not found.<br>The code didn't match any active group.`);
              maybeRerender();
            }
          };
          window.fb.onValue(hostRef, validateOnce);
          setTimeout(() => { if (!resolved) { try { window.fb.off(hostRef, 'value', validateOnce); } catch (e) {} } }, 6000);
        }
      }
    });
    console.log('[fb] watching .info/connected');
  }
  // Write /presence/<self> with onDisconnect. Called from .info/connected
  // (covers reconnects) AND from subscribeCurrentGroup (covers idle→in-group
  // transitions when .info/connected was already 'true'). Idempotent enough.
  function writePresence() {
    if (!fbAuthed || !fbApp || !window.fb) return;
    if (!state.currentGroup) return;  // idle: no presence
    if (!fbDb) fbDb = window.fb.getDatabase(fbApp);
    const presRef = window.fb.ref(fbDb, 'presence/' + state.myQRid);
    window.fb.onDisconnect(presRef)
      .set({ online: false, lastOffline: window.fb.serverTimestamp() })
      .then(() => window.fb.set(presRef, { online: true }))
      .catch((e) => console.warn('[fb] presence setup failed:', e));
  }
  // v210: subscribe to current group's /circles/<host>. The host writes
  // themselves at /circles/<host>/<host>; members write at /circles/<host>/<self>.
  // When the host wipes their /circles/<host> (disband / regen / join elsewhere),
  // the snapshot becomes empty → members detect dissolution and bump to idle.
  let currentGroupSub = null;
  let meetingsSub = null;          // unsubscribe fn for /meetings/<currentGroup>
  const memberLocSubs = {};       // qrid → unsubscribe fn (loc)
  const memberPresenceSubs = {};  // qrid → unsubscribe fn (presence)
  // Tracks when I last wrote/deleted my own pin locally. Used to ignore
  // older /meetings snapshots that would otherwise stomp my optimistic
  // update with stale server data during the brief sync window. Persisted
  // to localStorage so it survives tab kill / reload.
  let _myPinActionTs = state._myPinActionTs || 0;
  // Track which group's host we've confirmed exists. Module-level so it
  // survives subscribeCurrentGroup re-calls in the same session — without
  // this, a re-subscribe after the host left can write us back into a
  // phantom group and never trigger dissolution.
  let _hostSeenForGroup = null;

  function tearDownAllMemberSubs() {
    Object.values(memberLocSubs).forEach(fn => { try { fn(); } catch (e) {} });
    Object.values(memberPresenceSubs).forEach(fn => { try { fn(); } catch (e) {} });
    Object.keys(memberLocSubs).forEach(k => delete memberLocSubs[k]);
    Object.keys(memberPresenceSubs).forEach(k => delete memberPresenceSubs[k]);
  }

  function subscribeCurrentGroup() {
    if (!fbAuthed || !fbApp || !window.fb) return;
    if (!fbDb) fbDb = window.fb.getDatabase(fbApp);

    // Tear down any prior subs (group switch needs a clean slate).
    if (currentGroupSub) { try { currentGroupSub(); } catch (e) {} currentGroupSub = null; }
    if (meetingsSub) { try { meetingsSub(); } catch (e) {} meetingsSub = null; }
    tearDownAllMemberSubs();

    if (!state.currentGroup) return;  // idle: no group, no subs

    // Write self into the group with current name. Host writes themselves too
    // so members can render the host with their name.
    const myMemberRef = window.fb.ref(fbDb, 'circles/' + state.currentGroup + '/' + state.myQRid);
    window.fb.set(myMemberRef, {
      name: state.myName || '?',
      isHost: state.currentGroup === state.myQRid,
      ts: Date.now(),
    }).catch(e => console.warn('[fb] write self to circle failed:', e));

    // Also (re-)write presence: idle→in-group transitions don't hit the
    // .info/connected handler, so presence wouldn't be set otherwise.
    writePresence();

    // Subscribe to circle members.
    const groupRef = window.fb.ref(fbDb, 'circles/' + state.currentGroup);
    // Reset _hostSeenForGroup if we're now subscribed to a different group.
    if (_hostSeenForGroup !== state.currentGroup) _hostSeenForGroup = null;
    const handler = (snap) => {
      const v = snap.val() || {};

      // Group-dissolved detection (members only): only fire AFTER we've
      // confirmed the host's entry exists for THIS group at some point.
      // _hostSeenForGroup persists across subscribe calls in the same
      // session, so a re-subscribe after the host leaves still detects.
      const iAmMember = state.currentGroup !== state.myQRid;
      if (iAmMember && v[state.currentGroup]) _hostSeenForGroup = state.currentGroup;
      if (iAmMember && _hostSeenForGroup === state.currentGroup && !v[state.currentGroup]) {
        console.log('[fb] group dissolved by host — bumping to idle');
        const oldHost = state.currentGroup;
        const oldHostName = (state.groupMembers[oldHost] && state.groupMembers[oldHost].name) || 'The host';
        state.currentGroup = null;
        state.groupMembers = {};
        _hostSeenForGroup = null;
        saveState();
        if (currentGroupSub) { try { currentGroupSub(); } catch (e) {} currentGroupSub = null; }
        tearDownAllMemberSubs();
        // Race recovery: if subscribeCurrentGroup just wrote our entry into
        // the now-dissolved group's path, remove it.
        try { window.fb.remove(window.fb.ref(fbDb, 'circles/' + oldHost + '/' + state.myQRid)); } catch (e) {}
        ffAlert(escapeHTML(oldHostName) + ' ended the group.');
        maybeRerender();
        return;
      }

      // Build groupMembers from snapshot (excluding self).
      state.groupMembers = {};
      Object.keys(v).forEach(qrid => {
        if (qrid === state.myQRid) return;
        const e = v[qrid] || {};
        state.groupMembers[qrid] = {
          name: e.name || '?',
          initial: deriveInitial(e.name || '?'),
          isHost: !!e.isHost,
        };
      });
      saveState();

      // Subscribe per-member /loc + /presence (idempotent).
      Object.keys(state.groupMembers).forEach(qrid => {
        if (!memberLocSubs[qrid]) {
          const locRef = window.fb.ref(fbDb, 'loc/' + qrid);
          const locHandler = (s) => {
            const lv = s.val();
            if (lv && typeof lv.lat === 'number' && typeof lv.lng === 'number') {
              friendData[qrid] = friendData[qrid] || {};
              friendData[qrid].lat = lv.lat;
              friendData[qrid].lng = lv.lng;
              friendData[qrid].ts = lv.ts || Date.now();
              persistFriendData();
              maybeRerender();
              window.dispatchEvent(new CustomEvent('myraver-friend-update', {
                detail: { qrid, lat: lv.lat, lng: lv.lng, ts: lv.ts },
              }));
            }
          };
          window.fb.onValue(locRef, locHandler);
          memberLocSubs[qrid] = () => window.fb.off(locRef, 'value', locHandler);
        }
        if (!memberPresenceSubs[qrid]) {
          const presRef = window.fb.ref(fbDb, 'presence/' + qrid);
          const presHandler = (s) => {
            const pv = s.val();
            friendData[qrid] = friendData[qrid] || {};
            friendData[qrid].online = !!(pv && pv.online === true);
            maybeRerender();
          };
          window.fb.onValue(presRef, presHandler);
          memberPresenceSubs[qrid] = () => window.fb.off(presRef, 'value', presHandler);
        }
      });
      // Drop subs for members no longer in the group.
      Object.keys(memberLocSubs).forEach(qrid => {
        if (!state.groupMembers[qrid]) {
          try { memberLocSubs[qrid](); } catch (e) {}
          delete memberLocSubs[qrid];
        }
      });
      Object.keys(memberPresenceSubs).forEach(qrid => {
        if (!state.groupMembers[qrid]) {
          try { memberPresenceSubs[qrid](); } catch (e) {}
          delete memberPresenceSubs[qrid];
        }
      });

      maybeRerender();
    };
    window.fb.onValue(groupRef, handler);
    currentGroupSub = () => window.fb.off(groupRef, 'value', handler);
    console.log('[fb] subscribed to /circles/' + state.currentGroup);

    // Subscribe to all pins (meetings) under this group's host.
    const meetingsRef = window.fb.ref(fbDb, 'meetings/' + state.currentGroup);
    const meetingsHandler = (snap) => {
      const v = snap.val() || {};
      const newPins = {};
      Object.keys(v).forEach(qrid => {
        const e = v[qrid] || {};
        if (typeof e.lat === 'number' && typeof e.lng === 'number' && typeof e.message === 'string') {
          newPins[qrid] = { lat: e.lat, lng: e.lng, message: e.message, ts: e.ts || Date.now(), by: e.by || '' };
        }
      });
      // Race-protect my own entry: if I just dropped/removed locally and the
      // snapshot's ts is older than my last action, prefer my local state.
      const mySnap = newPins[state.myQRid];
      const snapTs = mySnap ? (mySnap.ts || 0) : 0;
      if (_myPinActionTs && _myPinActionTs > snapTs) {
        if (state.pins[state.myQRid]) {
          newPins[state.myQRid] = state.pins[state.myQRid];
        } else {
          delete newPins[state.myQRid];
        }
      }
      state.pins = newPins;
      saveState();
      maybeRerender();
      window.dispatchEvent(new CustomEvent('myraver-pins-update'));
    };
    window.fb.onValue(meetingsRef, meetingsHandler);
    meetingsSub = () => window.fb.off(meetingsRef, 'value', meetingsHandler);
    console.log('[fb] subscribed to /meetings/' + state.currentGroup);
  }

  // ── Pin actions ──────────────────────────────────────────────────────
  function getMyPin() {
    return state.pins[state.myQRid] || null;
  }
  // Drop or move a pin. Optimistic local update first, then cloud sync.
  // Same pattern as group state changes — UI doesn't wait on the network.
  async function dropMyPin(message, lat, lng) {
    if (!state.currentGroup) { console.warn('[pin] cannot drop pin while idle'); return false; }
    if (typeof message !== 'string' || !message.trim()) return false;
    if (lat == null || lng == null) {
      const pos = window._lastUserPos;
      if (!pos) {
        await ffAlert(`Need your GPS to drop a pin here.<br>Tap Map and allow location, then try again.`);
        return false;
      }
      lat = pos.lat; lng = pos.lng;
    }
    const cleanMsg = message.trim().slice(0, 100);
    const data = { lat, lng, message: cleanMsg, ts: Date.now(), by: state.myName || '?' };

    // 1. Optimistic local — UI updates instantly. Tracks ts so older
    // server snapshots can't stomp this. Persist ts to survive reload.
    _myPinActionTs = data.ts;
    state._myPinActionTs = _myPinActionTs;
    state.pins[state.myQRid] = data;
    saveState();
    maybeRerender();
    window.dispatchEvent(new CustomEvent('myraver-pins-update'));

    // 2. Cloud sync (Firebase queues + retries on reconnect if offline).
    if (!fbAuthed || !fbApp || !window.fb) return true;  // local saved, cloud will retry
    if (!fbDb) fbDb = window.fb.getDatabase(fbApp);
    const ref = window.fb.ref(fbDb, 'meetings/' + state.currentGroup + '/' + state.myQRid);
    window.fb.set(ref, data).catch(e => console.warn('[pin] drop cloud sync failed:', e));
    return true;
  }
  async function removeMyPin() {
    console.log('[pin] removeMyPin called. currentGroup=', state.currentGroup, ' myQRid=', state.myQRid);
    if (!state.currentGroup) { console.warn('[pin] cannot remove: no current group'); return; }

    // 1. Optimistic local — pin disappears from UI instantly. Stamp the
    // action so older snapshots can't restore the deleted pin. Persist ts.
    _myPinActionTs = Date.now();
    state._myPinActionTs = _myPinActionTs;
    delete state.pins[state.myQRid];
    saveState();
    maybeRerender();
    window.dispatchEvent(new CustomEvent('myraver-pins-update'));

    // 2. Cloud sync (queues in memory if offline, retries on reconnect).
    if (!fbAuthed || !fbApp || !window.fb) return;
    if (!fbDb) fbDb = window.fb.getDatabase(fbApp);
    const path = 'meetings/' + state.currentGroup + '/' + state.myQRid;
    window.fb.remove(window.fb.ref(fbDb, path))
      .then(() => console.log('[pin] removed /' + path))
      .catch(e => console.warn('[pin] remove cloud sync failed:', e));
  }
  async function updateMyPinPosition(lat, lng) {
    const cur = getMyPin();
    if (!cur) return false;
    return dropMyPin(cur.message, lat, lng);
  }

  // ── State transitions ─────────────────────────────────────────────────
  // host new group: idle/host/member → host with fresh qrid + name.
  async function hostNewGroup(mainEl) {
    if (state.currentGroup === state.myQRid) {
      // Already hosting; create new = end old.
      const ok = await ffConfirm(
        `Start a new group? This ends your current group for everyone.`,
        { primaryLabel: 'Continue', danger: true }
      );
      if (!ok) return;
      if (fbDb && fbAuthed && window.fb) {
        try { await window.fb.remove(window.fb.ref(fbDb, 'circles/' + state.myQRid)); } catch (e) {}
        try { await window.fb.remove(window.fb.ref(fbDb, 'meetings/' + state.myQRid)); } catch (e) {}
        try { await window.fb.remove(window.fb.ref(fbDb, 'loc/' + state.myQRid)); } catch (e) {}
        try { await window.fb.remove(window.fb.ref(fbDb, 'presence/' + state.myQRid)); } catch (e) {}
      }
    } else if (state.currentGroup) {
      // Member of someone else's group.
      const ok = await ffConfirm(
        `Leave your current group to host a new one?`,
        { primaryLabel: 'Continue' }
      );
      if (!ok) return;
      if (fbDb && fbAuthed && window.fb) {
        try { await window.fb.remove(window.fb.ref(fbDb, 'circles/' + state.currentGroup + '/' + state.myQRid)); } catch (e) {}
        try { await window.fb.remove(window.fb.ref(fbDb, 'meetings/' + state.currentGroup + '/' + state.myQRid)); } catch (e) {}
      }
    }
    const name = await ffPrompt(
      'Choose your display name:',
      { placeholder: 'Your name', primaryLabel: 'Host group', defaultValue: state.myName || '', maxLength: 24 }
    );
    if (!name) return;
    state.myName = name;
    state.myQRid = genQRid();  // fresh identity for fresh group
    state.currentGroup = state.myQRid;
    state.groupMembers = {};
    state.pins = {};
    saveState();
    subscribeCurrentGroup();
    if (fbAuthed) publishMyLocation();
    render(mainEl);
  }

  // join group: any → member of target.
  async function joinGroupFlow(mainEl, targetQrid) {
    if (targetQrid === state.myQRid) { await ffAlert(`That's your own code.`); return; }
    if (targetQrid === state.currentGroup) { await ffAlert(`You're already in this group.`); return; }

    // Pre-validate ONLY when online. Offline users at the festival can
    // still trust their scan (they're literally pointing at a friend's
    // phone). Their join will sync to cloud when signal returns; if the
    // code was fake, they'll see no one until signal anyway.
    if (firebaseStatus === 'ok' && fbAuthed && fbApp && window.fb) {
      if (!fbDb) fbDb = window.fb.getDatabase(fbApp);
      const hostExists = await new Promise((resolve) => {
        let resolved = false;
        const hostRef = window.fb.ref(fbDb, 'circles/' + targetQrid + '/' + targetQrid);
        const handler = (snap) => {
          if (resolved) return;
          resolved = true;
          try { window.fb.off(hostRef, 'value', handler); } catch (e) {}
          resolve(!!snap.val());
        };
        window.fb.onValue(hostRef, handler);
        setTimeout(() => {
          if (resolved) return;
          resolved = true;
          try { window.fb.off(hostRef, 'value', handler); } catch (e) {}
          resolve(false);
        }, 6000);  // generous on weak festival signal
      });
      if (!hostExists) {
        await ffAlert(`Group not found.<br>The code might be wrong or the host has ended the group.`);
        return;
      }
    }

    if (!state.myName) {
      const name = await ffPrompt(
        'Choose your display name:',
        { placeholder: 'Your name', primaryLabel: 'Continue', maxLength: 24 }
      );
      if (!name) return;
      state.myName = name;
      saveState();
    }

    if (state.currentGroup === state.myQRid) {
      // Hosting: joining ends our group.
      const ok = await ffConfirm(
        `Join this group? Your current group will end for everyone.`,
        { primaryLabel: 'Join', danger: true }
      );
      if (!ok) return;
      if (fbDb && fbAuthed && window.fb) {
        try { await window.fb.remove(window.fb.ref(fbDb, 'circles/' + state.myQRid)); } catch (e) {}
        try { await window.fb.remove(window.fb.ref(fbDb, 'meetings/' + state.myQRid)); } catch (e) {}
      }
    } else if (state.currentGroup) {
      const ok = await ffConfirm(
        `Leave your current group to join this one?`,
        { primaryLabel: 'Join' }
      );
      if (!ok) return;
      if (fbDb && fbAuthed && window.fb) {
        try { await window.fb.remove(window.fb.ref(fbDb, 'circles/' + state.currentGroup + '/' + state.myQRid)); } catch (e) {}
        try { await window.fb.remove(window.fb.ref(fbDb, 'meetings/' + state.currentGroup + '/' + state.myQRid)); } catch (e) {}
      }
    }

    state.currentGroup = targetQrid;
    state.groupMembers = {};
    state.pins = {};
    saveState();
    subscribeCurrentGroup();
    if (fbAuthed) publishMyLocation();
    render(mainEl);
  }

  // leave (member) or end (host) the current group → idle.
  async function leaveOrEndGroup(mainEl) {
    if (!state.currentGroup) return;
    const isHost = state.currentGroup === state.myQRid;
    const hostName = isHost
      ? (state.myName || 'your')
      : ((state.groupMembers[state.currentGroup] && state.groupMembers[state.currentGroup].name) || 'this');
    const msg = isHost
      ? `Leave the group? Members will lose this group entirely.`
      : `Leave <b>${escapeHTML(hostName)}'s group</b>?`;
    const ok = await ffConfirm(msg, { primaryLabel: 'Leave', danger: true });
    if (!ok) return;
    if (fbDb && fbAuthed && window.fb) {
      if (isHost) {
        // Wipe entire group + all its pins.
        try { await window.fb.remove(window.fb.ref(fbDb, 'circles/' + state.myQRid)); } catch (e) {}
        try { await window.fb.remove(window.fb.ref(fbDb, 'meetings/' + state.myQRid)); } catch (e) {}
      } else {
        try { await window.fb.remove(window.fb.ref(fbDb, 'circles/' + state.currentGroup + '/' + state.myQRid)); } catch (e) {}
        // Member leaving: drop their own pin from this group.
        try { await window.fb.remove(window.fb.ref(fbDb, 'meetings/' + state.currentGroup + '/' + state.myQRid)); } catch (e) {}
      }
      try { await window.fb.remove(window.fb.ref(fbDb, 'loc/' + state.myQRid)); } catch (e) {}
      try { await window.fb.remove(window.fb.ref(fbDb, 'presence/' + state.myQRid)); } catch (e) {}
    }
    state.currentGroup = null;
    state.groupMembers = {};
    state.pins = {};
    saveState();
    subscribeCurrentGroup();  // tears down all subs
    render(mainEl);
  }

  // Show host's QR + code. X-close in top-right is the only way out
  // (no Done button — the X is enough).
  async function onShowInvite() {
    const code = formatId(state.myQRid);
    const shareUrl = `https://myraver.life/?friend=${state.myQRid}`;
    const qrSvg = renderQRSvg(shareUrl);
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'ff-modal-backdrop';
      backdrop.innerHTML = `
        <div class="ff-modal" style="text-align:center;">
          <button class="ff-modal-x" type="button" aria-label="Close">×</button>
          <div style="width:140px;height:140px;background:#fff;border-radius:10px;padding:8px;margin:0 auto 8px;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 14px rgba(0,0,0,0.22);">${qrSvg}</div>
          <div style="font-family:ui-monospace,Menlo,monospace;font-size:18px;font-weight:700;letter-spacing:2px;margin:6px 0;">${code}</div>
          <p style="font-size:12px;color:var(--muted);margin:6px 0 0;line-height:1.45;">Friends scan this QR or paste the code to join your group.</p>
        </div>
      `;
      document.body.appendChild(backdrop);
      backdrop.querySelector('.ff-modal-x').onclick = () => { backdrop.remove(); resolve(); };
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { backdrop.remove(); resolve(); } });
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
    .ff-friend-row.ff-offline { opacity: 0.55; }
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
      padding: 22px 44px 14px 18px;
      width: 100%; max-width: 360px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.5);
      animation: ffModalIn 0.16s cubic-bezier(0.2, 0.8, 0.4, 1);
      position: relative;
    }
    .ff-modal-x {
      position: absolute;
      top: 8px; right: 8px;
      width: 30px; height: 30px;
      border-radius: 50%;
      border: none;
      background: rgba(255,255,255,0.06);
      color: var(--muted);
      font-size: 18px; line-height: 1; font-weight: 400;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.12s ease, color 0.12s ease;
    }
    .ff-modal-x:hover { background: rgba(255,255,255,0.14); color: var(--text); }
    .ff-modal-x:active { transform: scale(0.92); }
    .ff-pin-modal { padding-right: 46px; padding-top: 18px; }
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
      padding: 8px 16px; border-radius: 10px;
      font-size: 13px; font-weight: 600;
      letter-spacing: 0.2px;
      border: 1px solid rgba(255,255,255,0.18);
      background: transparent; color: var(--text);
      cursor: pointer;
      transition: border-color 0.12s ease, color 0.12s ease, filter 0.12s ease;
    }
    .ff-modal-btn:hover { border-color: rgba(255,255,255,0.4); }
    .ff-modal-btn:active { transform: scale(0.97); }
    .ff-modal-btn-primary {
      border-color: rgba(118, 224, 192, 0.5);
      color: #76e0c0;
    }
    .ff-modal-btn-primary:hover { border-color: #76e0c0; filter: brightness(1.1); }
    .ff-modal-btn-danger {
      border-color: rgba(255, 126, 181, 0.5);
      color: #ff7eb5;
    }
    .ff-modal-btn-danger:hover { border-color: #ff7eb5; filter: brightness(1.1); }

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

    /* ── v210: Idle state ── */
    .ff-idle { text-align: center; padding-top: 60px; }
    .ff-idle-title {
      font-size: 22px; font-weight: 700; color: var(--text);
      margin: 0 0 6px;
    }
    .ff-idle-sub {
      font-size: 14px; color: var(--muted);
      margin: 0 0 28px;
    }
    .ff-idle-actions {
      display: flex; flex-direction: column; gap: 12px;
      max-width: 320px; margin: 0 auto;
    }
    .ff-bigbtn {
      width: 100%;
      padding: 14px 18px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
      display: flex; flex-direction: column; align-items: center;
      text-align: center;
      transition: transform 0.08s ease, border-color 0.12s ease, filter 0.12s ease;
    }
    .ff-bigbtn:hover { border-color: rgba(255,255,255,0.18); }
    .ff-bigbtn:active { transform: scale(0.98); }
    .ff-bigbtn-pink {
      border-color: rgba(255, 126, 181, 0.35);
    }
    .ff-bigbtn-pink .ff-bigbtn-title {
      color: #ff7eb5;
      letter-spacing: 0.3px;
    }
    .ff-bigbtn-teal {
      border-color: rgba(118, 224, 192, 0.35);
    }
    .ff-bigbtn-teal .ff-bigbtn-title {
      color: #76e0c0;
      letter-spacing: 0.3px;
    }
    .ff-bigbtn-title {
      font-size: 16px; font-weight: 700;
    }
    .ff-bigbtn-sub {
      font-size: 12px;
      opacity: 0.8;
      margin-top: 3px;
      line-height: 1.3;
    }

    /* ── v210: In-group state ── */
    .ff-group-header {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 0 4px;
      margin-bottom: 8px;
      justify-content: flex-end;
    }
    .ff-row-chev {
      color: var(--muted);
      font-size: 22px;
      font-weight: 300;
      line-height: 1;
      margin-left: 6px;
      flex-shrink: 0;
      align-self: center;
      opacity: 0.6;
    }
    .ff-friend-row:hover .ff-row-chev,
    .ff-pin-row:hover .ff-row-chev { opacity: 1; color: var(--text); }
    .ff-group-title { flex: 1; min-width: 0; }
    .ff-group-count {
      font-size: 14px; font-weight: 700; color: var(--text);
      letter-spacing: 0.2px;
    }
    .ff-group-count-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .ff-mapbtn {
      border-color: rgba(118, 224, 192, 0.5);
      background: transparent;
      color: #76e0c0;
    }
    .ff-mapbtn:hover {
      border-color: #76e0c0;
      filter: brightness(1.12);
    }
    .ff-mapbtn, .ff-invite-btn {
      height: 30px;
      padding: 0 14px;
      border-radius: 999px;
      font-size: 12.5px;
      font-weight: 600;
      letter-spacing: 0.3px;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      border: 1px solid;
      transition: border-color 0.12s ease, filter 0.12s ease, color 0.12s ease;
    }
    .ff-mapbtn:active, .ff-invite-btn:active { transform: scale(0.96); }
    .ff-invite-btn {
      border-color: rgba(255, 126, 181, 0.5);
      background: transparent;
      color: #ff7eb5;
    }
    .ff-invite-btn:hover {
      border-color: #ff7eb5;
      filter: brightness(1.12);
    }
    .ff-status-row {
      text-align: center; margin: 0 0 8px;
    }
    .ff-empty-host {
      text-align: center;
      font-size: 13px; color: var(--muted);
      line-height: 1.6;
      padding: 24px 12px;
      margin: 0;
    }
    .ff-empty-host b { color: var(--text); }

    /* ── Pins section ── */
    .ff-pins-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 14px 6px;
      margin-bottom: 10px;
    }
    .ff-pins-title {
      font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.7px; color: var(--muted);
      display: flex; align-items: baseline; gap: 8px;
      margin: 0 0 6px;
    }
    .ff-pins-count {
      font-size: 13px; font-weight: 800; color: var(--text);
    }
    .ff-pin-row {
      display: flex; align-items: center; gap: 10px;
      padding: 7px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      cursor: pointer;
    }
    .ff-pin-row:last-child { border-bottom: 0; }
    .ff-pin-msg {
      font-size: 11.5px; color: var(--muted);
      margin-top: 3px;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ff-pins-empty {
      display: block;
      font-size: 13px;
      color: var(--muted);
      padding: 10px 0 4px;
      cursor: pointer;
      text-decoration: none;
    }
    .ff-pins-empty:hover { color: var(--text); }
    .ff-tag {
      font-size: 12px;
      font-weight: 400;
      color: var(--muted);
      margin-left: 3px;
      letter-spacing: 0;
    }
    .ff-leave-btn {
      width: 100%; margin-top: 14px;
      padding: 10px;
      font-size: 13px;
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

      // Always-available X close (top-right). Dismisses with null (cancel).
      const closeX = document.createElement('button');
      closeX.className = 'ff-modal-x';
      closeX.type = 'button';
      closeX.setAttribute('aria-label', 'Close');
      closeX.textContent = '×';
      closeX.onclick = () => { backdrop.remove(); resolve(null); };
      modal.appendChild(closeX);

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
    if (ago < 0) return { text: 'last seen just now', cls: 'ff-fresh-green' };
    const m = Math.floor(ago / 60000);
    if (m < 1) return { text: 'last seen just now', cls: 'ff-fresh-green' };
    if (m < 2) return { text: 'last seen 1 min ago', cls: 'ff-fresh-green' };
    if (m < 15) return { text: 'last seen ' + m + ' min ago', cls: 'ff-fresh-yellow' };
    if (m < 60) return { text: 'last seen ' + m + ' min ago', cls: 'ff-fresh-grey' };
    const h = Math.floor(m / 60);
    if (h < 24) return { text: 'last seen ' + h + (h === 1 ? ' hr' : ' hrs') + ' ago', cls: 'ff-fresh-grey' };
    const d = Math.floor(h / 24);
    if (d <= 7) return { text: 'last seen ' + d + 'd ago', cls: 'ff-fresh-grey' };
    return { text: 'no recent location', cls: 'ff-fresh-grey' };
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
  // Coalesce rapid maybeRerender calls into one render per animation frame
  // so the DOM isn't rewritten faster than the user can click.
  let _renderScheduled = false;
  function maybeRerender() {
    if (_renderScheduled) return;
    if (!activeMainEl || !activeMainEl.isConnected) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
      _renderScheduled = false;
      if (activeMainEl && activeMainEl.isConnected && activeMainEl.querySelector('.ff-page')) {
        render(activeMainEl);
      }
    });
  }
  // When user GPS resolves (from index.html's locateUser), rerender so
  // the friends list can show "X ft from you".
  window.addEventListener('myraver-userpos-update', () => maybeRerender());

  // ── Render ────────────────────────────────────────────────────────────
  let activeMainEl = null;

  function render(mainEl) {
    activeMainEl = mainEl;

    // Boot Firebase + triggers regardless of state. Idempotent.
    tryInitFirebase();
    tryAuth();
    attachPublishTriggers();

    // ── IDLE state: not in any group ──
    if (!state.currentGroup) {
      mainEl.innerHTML = `
        <div class="ff-page ff-idle">
          <h2 class="ff-idle-title">Find your crew</h2>
          <p class="ff-idle-sub">Connect with friends at the festival.</p>
          <div class="ff-idle-actions">
            <button class="ff-bigbtn ff-bigbtn-pink" id="ff-host">
              <span class="ff-bigbtn-title">Host a group</span>
              <span class="ff-bigbtn-sub">Friends scan your QR to join your group</span>
            </button>
            <button class="ff-bigbtn ff-bigbtn-teal" id="ff-join">
              <span class="ff-bigbtn-title">Join a group</span>
              <span class="ff-bigbtn-sub">Scan a friend's QR to join their group</span>
            </button>
          </div>
        </div>
      `;
      mainEl.querySelector('#ff-host').onclick = () => hostNewGroup(mainEl);
      mainEl.querySelector('#ff-join').onclick = () => onScan(mainEl);
      return;
    }

    // ── IN-GROUP state: unified list — host first, others alphabetical ──
    const isHost = state.currentGroup === state.myQRid;
    const memberQrids = Object.keys(state.groupMembers || {});
    const totalMembers = 1 + memberQrids.length;
    const countLabel = `${totalMembers} member${totalMembers === 1 ? '' : 's'}`;

    // Build the unified list including self.
    const allMembers = [{
      qrid: state.myQRid,
      name: state.myName || '?',
      initial: deriveInitial(state.myName || '?'),
      isHost: isHost,
      isSelf: true,
    }];
    memberQrids.forEach(qrid => {
      const m = state.groupMembers[qrid];
      allMembers.push({
        qrid,
        name: m.name,
        initial: m.initial,
        isHost: m.isHost,
        isSelf: false,
      });
    });
    // Host first, then alphabetical by name.
    allMembers.sort((a, b) => {
      if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const userPos = window._lastUserPos;
    const memberRows = allMembers.map(m => {
      const data = m.isSelf ? null : (friendData[m.qrid] || {});
      const offline = !m.isSelf && data && data.online === false;
      const offlinePrefix = offline ? 'offline · ' : '';
      const fresh = m.isSelf ? null : freshnessLabel(data ? data.ts : null);
      let distLine = '';
      if (!m.isSelf && userPos && data && data.lat != null) {
        const distM = haversineMeters(userPos.lat, userPos.lng, data.lat, data.lng);
        distLine = ' · ' + formatImperialDistance(distM);
      }
      // One tag at a time: "you" beats "host" (the [+ Invite] button already
      // signals you're the host; no need to label yourself in the list too).
      const tag = m.isSelf ? 'you' : (m.isHost ? 'host' : '');
      const tagsHtml = tag ? `<span class="ff-tag">(${tag})</span>` : '';
      const subText = m.isSelf ? '' : (offlinePrefix + fresh.text + distLine);
      return `
        <div class="ff-friend-row${offline ? ' ff-offline' : ''}${m.isSelf ? ' ff-friend-self' : ''}" data-memqrid="${escapeHTML(m.qrid)}">
          <div class="ff-friend-dot" style="background:${colorForInitial(m.initial)}">${escapeHTML(m.initial)}</div>
          <div class="ff-friend-meta">
            <div class="ff-friend-name">${escapeHTML(m.name)} ${tagsHtml}</div>
            ${subText ? `<div class="ff-friend-sub">${escapeHTML(subText)}</div>` : ''}
          </div>
          <span class="ff-row-chev">›</span>
        </div>
      `;
    }).join('');

    // Pins section — sorted with mine first, then by ts (newest first).
    const pinEntries = Object.keys(state.pins).map(qrid => ({
      qrid,
      isMine: qrid === state.myQRid,
      ...state.pins[qrid],
    })).sort((a, b) => {
      if (a.isMine !== b.isMine) return a.isMine ? -1 : 1;
      return (b.ts || 0) - (a.ts || 0);
    });
    const pinsBody = pinEntries.length === 0
      ? `<a class="ff-pins-empty" id="ff-pins-empty">No pins yet. Drop one on the Map →</a>`
      : pinEntries.map(p => {
          const m = p.isMine
            ? { name: state.myName || '?', initial: deriveInitial(state.myName || '?') }
            : (state.groupMembers[p.qrid] || { name: p.by || '?', initial: deriveInitial(p.by || '?') });
          return `
            <div class="ff-pin-row" data-pinqrid="${escapeHTML(p.qrid)}">
              <div class="ff-friend-dot" style="background:${colorForInitial(m.initial)}">${escapeHTML(m.initial)}</div>
              <div class="ff-friend-meta">
                <div class="ff-friend-name">${escapeHTML(m.name)}${p.isMine ? ' <span class="ff-tag">(you)</span>' : ''}</div>
                <div class="ff-pin-msg">${escapeHTML(p.message)}</div>
              </div>
              <span class="ff-row-chev">›</span>
            </div>
          `;
        }).join('');
    const pinsHTML = `
      <div class="ff-pins-section">
        <div class="ff-pins-title">📍 Pins${pinEntries.length > 0 ? `<span class="ff-pins-count">${pinEntries.length}</span>` : ''}</div>
        ${pinsBody}
      </div>
    `;

    mainEl.innerHTML = `
      <div class="ff-page">
        ${isHost ? `<div class="ff-group-header"><button class="ff-invite-btn" id="ff-invite" aria-label="Invite people">+ Invite</button></div>` : ''}
        ${pinsHTML}
        <div class="ff-following">
          <div class="ff-pins-title">👯 Crew<span class="ff-pins-count">${totalMembers}</span></div>
          ${memberRows}
        </div>
        <button class="ff-btn ff-btn-secondary ff-leave-btn" id="ff-leave">Leave group</button>
      </div>
    `;

    if (isHost) {
      const inv = mainEl.querySelector('#ff-invite');
      if (inv) inv.onclick = () => onShowInvite();
    }
    const mapLink = mainEl.querySelector('#ff-show-map');
    const goToMap = (e) => {
      if (e) e.preventDefault();
      const mapTab = document.querySelector('button[data-tab="map"]');
      if (mapTab) mapTab.click();
    };
    if (mapLink) mapLink.onclick = goToMap;
    const emptyPins = mainEl.querySelector('#ff-pins-empty');
    if (emptyPins) emptyPins.onclick = goToMap;
    // Tapping a pin row jumps to Map and highlights — for now just go to map.
    mainEl.querySelectorAll('.ff-pin-row').forEach(row => {
      row.onclick = goToMap;
    });
    // Same for member rows — tapping any crew member jumps to Map (so you
    // can see where they are). Self row also goes — shows user's own pin.
    mainEl.querySelectorAll('.ff-friend-row').forEach(row => {
      row.style.cursor = 'pointer';
      row.onclick = goToMap;
    });
    mainEl.querySelector('#ff-leave').onclick = () => leaveOrEndGroup(mainEl);

    // Start publishing (idempotent). Do NOT call subscribeCurrentGroup here —
    // its set() write would trigger the onValue handler, which calls
    // maybeRerender → render → subscribeCurrentGroup → loop. Subscription
    // is owned by state transitions (host/join/leave) + tryAuth success.
    startPublishLoop();
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
        await joinGroupFlow(mainEl, qrid);
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
      `Paste the group's code:`,
      { placeholder: 'e.g., K3FQ72', primaryLabel: 'Continue' }
    );
    if (!raw) return;
    const qrid = extractQrid(raw);
    if (!qrid) { await ffAlert(`That doesn't look like a valid code.`); return; }
    joinGroupFlow(mainEl, qrid);
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

  // ── Public API ────────────────────────────────────────────────────────
  window.findFriends = {
    render,
    getMyQRid() { return state.myQRid; },
    // Returns current group members in the same shape index.html expects.
    getFollowing() {
      return Object.keys(state.groupMembers || {}).map(qrid => ({
        qrid,
        name: state.groupMembers[qrid].name,
        initial: state.groupMembers[qrid].initial,
      }));
    },
    getFriendData(qrid) {
      const d = friendData[qrid];
      if (!d || typeof d.lat !== 'number') return null;
      return { lat: d.lat, lng: d.lng, ts: d.ts, online: d.online };
    },
    // Pins (meetings) — read + write API for the Map tab.
    getPins() {
      // Returns array of { qrid, name, initial, color, lat, lng, message, ts, isMine }
      return Object.keys(state.pins).map(qrid => {
        const p = state.pins[qrid];
        const isMine = qrid === state.myQRid;
        const m = isMine ? null : state.groupMembers[qrid];
        const name = isMine ? (state.myName || '?') : (m ? m.name : (p.by || '?'));
        const initial = deriveInitial(name);
        return {
          qrid, name, initial, color: colorForInitial(initial),
          lat: p.lat, lng: p.lng, message: p.message, ts: p.ts,
          isMine,
        };
      });
    },
    getMyPin: () => {
      const p = state.pins[state.myQRid];
      return p ? { ...p, qrid: state.myQRid } : null;
    },
    dropMyPin,
    removeMyPin,
    updateMyPinPosition,
    inGroup: () => !!state.currentGroup,
    colorForInitial,
    freshnessLabel,
    alert: ffAlert,
    confirm: ffConfirm,
    prompt: ffPrompt,
  };
})();
