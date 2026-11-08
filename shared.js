/* Code shared by the prompter page and the phone remote. */
(function () {
  'use strict';
  const TP = (window.TP = {});

  /*
   * Split a script into paragraphs, lines and words. Both pages use this, so
   * a word's index means the same thing on the computer and on the phone.
   *   blank line      -> new paragraph
   *   line break      -> new line in the same paragraph
   *   [like this]     -> note to self (shown in a different color, not counted as spoken)
   *   *like this*     -> emphasis
   */
  TP.parseScript = function (text) {
    const words = [];
    const paras = [];
    const spokenBefore = [];
    let spoken = 0;
    let para = null;
    let inCue = false;
    let inEm = false;
    const rawLines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    for (const raw of rawLines) {
      const line = raw.trim();
      if (!line) {
        para = null;
        inCue = false;
        inEm = false;
        continue;
      }
      if (!para) {
        para = [];
        paras.push(para);
      }
      const lineWords = [];
      const tokens = line.match(/\S+/g) || [];
      for (const tok of tokens) {
        // notes in [brackets]
        if (!inCue && tok.charAt(0) === '[') inCue = true;
        const cue = inCue;
        if (inCue && tok.indexOf(']') !== -1) inCue = false;
        // *emphasis*
        let t = tok;
        let em = false;
        if (!cue) {
          let opens = false;
          if (t.length > 1 && t.charAt(0) === '*') {
            opens = true;
            t = t.slice(1);
          }
          const close = /\*([^\w*]*)$/.exec(t);
          let closes = false;
          if (close && (opens || inEm)) {
            closes = true;
            t = t.slice(0, close.index) + close[1];
          }
          em = inEm || opens;
          if (opens && !closes) inEm = true;
          if (closes) inEm = false;
          if (!t) t = tok;
        }
        const i = words.length;
        spokenBefore.push(spoken);
        if (!cue) spoken++;
        words.push({ t: t, cue: cue, em: em });
        lineWords.push(i);
      }
      para.push(lineWords);
    }
    spokenBefore.push(spoken);
    return { words: words, paras: paras, spoken: spoken, spokenBefore: spokenBefore };
  };

  /*
   * Render a parsed script into a container. Returns one <span> per word, in word order.
   * spaceInside: put the space after each word inside its span, so a highlight
   * across several words reads as one continuous band.
   */
  TP.renderScript = function (container, parsed, spaceInside) {
    container.textContent = '';
    const frag = document.createDocumentFragment();
    const spans = [];
    for (const para of parsed.paras) {
      const p = document.createElement('p');
      para.forEach(function (line, li) {
        if (li > 0) p.appendChild(document.createElement('br'));
        line.forEach(function (wi, k) {
          if (k > 0 && !spaceInside) p.appendChild(document.createTextNode(' '));
          const w = parsed.words[wi];
          const s = document.createElement('span');
          s.className = 'w' + (w.cue ? ' cue' : '') + (w.em ? ' em' : '');
          s.dataset.i = wi;
          s.textContent = spaceInside && k < line.length - 1 ? w.t + ' ' : w.t;
          p.appendChild(s);
          spans[wi] = s;
        });
      });
      frag.appendChild(p);
    }
    container.appendChild(frag);
    return spans;
  };

  TP.fmtTime = function (sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  };

  TP.uid = function () {
    return Math.random().toString(36).slice(2, 7) + Date.now().toString(36).slice(-5);
  };

  TP.titleOf = function (script) {
    if (!script) return 'Untitled';
    if (script.title && script.title.trim()) return script.title.trim();
    const first = (script.text || '').trim().split('\n')[0];
    return first ? (first.length > 40 ? first.slice(0, 40) + '…' : first) : 'Untitled';
  };

  TP.clamp = function (v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  };
})();
