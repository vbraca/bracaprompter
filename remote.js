/* Phone remote. */
(function () {
  'use strict';
  const $ = function (s) { return document.querySelector(s); };
  const clamp = TP.clamp;

  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.6v12.8c0 .8.9 1.3 1.6.9l10-6.4c.6-.4.6-1.3 0-1.7l-10-6.4c-.7-.5-1.6 0-1.6.8z" fill="currentColor"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.3" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.3" fill="currentColor"/></svg>';
  const PX_PER_LINE = 26; // finger travel that moves the prompter one line

  let scripts = [];
  let state = null;
  let prompters = 0;
  let gotHello = false;

  // preview
  const preview = $('#preview');
  const previewText = $('#previewText');
  let spans = [];
  let renderedId = null;
  let renderedText = null;
  let readUpTo = 0;
  let curRange = null;
  let followPausedUntil = 0;

  // local guesses so taps feel instant before the computer answers
  let localWpm = null;
  let localWpmAt = 0;
  const localSettings = {};
  let localSettingsAt = 0;

  const hostId = new URLSearchParams(location.search).get('id');
  const conn = hostId
    ? TP.join(hostId, { onMessage: onMessage, onStatus: render })
    : { connected: false, status: 'unpaired', send: function () { return false; } };

  // keep the phone's screen on while the remote is open
  let wakeLock = null;
  function keepAwake() {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }
  document.addEventListener('pointerdown', keepAwake, { passive: true });
  document.addEventListener('visibilitychange', keepAwake);
  keepAwake();

  function send(a, extra) {
    const msg = Object.assign({ t: 'cmd', a: a }, extra || {});
    return conn.send(msg);
  }

  function onMessage(m) {
    switch (m.t) {
      case 'hello':
        gotHello = true;
        scripts = Array.isArray(m.scripts) ? m.scripts : [];
        state = m.state || null;
        prompters = m.prompters || 0;
        renderedText = null; // force the preview to redraw
        break;
      case 'presence':
        prompters = m.prompters || 0;
        break;
      case 'state':
        state = m;
        break;
      case 'script': {
        if (!m.script) break;
        const i = scripts.findIndex(function (s) { return s.id === m.script.id; });
        if (i === -1) scripts.unshift(m.script);
        else scripts[i] = m.script;
        break;
      }
      case 'scriptDeleted':
        scripts = scripts.filter(function (s) { return s.id !== m.id; });
        break;
      default:
        return;
    }
    render();
  }

  function currentScript() {
    if (!state || !state.scriptId) return null;
    return scripts.find(function (s) { return s.id === state.scriptId; }) || null;
  }

  function settings() {
    const s = Object.assign({}, (state && state.settings) || {});
    if (Date.now() - localSettingsAt < 1500) Object.assign(s, localSettings);
    return s;
  }

  // ------------------------------------------------------------------
  // drawing

  function render() {
    renderWaiting();
    const sc = currentScript();
    $('#scriptName').textContent = sc ? TP.titleOf(sc) : gotHello ? 'No script' : 'Connecting…';
    const dot = $('#dot');
    dot.className = 'dot' + (conn.connected && prompters > 0 ? ' ok' : conn.connected ? ' wait' : '');

    const banner = $('#banner');
    if (conn.connected && prompters > 0 && state && state.mode === 'edit') {
      banner.textContent = 'The computer is showing the editor. Tap the pad to open the prompter and start.';
      banner.classList.remove('hidden');
    } else banner.classList.add('hidden');

    renderPreview(sc);
    highlight();

    const playing = !!(state && state.playing);
    const counting = state && state.countdown > 0;
    $('#fill').style.width = ((state && state.progress) || 0) * 100 + '%';
    $('#stateLabel').textContent = !state
      ? '—'
      : counting
        ? 'Starting in ' + state.countdown + '…'
        : playing
          ? 'Playing'
          : state.mode === 'edit'
            ? 'Editor open'
            : (state.progress || 0) >= 0.999
              ? 'At the end'
              : 'Paused';
    $('#left').textContent = state ? TP.fmtTime(state.left) + ' left' : '';

    const pad = $('#pad');
    pad.classList.toggle('is-playing', playing || !!counting);
    const icon = $('#padIcon');
    const want = counting ? 'n' + state.countdown : playing ? 'pause' : 'play';
    if (icon.dataset.kind !== want) {
      icon.dataset.kind = want;
      icon.innerHTML = counting ? String(state.countdown) : playing ? ICON_PAUSE : ICON_PLAY;
    }
    $('#padLabel').textContent = counting ? 'Tap to cancel' : playing ? 'Tap to pause' : 'Tap to play';

    const wpm = localWpm != null && Date.now() - localWpmAt < 1200 ? localWpm : state ? state.wpm : null;
    $('#wpm').textContent = wpm != null ? wpm : '—';

    renderSettings();
    if (sheetOpen === 'scripts') renderScriptsList();
  }

  function renderWaiting() {
    const box = $('#waiting');
    if (conn.connected && prompters > 0) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const msgs = {
      unpaired: ['Scan the code on the computer', 'Open the teleprompter on your computer, then point this phone’s camera at the QR code on the right side of the screen.'],
      nohost: ['The teleprompter isn’t open', 'Open the teleprompter on the computer you paired with. This page connects by itself as soon as it’s open. If the code on the computer has changed, scan it again.'],
      offline: ['No connection', 'Check that this phone is online. This page keeps trying by itself.'],
      connecting: ['Connecting…', ''],
    };
    const msg = msgs[conn.status] || msgs.connecting;
    $('#waitTitle').textContent = msg[0];
    $('#waitText').textContent = msg[1];
    box.querySelector('.spinner').style.display = conn.status === 'unpaired' ? 'none' : '';
  }

  function renderPreview(sc) {
    const id = sc ? sc.id : null;
    const text = sc ? sc.text || '' : '';
    if (id === renderedId && text === renderedText) return;
    const parsed = TP.parseScript(text);
    if (!parsed.words.length) {
      previewText.innerHTML = '<p class="empty">' + (sc ? 'This script is empty.' : 'No script selected.') + '</p>';
      spans = [];
    } else {
      spans = TP.renderScript(previewText, parsed, true);
    }
    if (id !== renderedId) preview.scrollTop = 0;
    renderedId = id;
    renderedText = text;
    readUpTo = 0;
    curRange = null;
  }

  function highlight() {
    const line = state && state.mode === 'prompt' && state.scriptId === renderedId ? state.line : null;
    const s = line ? clamp(line[0], 0, spans.length) : 0;
    const e = line ? clamp(line[1], 0, spans.length - 1) : -1;
    if (readUpTo !== s) {
      const a = Math.min(readUpTo, s);
      const b = Math.max(readUpTo, s);
      for (let i = a; i < b && i < spans.length; i++) spans[i].classList.toggle('read', i < s);
      readUpTo = s;
    }
    if (curRange && curRange[0] === s && curRange[1] === e) return;
    if (curRange) for (let i = curRange[0]; i <= curRange[1] && i < spans.length; i++) spans[i].classList.remove('cur', 'cur-s', 'cur-e');
    for (let i = s; i <= e; i++) spans[i].classList.add('cur');
    if (e >= s) {
      spans[s].classList.add('cur-s');
      spans[e].classList.add('cur-e');
    }
    curRange = [s, e];
    if (line) follow(s);
  }

  function follow(i) {
    if (Date.now() < followPausedUntil || !spans[i]) return;
    const top = spans[i].offsetTop - preview.clientHeight * 0.28;
    preview.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  // finger on the preview: stop following for a moment so you can look around
  preview.addEventListener('touchstart', function () { followPausedUntil = Infinity; }, { passive: true });
  preview.addEventListener('touchend', function () { followPausedUntil = Date.now() + 3500; }, { passive: true });
  preview.addEventListener('wheel', function () { followPausedUntil = Date.now() + 3500; }, { passive: true });

  previewText.addEventListener('click', function (e) {
    const w = e.target.closest && e.target.closest('.w');
    if (!w) return;
    const i = Number(w.dataset.i);
    if (state && state.mode !== 'prompt') send('prompt');
    send('jump', { i: i });
    w.classList.add('flash');
    setTimeout(function () { w.classList.remove('flash'); }, 450);
    followPausedUntil = 0;
  });

  // ------------------------------------------------------------------
  // touch pad: tap = play/pause, drag = move the text

  const pad = $('#pad');
  let drag = null;
  let dragAcc = 0;
  let flushTimer = null;

  function flushDrag() {
    flushTimer = null;
    if (Math.abs(dragAcc) < 0.001) return;
    send('drag', { lines: Math.round(dragAcc * 1000) / 1000 });
    dragAcc = 0;
  }
  function queueDrag(lines) {
    dragAcc += lines;
    if (!flushTimer) flushTimer = setTimeout(flushDrag, 35);
  }

  pad.addEventListener('pointerdown', function (e) {
    if (drag) return;
    try { pad.setPointerCapture(e.pointerId); } catch (err) {}
    drag = { id: e.pointerId, y0: e.clientY, last: e.clientY, t0: performance.now(), moved: false };
    pad.classList.add('touching');
  });
  pad.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.y0) < 9) return;
      drag.moved = true;
      pad.classList.add('dragging');
      $('#padHint').textContent = 'Moving the text';
      if (state && state.mode !== 'prompt') send('prompt');
      queueDrag(-(e.clientY - drag.y0) / PX_PER_LINE);
    } else {
      queueDrag(-(e.clientY - drag.last) / PX_PER_LINE);
    }
    drag.last = e.clientY;
  });
  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    const tap = !drag.moved && performance.now() - drag.t0 < 600;
    drag = null;
    pad.classList.remove('touching', 'dragging');
    $('#padHint').textContent = 'Drag up or down to move the text';
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushDrag();
    }
    if (tap && !cancelled) send('toggle');
  }
  pad.addEventListener('pointerup', function (e) { endDrag(e, false); });
  pad.addEventListener('pointercancel', function (e) { endDrag(e, true); });
  pad.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  // ------------------------------------------------------------------
  // buttons

  function hold(btn, fn, firstDelay, every) {
    let t1 = null;
    let t2 = null;
    function stopHold() {
      clearTimeout(t1);
      clearInterval(t2);
      t1 = t2 = null;
      btn.classList.remove('pressed');
    }
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      stopHold();
      btn.classList.add('pressed');
      fn();
      t1 = setTimeout(function () { t2 = setInterval(fn, every); }, firstDelay);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { btn.addEventListener(ev, stopHold); });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function bumpWpm(d) {
    const base = localWpm != null && Date.now() - localWpmAt < 1200 ? localWpm : state ? state.wpm : 140;
    localWpm = clamp(base + d, 40, 400);
    localWpmAt = Date.now();
    send('speed', { v: localWpm });
    $('#wpm').textContent = localWpm;
  }
  hold($('#slower'), function () { bumpWpm(-5); }, 450, 120);
  hold($('#faster'), function () { bumpWpm(5); }, 450, 120);
  hold($('#backBtn'), function () { send('line', { d: -1 }); }, 450, 260);
  hold($('#fwdBtn'), function () { send('line', { d: 1 }); }, 450, 260);
  $('#topBtn').addEventListener('click', function () { send('restart'); });

  // ------------------------------------------------------------------
  // sheets

  let sheetOpen = null;
  function openSheet(name) {
    sheetOpen = name;
    $('#backdrop').classList.add('show');
    $('#scriptsSheet').classList.toggle('show', name === 'scripts');
    $('#settingsSheet').classList.toggle('show', name === 'settings');
    if (name === 'scripts') renderScriptsList();
    if (name === 'settings') renderSettings();
  }
  function closeSheet() {
    sheetOpen = null;
    $('#backdrop').classList.remove('show');
    document.querySelectorAll('.sheet').forEach(function (s) { s.classList.remove('show'); });
  }
  $('#scriptBtn').addEventListener('click', function () { openSheet('scripts'); });
  $('#settingsBtn').addEventListener('click', function () { openSheet('settings'); });
  $('#backdrop').addEventListener('click', closeSheet);
  document.querySelectorAll('.sheet .done').forEach(function (b) { b.addEventListener('click', closeSheet); });

  function renderScriptsList() {
    const ul = $('#scriptsList');
    ul.textContent = '';
    if (!scripts.length) {
      const li = document.createElement('li');
      li.textContent = 'No scripts yet. Add one on the computer.';
      ul.appendChild(li);
      return;
    }
    const wpm = (state && state.wpm) || 140;
    scripts.forEach(function (s) {
      const li = document.createElement('li');
      const t = document.createElement('div');
      t.className = 't';
      const b = document.createElement('b');
      b.textContent = TP.titleOf(s);
      const sub = document.createElement('span');
      const n = TP.parseScript(s.text).spoken;
      sub.textContent = n + ' words · ' + TP.fmtTime((n / wpm) * 60);
      t.appendChild(b);
      t.appendChild(sub);
      li.appendChild(t);
      if (state && state.scriptId === s.id) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'On screen';
        li.appendChild(tag);
      }
      li.addEventListener('click', function () {
        send('load', { id: s.id });
        closeSheet();
      });
      ul.appendChild(li);
    });
  }

  const FORMAT = {
    fontSize: function (v) { return Number(v).toFixed(1); },
    width: function (v) { return Math.round(v) + '%'; },
    lineHeight: function (v) { return Number(v).toFixed(2); },
    readingLine: function (v) { return Math.round(v) + '%'; },
  };
  const RANGE = { fontSize: [2, 16], width: [30, 100], lineHeight: [1, 2.2], readingLine: [8, 80] };

  function setRemote(k, v) {
    localSettings[k] = v;
    localSettingsAt = Date.now();
    send('set', { k: k, v: v });
    renderSettings();
  }

  document.querySelectorAll('[data-step]').forEach(function (b) {
    b.addEventListener('click', function () {
      const k = b.dataset.step;
      const s = settings();
      if (s[k] == null) return;
      const v = clamp(Math.round((Number(s[k]) + Number(b.dataset.d)) * 100) / 100, RANGE[k][0], RANGE[k][1]);
      setRemote(k, v);
    });
  });
  document.querySelectorAll('#settingsSheet .seg[data-key]').forEach(function (seg) {
    seg.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        const k = seg.dataset.key;
        setRemote(k, k === 'countdown' ? Number(b.dataset.v) : b.dataset.v);
      });
    });
  });
  document.querySelectorAll('[data-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      const k = b.dataset.toggle;
      setRemote(k, !settings()[k]);
    });
  });
  document.querySelectorAll('#modeSeg button').forEach(function (b) {
    b.addEventListener('click', function () { send(b.dataset.mode); });
  });

  function renderSettings() {
    const s = settings();
    Object.keys(FORMAT).forEach(function (k) {
      $('#v-' + k).textContent = s[k] != null ? FORMAT[k](s[k]) : '—';
    });
    document.querySelectorAll('#settingsSheet .seg[data-key]').forEach(function (seg) {
      const k = seg.dataset.key;
      seg.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', String(s[k]) === b.dataset.v); });
    });
    document.querySelectorAll('[data-toggle]').forEach(function (b) {
      b.setAttribute('aria-pressed', s[b.dataset.toggle] ? 'true' : 'false');
    });
    const mode = state ? state.mode : null;
    document.querySelectorAll('#modeSeg button').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === mode); });
  }

  render();
})();
