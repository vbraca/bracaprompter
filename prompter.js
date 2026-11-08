/* Prompter page: the editor plus the scrolling display. */
(function () {
  'use strict';
  const $ = function (s) { return document.querySelector(s); };
  const clamp = TP.clamp;

  const DEFAULTS = {
    fontSize: 6,        // % of the window width
    lineHeight: 1.35,
    width: 84,          // % of the window width
    readingLine: 33,    // % from the top
    align: 'left',
    theme: 'dark',
    mirrorX: false,
    mirrorY: false,
    countdown: 3,
    fade: true,
    fullscreen: true,
    wpm: 140,
    lastScriptId: null,
  };
  const RANGES = {
    fontSize: [2, 16],
    lineHeight: [1, 2.2],
    width: [30, 100],
    readingLine: [8, 80],
    wpm: [40, 400],
  };
  const CHOICES = {
    align: ['left', 'center'],
    theme: ['dark', 'yellow', 'light'],
    countdown: [0, 3, 5],
  };
  const BOOLS = ['mirrorX', 'mirrorY', 'fade', 'fullscreen'];

  let S = Object.assign({}, DEFAULTS);

  // elements
  const editorEl = $('#editor');
  const prompterEl = $('#prompter');
  const mirrorEl = $('#mirror');
  const scroller = $('#scroller');
  const textBody = $('#textBody');
  const fadeEl = $('#fade-above');
  const marker = $('#marker');
  const countdownEl = $('#countdown');
  const toastEl = $('#toast');
  const hudEl = $('#hud');
  const titleIn = $('#title');
  const textIn = $('#text');
  const listEl = $('#scriptList');

  // scripts
  let scripts = [];
  let current = null;
  let dirty = false;
  let saveTimer = null;
  let saveReq = 0;

  // display state
  let parsed = TP.parseScript('');
  let spans = [];
  let lines = [];
  let renderedId = null;
  let renderedText = null;
  let lh = 1;
  let R = 0;
  let y = 0;
  let pending = 0;
  let anim = null;
  let layoutDirty = true;
  let savedAnchor = null;
  let curLine = -1;

  let mode = 'edit';
  let playing = false;
  let countdownLeft = 0;
  let countdownTimer = null;

  let remotes = 0;
  let lastSent = 0;
  let stateTimer = null;
  let gotHello = false;

  const conn = TP.host({ onMessage: onMessage, onStatus: onStatus });

  // ------------------------------------------------------------------
  // messages from the server

  function onMessage(m) {
    switch (m.t) {
      case 'link':
        renderQR();
        updatePresence();
        break;
      case 'hello': {
        remotes = m.remotes || 0;
        if (!gotHello) S = cleanSettings(Object.assign({}, DEFAULTS, m.settings || {}));
        const keep = dirty && current ? current : null;
        scripts = Array.isArray(m.scripts) ? m.scripts : [];
        if (keep) {
          upsert(keep);
          scheduleSave(0);
        }
        let pick = current && scripts.find(function (s) { return s.id === current.id; });
        if (!pick && S.lastScriptId) pick = scripts.find(function (s) { return s.id === S.lastScriptId; });
        if (!pick) pick = scripts[0];
        if (!pick) {
          pick = newScriptObj();
          scripts.unshift(pick);
        }
        if (!current || current.id !== pick.id) selectScript(pick, { quiet: true });
        else current = pick;
        gotHello = true;
        renderList();
        fillEditor();
        syncControls();
        applyLook();
        renderQR();
        updatePresence();
        sendState(true);
        break;
      }
      case 'presence':
        remotes = m.remotes || 0;
        updatePresence();
        sendState(true);
        break;
      case 'cmd':
        onCmd(m);
        break;
      case 'script': {
        const s = m.script;
        if (!s) break;
        upsert(s);
        if (current && current.id === s.id && !dirty) {
          current = s;
          fillEditor();
          if (mode === 'prompt') refreshText();
        }
        renderList();
        break;
      }
      case 'scriptDeleted':
        scripts = scripts.filter(function (s) { return s.id !== m.id; });
        if (current && current.id === m.id) {
          dirty = false;
          selectScript(scripts[0] || addBlankScript(), { quiet: true });
        }
        renderList();
        break;
      case 'saved':
        if (m.script) {
          const local = scripts.find(function (s) { return s.id === m.script.id; });
          if (local) local.updated = m.script.updated;
        }
        if (m.req === saveReq) {
          dirty = false;
          if (m.ok === false) setSaveState('Couldn’t save. This browser’s storage is full or turned off.', true);
          else setSaveState('Saved in this browser');
        }
        renderList();
        break;
    }
  }

  function onStatus() {
    renderQR();
    updatePresence();
  }

  function cleanSettings(s) {
    const out = Object.assign({}, DEFAULTS);
    Object.keys(RANGES).forEach(function (k) {
      const v = Number(s[k]);
      if (isFinite(v)) out[k] = clamp(v, RANGES[k][0], RANGES[k][1]);
    });
    Object.keys(CHOICES).forEach(function (k) {
      if (CHOICES[k].indexOf(s[k]) !== -1) out[k] = s[k];
    });
    BOOLS.forEach(function (k) {
      if (typeof s[k] === 'boolean') out[k] = s[k];
    });
    if (typeof s.lastScriptId === 'string') out.lastScriptId = s.lastScriptId;
    return out;
  }

  // ------------------------------------------------------------------
  // commands from the phone (and the keyboard)

  function onCmd(m) {
    switch (m.a) {
      case 'toggle':
        if (mode !== 'prompt') {
          enterPrompt(false);
          start();
        } else if (playing || countdownLeft) stop(true);
        else start();
        break;
      case 'play':
        if (mode !== 'prompt') enterPrompt(false);
        start();
        break;
      case 'pause':
        stop(true);
        break;
      case 'restart':
        restart();
        break;
      case 'speed':
        setWpm(m.v != null ? Number(m.v) : S.wpm + (Number(m.d) || 0));
        break;
      case 'drag':
        if (mode === 'prompt') {
          anim = null;
          pending += (Number(m.lines) || 0) * lh;
        }
        break;
      case 'line':
        stepLine(Number(m.d) || 0);
        break;
      case 'jump':
        jumpToWord(Number(m.i));
        break;
      case 'load': {
        const s = scripts.find(function (x) { return x.id === m.id; });
        if (s) selectScript(s, { announce: true });
        break;
      }
      case 'set':
        setSetting(m.k, m.v, true);
        break;
      case 'prompt':
        enterPrompt(false);
        break;
      case 'edit':
        exitPrompt();
        break;
    }
  }

  // ------------------------------------------------------------------
  // script library + editor

  function newScriptObj() {
    const now = Date.now() / 1000;
    return { id: TP.uid(), title: '', text: '', created: now, updated: now };
  }

  function addBlankScript() {
    const s = newScriptObj();
    scripts.unshift(s);
    return s;
  }

  function upsert(s) {
    const i = scripts.findIndex(function (x) { return x.id === s.id; });
    if (i === -1) scripts.unshift(s);
    else scripts[i] = s;
  }

  function selectScript(s, opts) {
    opts = opts || {};
    if (dirty) doSave();
    stop(false);
    current = s;
    S.lastScriptId = s.id;
    fillEditor();
    renderList();
    refreshText(true);
    if (opts.announce && mode === 'prompt') toast(TP.titleOf(s));
    if (!opts.quiet) sendState(true);
  }

  function renderList() {
    listEl.textContent = '';
    scripts.forEach(function (s) {
      const li = document.createElement('li');
      if (current && s.id === current.id) li.className = 'active';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = TP.titleOf(s);
      const sub = document.createElement('span');
      sub.className = 's';
      const n = TP.parseScript(s.text).spoken;
      sub.textContent = n + (n === 1 ? ' word' : ' words') + ' · ' + TP.fmtTime((n / S.wpm) * 60);
      li.appendChild(t);
      li.appendChild(sub);
      li.addEventListener('click', function () {
        if (!current || current.id !== s.id) selectScript(s);
      });
      listEl.appendChild(li);
    });
  }

  function fillEditor() {
    if (!current) return;
    if (titleIn.value !== (current.title || '')) titleIn.value = current.title || '';
    if (textIn.value !== (current.text || '')) textIn.value = current.text || '';
    updateMeta();
  }

  function updateMeta() {
    const n = TP.parseScript(textIn.value).spoken;
    $('#meta').textContent = n + (n === 1 ? ' word' : ' words') + ' · about ' + TP.fmtTime((n / S.wpm) * 60) + ' at ' + S.wpm + ' words/min';
  }

  function setSaveState(text, warn) {
    const el = $('#saveState');
    el.textContent = text || '';
    el.classList.toggle('warn', !!warn);
  }

  function scheduleSave(delay) {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, delay == null ? 500 : delay);
  }

  function doSave() {
    clearTimeout(saveTimer);
    if (!current) return;
    saveReq++;
    const ok = conn.send({
      t: 'saveScript',
      req: saveReq,
      script: { id: current.id, title: current.title || '', text: current.text || '' },
    });
    if (ok) setSaveState('Saving…');
    else setSaveState('Not connected. Your changes will save when it reconnects.', true);
  }

  function onEdit() {
    if (!current) return;
    current.title = titleIn.value;
    current.text = textIn.value;
    updateMeta();
    renderList();
    scheduleSave();
  }
  titleIn.addEventListener('input', onEdit);
  textIn.addEventListener('input', onEdit);

  $('#newScript').addEventListener('click', function () {
    const s = addBlankScript();
    selectScript(s);
    scheduleSave(0);
    titleIn.focus();
  });

  $('#deleteScript').addEventListener('click', function () {
    if (!current) return;
    const name = TP.titleOf(current);
    if (!window.confirm('Delete “' + name + '”? This can’t be undone.')) return;
    const id = current.id;
    dirty = false;
    clearTimeout(saveTimer);
    conn.send({ t: 'deleteScript', id: id });
    scripts = scripts.filter(function (s) { return s.id !== id; });
    selectScript(scripts[0] || addBlankScript());
  });

  function importText(name, text) {
    const s = newScriptObj();
    s.title = name.replace(/\.[^.]+$/, '');
    s.text = text;
    scripts.unshift(s);
    selectScript(s);
    scheduleSave(0);
  }
  function importFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = function () { importText(file.name, String(r.result || '')); };
    r.readAsText(file);
  }
  $('#importFile').addEventListener('change', function (e) {
    importFile(e.target.files[0]);
    e.target.value = '';
  });
  let dragDepth = 0;
  window.addEventListener('dragenter', function (e) {
    if (mode !== 'edit' || !e.dataTransfer || Array.from(e.dataTransfer.types).indexOf('Files') === -1) return;
    dragDepth++;
    editorEl.classList.add('dragging');
  });
  window.addEventListener('dragleave', function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) editorEl.classList.remove('dragging');
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    editorEl.classList.remove('dragging');
    if (mode === 'edit' && e.dataTransfer && e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
  });

  // ------------------------------------------------------------------
  // phone connection box

  function renderQR() {
    const box = $('#qr');
    const url = conn.remoteUrl;
    if (!url || !conn.connected) {
      box.className = 'qr empty';
      box.textContent =
        conn.status === 'unsupported'
          ? 'This browser can’t pair with a phone. Try Chrome or Safari.'
          : conn.status === 'offline'
            ? 'Can’t reach the pairing service. Check this computer’s internet connection. It keeps trying by itself.'
            : 'Getting a pairing code…';
      $('#remoteUrl').textContent = '';
      return;
    }
    if (box.dataset.url === url && box.className === 'qr') return;
    box.dataset.url = url;
    box.className = 'qr';
    try {
      box.innerHTML = QR.svg(url);
    } catch (e) {
      box.className = 'qr empty';
      box.textContent = 'Could not draw the code.';
    }
    $('#remoteUrl').textContent = url.replace(/^https?:\/\//, '');
  }

  function updatePresence() {
    const el = $('#phoneStatus');
    const label = el.querySelector('.label');
    el.classList.remove('on', 'off');
    if (!conn.connected && remotes === 0) {
      if (conn.status !== 'connecting') el.classList.add('off');
      label.textContent = conn.status === 'connecting' ? 'Connecting…' : 'Phone pairing offline';
    } else if (remotes > 0) {
      el.classList.add('on');
      label.textContent = remotes === 1 ? 'Phone connected' : remotes + ' phones connected';
    } else {
      label.textContent = 'No phone connected';
    }
    updateHud();
  }

  // ------------------------------------------------------------------
  // settings controls (right column)

  ['fontSize', 'lineHeight', 'width', 'readingLine', 'wpm'].forEach(function (k) {
    const el = document.getElementById(k);
    el.addEventListener('input', function () { setSetting(k, Number(el.value), false); });
  });
  BOOLS.forEach(function (k) {
    const el = document.getElementById(k);
    el.addEventListener('change', function () { setSetting(k, el.checked, false); });
  });
  document.querySelectorAll('.seg').forEach(function (seg) {
    const k = seg.dataset.key;
    seg.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        setSetting(k, k === 'countdown' ? Number(b.dataset.v) : b.dataset.v, false);
      });
    });
  });

  function fmtSetting(k) {
    switch (k) {
      case 'fontSize': return S.fontSize.toFixed(1);
      case 'lineHeight': return S.lineHeight.toFixed(2);
      case 'width': return Math.round(S.width) + '%';
      case 'readingLine': return Math.round(S.readingLine) + '%';
      case 'wpm': return String(S.wpm);
    }
    return '';
  }

  function syncControls() {
    ['fontSize', 'lineHeight', 'width', 'readingLine', 'wpm'].forEach(function (k) {
      const el = document.getElementById(k);
      if (Number(el.value) !== S[k]) el.value = S[k];
      document.querySelector('output[data-for="' + k + '"]').textContent = fmtSetting(k);
    });
    BOOLS.forEach(function (k) { document.getElementById(k).checked = !!S[k]; });
    document.querySelectorAll('.seg').forEach(function (seg) {
      const k = seg.dataset.key;
      seg.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('on', String(S[k]) === b.dataset.v);
      });
    });
    updateMeta();
  }

  function setSetting(k, v, announce) {
    if (k === 'wpm') return setWpm(v, announce);
    if (RANGES[k]) {
      v = Number(v);
      if (!isFinite(v)) return;
      v = clamp(Math.round(v * 100) / 100, RANGES[k][0], RANGES[k][1]);
    } else if (CHOICES[k]) {
      if (CHOICES[k].indexOf(v) === -1) return;
    } else if (BOOLS.indexOf(k) !== -1) {
      v = !!v;
    } else return;
    if (S[k] === v) return;
    S[k] = v;
    applyLook();
    if (mode === 'prompt') layout();
    syncControls();
    if (announce && mode === 'prompt') {
      const names = {
        fontSize: 'Text size ' + fmtSetting('fontSize'),
        lineHeight: 'Line spacing ' + fmtSetting('lineHeight'),
        width: 'Width ' + fmtSetting('width'),
        readingLine: 'Reading line ' + fmtSetting('readingLine'),
        mirrorX: S.mirrorX ? 'Mirrored' : 'Not mirrored',
        mirrorY: S.mirrorY ? 'Upside down' : 'Right side up',
        countdown: S.countdown ? S.countdown + ' second countdown' : 'No countdown',
        fade: S.fade ? 'Dimming read lines' : 'Not dimming',
      };
      if (names[k]) toast(names[k]);
    }
    sendState(true);
  }

  function setWpm(v, announce) {
    v = Number(v);
    if (!isFinite(v)) return;
    v = clamp(Math.round(v / 5) * 5, RANGES.wpm[0], RANGES.wpm[1]);
    const changed = v !== S.wpm;
    S.wpm = v;
    syncControls();
    renderList();
    if (mode === 'prompt' && (announce !== false)) toast(v + ' words/min');
    if (changed) sendState(true);
  }

  // ------------------------------------------------------------------
  // display: layout

  function applyLook() {
    invalidate();
    prompterEl.dataset.theme = S.theme;
    mirrorEl.style.transform = 'scale(' + (S.mirrorX ? -1 : 1) + ',' + (S.mirrorY ? -1 : 1) + ')';
    textBody.style.fontSize = S.fontSize + 'vw';
    textBody.style.lineHeight = String(S.lineHeight);
    textBody.style.width = S.width + 'vw';
    textBody.style.textAlign = S.align;
    fadeEl.classList.toggle('hidden', !S.fade);
  }

  function refreshText(resetToTop) {
    const text = current ? current.text || '' : '';
    const id = current ? current.id : null;
    if (text === renderedText && id === renderedId && !resetToTop) return;
    if (resetToTop || id !== renderedId) {
      savedAnchor = null;
      lines = [];
      y = 0;
      pending = 0;
      anim = null;
    } else {
      invalidate();
    }
    parsed = TP.parseScript(text);
    spans = TP.renderScript(textBody, parsed);
    renderedText = text;
    renderedId = id;
    layoutDirty = true;
    if (mode === 'prompt') layout();
  }

  function invalidate() {
    if (!layoutDirty && !savedAnchor) savedAnchor = anchorNow();
    layoutDirty = true;
  }

  function anchorNow() {
    if (!lines.length) return null;
    const k = lineAt(y);
    return { w: lines[k].s, f: (y - lines[k].c) / lh };
  }

  function layout() {
    if (mode !== 'prompt') return;
    const vw = window.innerWidth / 100;
    lh = Math.max(1, S.fontSize * vw * S.lineHeight);
    R = (window.innerHeight * S.readingLine) / 100;
    lines = [];
    let cur = null;
    for (let i = 0; i < spans.length; i++) {
      const sp = spans[i];
      const top = sp.offsetTop;
      if (!cur || top - cur.top > lh * 0.5) {
        cur = { top: top, c: top + sp.offsetHeight / 2, s: i, e: i };
        lines.push(cur);
      } else cur.e = i;
    }
    const a = savedAnchor;
    savedAnchor = null;
    y = a ? yForWord(a.w) + a.f * lh : minY();
    y = clamp(y, minY(), maxY());
    layoutDirty = false;

    const fontPx = S.fontSize * vw;
    fadeEl.style.height = Math.max(0, R - lh * 0.62) + 'px';
    marker.style.top = R + 'px';
    const h = clamp(fontPx * 0.32, 12, 40);
    marker.querySelectorAll('.arrow').forEach(function (el) {
      el.style.top = -h + 'px';
      el.style.borderTopWidth = h + 'px';
      el.style.borderBottomWidth = h + 'px';
    });
    marker.querySelector('.left').style.borderLeftWidth = h * 1.4 + 'px';
    marker.querySelector('.right').style.borderRightWidth = h * 1.4 + 'px';
    $('#endMark').style.display = lines.length ? '' : 'none';
    applyTransform();
    curLine = lineAt(y);
    sendState();
  }

  function minY() { return lines.length ? lines[0].c : 0; }
  function maxY() { return lines.length ? lines[lines.length - 1].c : 0; }

  function lineAt(pos) {
    let lo = 0;
    let hi = lines.length - 1;
    if (hi < 0) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].c - lh / 2 <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function lineOfWord(i) {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].s <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function yForWord(i) {
    if (!lines.length) return 0;
    return lines[lineOfWord(i)].c;
  }

  function speedPx() {
    if (!lines.length || !parsed.spoken) return 0;
    const pxPerWord = (maxY() - minY() + lh) / parsed.spoken;
    return (S.wpm / 60) * pxPerWord;
  }

  function applyTransform() {
    scroller.style.transform = 'translate3d(0,' + (R - y).toFixed(2) + 'px,0)';
  }

  window.addEventListener('resize', function () {
    invalidate();
    if (mode === 'prompt') layout();
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { invalidate(); });
  }

  // ------------------------------------------------------------------
  // display: motion

  function ease(p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; }

  function glideTo(target, dur) {
    target = clamp(target, minY(), maxY());
    pending = 0;
    anim = { from: y, to: target, t0: performance.now(), dur: dur || 420 };
  }

  let lastTs = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    if (mode !== 'prompt') return;
    if (layoutDirty) layout();
    const v = playing ? speedPx() : 0;
    if (anim) {
      anim.from += v * dt;
      anim.to += v * dt;
      const p = Math.min(1, (ts - anim.t0) / anim.dur);
      y = anim.from + (anim.to - anim.from) * ease(Math.max(0, p));
      if (p >= 1) anim = null;
    } else {
      y += v * dt;
    }
    if (pending) {
      const step = pending * Math.min(1, dt * 18);
      y += step;
      pending -= step;
      if (Math.abs(pending) < 0.3) {
        y += pending;
        pending = 0;
      }
    }
    const lo = minY();
    const hi = maxY();
    if (y < lo) { y = lo; pending = 0; }
    if (y > hi) {
      y = hi;
      pending = 0;
      if (playing) {
        setPlaying(false);
        toast('End of script');
      }
    }
    applyTransform();
    const k = lineAt(y);
    if (k !== curLine) {
      curLine = k;
      sendState();
    } else if ((playing || anim || pending) && ts - lastSent > 500) {
      sendState();
    }
  }
  requestAnimationFrame(frame);

  function start() {
    if (mode !== 'prompt' || playing || countdownLeft) return;
    if (layoutDirty) layout();
    if (!lines.length) {
      toast('This script is empty');
      return;
    }
    if (y >= maxY() - 1) {
      y = minY();
      applyTransform();
    }
    if (S.countdown > 0 && y <= minY() + lh * 0.5) runCountdown(S.countdown);
    else setPlaying(true);
  }

  function runCountdown(n) {
    countdownLeft = n;
    prompterEl.classList.add('is-counting');
    showCount(n);
    sendState(true);
    countdownTimer = setInterval(function () {
      countdownLeft--;
      if (countdownLeft <= 0) {
        cancelCountdown();
        setPlaying(true, true);
      } else {
        showCount(countdownLeft);
        sendState(true);
      }
    }, 1000);
  }

  function showCount(n) {
    countdownEl.textContent = n;
    countdownEl.classList.remove('show');
    void countdownEl.offsetWidth; // restart the animation
    countdownEl.classList.add('show');
  }

  function cancelCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
    countdownLeft = 0;
    countdownEl.classList.remove('show');
    prompterEl.classList.remove('is-counting');
  }

  function stop(announce) {
    const was = playing || countdownLeft;
    cancelCountdown();
    if (playing) setPlaying(false, !announce);
    else if (was) sendState(true);
    if (was && announce && mode === 'prompt') toast('Paused');
  }

  function setPlaying(p, silent) {
    playing = p;
    prompterEl.classList.toggle('is-playing', p);
    $('#mbPlay').firstChild.textContent = p ? 'Pause ' : 'Play ';
    if (!silent && p && mode === 'prompt') toast('Go');
    sendState(true);
  }

  function restart() {
    stop(false);
    if (mode === 'prompt') {
      if (layoutDirty) layout();
      glideTo(minY(), 500);
      toast('Back to the top');
    } else {
      y = minY();
    }
    sendState(true);
  }

  function stepLine(d) {
    if (mode !== 'prompt' || !lines.length) return;
    if (layoutDirty) layout();
    const k = lineAt(y);
    let target = k + d;
    // going back from the middle of a line lands on that line first
    if (d < 0 && y - lines[k].c > lh * 0.3) target = k + d + 1;
    target = clamp(target, 0, lines.length - 1);
    glideTo(lines[target].c, 320);
  }

  function jumpToWord(i) {
    if (mode !== 'prompt' || !isFinite(i)) return;
    if (layoutDirty) layout();
    if (!lines.length) return;
    glideTo(yForWord(clamp(i, 0, spans.length - 1)), 520);
  }

  // ------------------------------------------------------------------
  // display: modes

  function enterPrompt(gesture) {
    if (dirty) doSave();
    refreshText(false);
    const wasEdit = mode !== 'prompt';
    mode = 'prompt';
    editorEl.classList.add('hidden');
    prompterEl.classList.remove('hidden');
    textIn.blur();
    titleIn.blur();
    layout();
    if (gesture && S.fullscreen && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () {});
    }
    keepAwake();
    wakeMouse();
    if (wasEdit) sendState(true);
  }

  function exitPrompt() {
    stop(false);
    invalidate();
    mode = 'edit';
    prompterEl.classList.add('hidden');
    editorEl.classList.remove('hidden');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    sendState(true);
  }

  $('#startBtn').addEventListener('click', function () { enterPrompt(true); });
  $('#mbEditor').addEventListener('click', exitPrompt);
  $('#mbPlay').addEventListener('click', function () { onCmd({ a: 'toggle' }); });
  $('#mbFull').addEventListener('click', toggleFullscreen);

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
  }

  let wakeLock = null;
  function keepAwake() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && mode === 'prompt') keepAwake();
  });

  // hide the mouse pointer and toolbar when the mouse is still
  let idleTimer = null;
  function wakeMouse() {
    prompterEl.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { prompterEl.classList.add('idle'); }, 2200);
  }
  prompterEl.addEventListener('mousemove', wakeMouse);

  prompterEl.addEventListener('wheel', function (e) {
    if (mode !== 'prompt') return;
    e.preventDefault();
    anim = null;
    const dy = e.deltaMode === 1 ? e.deltaY * lh * 0.5 : e.deltaY;
    pending += dy * (S.mirrorY ? -1 : 1);
  }, { passive: false });

  // ------------------------------------------------------------------
  // keyboard

  document.addEventListener('keydown', function (e) {
    if (mode === 'edit') {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        enterPrompt(true);
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    let handled = true;
    if (k === ' ' || k === 'Enter') onCmd({ a: 'toggle' });
    else if (k === 'ArrowUp' || k === 'PageUp') stepLine(-1);
    else if (k === 'ArrowDown' || k === 'PageDown') stepLine(1);
    else if (k === 'ArrowLeft' || k === '-' || k === '_') setWpm(S.wpm - 5);
    else if (k === 'ArrowRight' || k === '=' || k === '+') setWpm(S.wpm + 5);
    else if (k === '[') setSetting('fontSize', S.fontSize - 0.5, true);
    else if (k === ']') setSetting('fontSize', S.fontSize + 0.5, true);
    else if (k === 'r' || k === 'R' || k === 'Home') restart();
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else if (k === 'm' || k === 'M') setSetting('mirrorX', !S.mirrorX, true);
    else if (k === 'Escape') {
      if (!document.fullscreenElement) exitPrompt();
    } else handled = false;
    if (handled) e.preventDefault();
  });

  // ------------------------------------------------------------------
  // feedback on the prompter screen

  let toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1300);
  }

  function updateHud() {
    if (mode !== 'prompt') return;
    const sp = speedPx();
    const left = sp ? (maxY() - y) / sp : 0;
    const phone = remotes === 0 && !conn.connected
      ? '<span class="bad">●</span> Phone pairing offline'
      : remotes > 0
        ? '<span class="ok">●</span> Phone connected'
        : '<span class="bad">●</span> No phone';
    hudEl.innerHTML = S.wpm + ' words/min &nbsp;·&nbsp; ' + TP.fmtTime(left) + ' left &nbsp;·&nbsp; ' + phone;
  }

  // ------------------------------------------------------------------
  // tell the phone what's going on

  function sendState(force) {
    const now = performance.now();
    if (!force && now - lastSent < 100) {
      if (!stateTimer) stateTimer = setTimeout(function () { stateTimer = null; sendState(true); }, 100);
      return;
    }
    clearTimeout(stateTimer);
    stateTimer = null;
    lastSent = now;
    const showing = mode === 'prompt' && lines.length && !layoutDirty;
    const line = showing && curLine >= 0 ? lines[curLine] : null;
    const sp = showing ? speedPx() : 0;
    const span = maxY() - minY();
    conn.send({
      t: 'state',
      mode: mode,
      scriptId: current ? current.id : null,
      playing: playing,
      countdown: countdownLeft,
      wpm: S.wpm,
      line: line ? [line.s, line.e] : null,
      progress: showing && span > 0 ? clamp((y - minY()) / span, 0, 1) : 0,
      left: sp ? (maxY() - y) / sp : current ? (TP.parseScript(current.text).spoken / S.wpm) * 60 : 0,
      total: sp ? span / sp : 0,
      settings: S,
    });
    updateHud();
  }

  // For checking the page from developer tools.
  window.__tp = {
    state: function () {
      return { mode: mode, playing: playing, y: y, line: curLine, lines: lines.length, wpm: S.wpm, countdown: countdownLeft, script: current && current.id };
    },
    cmd: onCmd,
  };
})();
