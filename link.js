/*
 * How the computer and the phone talk on the website version.
 *
 * The computer's page is the hub: it keeps the scripts and settings in this
 * browser's storage and accepts connections from phones. The phone connects
 * straight to it over WebRTC. PeerJS's free public server only introduces the
 * two (using the code in the QR) and, when a direct route isn't possible,
 * relays the encrypted traffic.
 *
 * TP.host() is used by the computer page, TP.join() by the phone page. Both
 * return { connected, send(msg) } and deliver messages to handlers.onMessage,
 * in the same shapes the Mac version's server used.
 */
(function () {
  'use strict';
  const TP = window.TP;
  const KEYS = { id: 'tp.pairingId', scripts: 'tp.scripts', settings: 'tp.settings' };
  const PEER_OPTIONS = { debug: 0 };

  const SAMPLE = [
    'Welcome to your teleprompter.',
    '',
    'This is a sample script. Delete it, or paste your intro over it.',
    '',
    '[Scan the QR code on the computer with your phone]',
    '',
    'Your phone is now the remote. Tap the big pad to start and stop. Drag on the pad to move the text up or down if you lose your place.',
    '',
    'The plus and minus buttons change the speed. The speed is in words per minute, so it stays the same if you make the text bigger.',
    '',
    'Put notes to yourself in square brackets, like this: [smile, look into the lens]. They show up in a different color.',
    '',
    'Put *stars* around a word to make it stand out.',
    '',
    'Tap any line in the preview on your phone to jump straight to it.',
  ].join('\n');

  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }
  const copy = function (o) { return JSON.parse(JSON.stringify(o)); };

  function newPairingId() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return 'tp-' + Array.from(bytes, function (b) { return chars[b % chars.length]; }).join('');
  }

  function remoteUrlFor(id) {
    return new URL('remote.html?id=' + encodeURIComponent(id), location.href).href;
  }

  // ------------------------------------------------------------------
  // computer side

  TP.host = function (handlers) {
    const api = { connected: false, status: 'connecting', send: fromPage, remoteUrl: null };

    let scripts = load(KEYS.scripts, null);
    if (!Array.isArray(scripts)) {
      const now = Date.now() / 1000;
      scripts = [{ id: TP.uid(), title: 'Sample script', text: SAMPLE, created: now, updated: now }];
      save(KEYS.scripts, scripts);
    }
    let settings = load(KEYS.settings, {});
    let settingsJson = JSON.stringify(settings);
    let state = null;
    const phones = new Map(); // DataConnection -> last time we heard from it

    function toPage(msg) {
      const m = copy(msg);
      setTimeout(function () { handlers.onMessage(m); }, 0);
    }
    function toPhones(msg) {
      phones.forEach(function (_, c) {
        try { c.send(msg); } catch (e) {}
      });
    }
    function counts() { return { prompters: 1, remotes: phones.size }; }
    function presence() {
      const m = Object.assign({ t: 'presence' }, counts());
      toPage(m);
      toPhones(m);
    }

    function fromPage(m) {
      if (m.t === 'state') {
        state = m;
        const sj = JSON.stringify(m.settings || {});
        if (m.settings && sj !== settingsJson) {
          settings = m.settings;
          settingsJson = sj;
          save(KEYS.settings, settings);
        }
        toPhones(m);
      } else if (m.t === 'saveScript') {
        const s = m.script || {};
        const now = Date.now() / 1000;
        let existing = scripts.find(function (x) { return x.id === s.id; });
        if (!existing) {
          existing = { id: s.id || TP.uid(), created: now };
          scripts.unshift(existing);
        }
        existing.title = String(s.title || '').slice(0, 200);
        existing.text = String(s.text || '');
        existing.updated = now;
        const ok = save(KEYS.scripts, scripts);
        toPage({ t: 'saved', script: existing, req: m.req, ok: ok });
        toPhones({ t: 'script', script: existing });
      } else if (m.t === 'deleteScript') {
        scripts = scripts.filter(function (x) { return x.id !== m.id; });
        save(KEYS.scripts, scripts);
        toPage({ t: 'scriptDeleted', id: m.id });
        toPhones({ t: 'scriptDeleted', id: m.id });
      }
      return true;
    }

    function fromPhone(c, m) {
      phones.set(c, Date.now());
      if (!m || typeof m !== 'object') return;
      if (m.t === 'ping') {
        try { c.send({ t: 'pong' }); } catch (e) {}
      } else if (m.t === 'cmd') {
        toPage(m);
      }
    }

    function dropPhone(c) {
      if (!phones.has(c)) return;
      phones.delete(c);
      try { c.close(); } catch (e) {}
      presence();
    }

    // a phone that went to sleep can leave a dead connection behind
    setInterval(function () {
      const now = Date.now();
      phones.forEach(function (seen, c) {
        if (now - seen > 10000) dropPhone(c);
      });
    }, 3000);

    // the page gets its data right away; the phone link comes up when it can
    toPage(Object.assign({ t: 'hello', role: 'prompter', scripts: scripts, settings: settings, state: null }, counts()));

    let id = load(KEYS.id, null) || newPairingId();
    save(KEYS.id, id);
    let peer = null;
    let idTries = 0;

    function setStatus(status) {
      api.status = status;
      api.connected = status === 'online';
      if (handlers.onStatus) setTimeout(function () { handlers.onStatus(api.connected); }, 0);
    }

    function start() {
      if (!window.Peer) {
        setStatus('offline');
        setTimeout(start, 2000);
        return;
      }
      const p = new window.Peer(id, PEER_OPTIONS);
      peer = p;
      p.on('open', function (pid) {
        if (p !== peer) return;
        idTries = 0;
        api.remoteUrl = remoteUrlFor(pid);
        setStatus('online');
        toPage({ t: 'link', remoteUrl: api.remoteUrl });
      });
      p.on('connection', function (c) {
        c.on('open', function () {
          phones.set(c, Date.now());
          try { c.send(Object.assign({ t: 'hello', role: 'remote', scripts: scripts, settings: settings, state: state }, counts())); } catch (e) {}
          presence();
        });
        c.on('data', function (m) { fromPhone(c, m); });
        c.on('close', function () { dropPhone(c); });
        c.on('error', function () { dropPhone(c); });
      });
      p.on('disconnected', function () {
        if (p !== peer || p.destroyed) return;
        setStatus('offline');
        setTimeout(function () { if (p === peer && !p.destroyed && p.disconnected) p.reconnect(); }, 2000);
      });
      p.on('error', function (err) {
        if (p !== peer) return;
        const type = err && err.type;
        if (type === 'unavailable-id') {
          // usually this page was just reloaded and the old one hasn't been
          // released yet; after a few tries, pick a new pairing code
          p.destroy();
          if (++idTries > 4) {
            id = newPairingId();
            save(KEYS.id, id);
            idTries = 0;
          }
          setStatus('connecting');
          setTimeout(start, 2500);
        } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
          setStatus('offline');
          setTimeout(function () {
            if (p !== peer) return;
            if (p.destroyed) start();
            else if (p.disconnected) p.reconnect();
          }, 3000);
        } else if (type === 'browser-incompatible') {
          setStatus('unsupported');
        }
      });
    }
    window.addEventListener('online', function () {
      if (peer && !peer.destroyed && peer.disconnected) peer.reconnect();
    });
    start();
    return api;
  };

  // ------------------------------------------------------------------
  // phone side

  TP.join = function (hostId, handlers) {
    // status: connecting | nohost | offline | connected
    const api = { connected: false, status: 'connecting', send: send };
    let peer = null;
    let conn = null;
    let lastHeard = 0;
    let retry = 0;
    let timer = null;

    function send(obj) {
      if (conn && conn.open) {
        try {
          conn.send(obj);
          return true;
        } catch (e) {}
      }
      return false;
    }

    function setStatus(status) {
      const changed = api.status !== status;
      api.status = status;
      api.connected = status === 'connected';
      if (changed && handlers.onStatus) handlers.onStatus(api.connected);
    }

    function schedule(delay) {
      clearTimeout(timer);
      timer = setTimeout(connect, delay != null ? delay : Math.min(700 * Math.pow(1.5, retry++), 5000));
    }

    function dropConn(reason) {
      const c = conn;
      conn = null;
      if (c) {
        try { c.close(); } catch (e) {}
      }
      setStatus(reason || 'connecting');
      schedule();
    }

    function onError(err) {
      const type = err && err.type;
      if (type === 'peer-unavailable') {
        dropConn('nohost');
      } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
        if (peer && !peer.destroyed) peer.destroy();
        peer = null;
        dropConn('offline');
      } else if (type === 'browser-incompatible') {
        setStatus('offline');
      } else {
        dropConn();
      }
    }

    function openConn() {
      if (conn) {
        try { conn.close(); } catch (e) {}
      }
      const c = peer.connect(hostId, { reliable: true });
      conn = c;
      lastHeard = Date.now();
      c.on('open', function () {
        retry = 0;
        lastHeard = Date.now();
      });
      c.on('data', function (m) {
        if (c !== conn) return;
        lastHeard = Date.now();
        if (!m || typeof m !== 'object' || m.t === 'pong') return;
        if (m.t === 'hello') setStatus('connected');
        handlers.onMessage(m);
      });
      c.on('close', function () { if (c === conn) dropConn(); });
      c.on('error', function (err) { if (c === conn) onError(err); });
    }

    function connect() {
      clearTimeout(timer);
      if (!window.Peer) {
        setStatus('offline');
        schedule(1500);
        return;
      }
      if (!peer || peer.destroyed) {
        const p = new window.Peer(PEER_OPTIONS);
        peer = p;
        p.on('open', function () { if (p === peer) openConn(); });
        p.on('disconnected', function () {
          if (p !== peer || p.destroyed) return;
          setTimeout(function () { if (p === peer && !p.destroyed && p.disconnected) p.reconnect(); }, 1000);
        });
        p.on('error', function (err) { if (p === peer) onError(err); });
        return;
      }
      if (peer.disconnected) {
        peer.reconnect(); // fires 'open' again, which opens the connection
        return;
      }
      if (peer.open) openConn();
    }

    setInterval(function () {
      if (conn && conn.open) {
        send({ t: 'ping' });
        if (Date.now() - lastHeard > 9000) dropConn();
      } else if (conn && Date.now() - lastHeard > 12000) {
        dropConn(); // stuck while connecting
      }
    }, 2500);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (!conn || !conn.open) {
        retry = 0;
        connect();
      } else {
        // after the phone sleeps the connection can look open but be dead
        lastHeard = Math.min(lastHeard, Date.now() - 6500);
        send({ t: 'ping' });
      }
    });
    window.addEventListener('online', function () {
      retry = 0;
      connect();
    });

    setTimeout(connect, 0);
    return api;
  };
})();
