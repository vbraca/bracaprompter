/*
 * Small QR code generator (byte mode, error correction level M, versions 1-10,
 * up to ~210 characters). Written for this app so the page works with no
 * internet connection. Follows ISO/IEC 18004.
 */
(function (root) {
  'use strict';
  const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  const NUM_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  function rawModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    const r = new Array(degree).fill(0);
    r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < r.length; j++) {
        r[j] = gfMul(r[j], root);
        if (j + 1 < r.length) r[j] ^= r[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return r;
  }

  function rsRemainder(data, div) {
    const r = div.map(function () {
      return 0;
    });
    for (const b of data) {
      const f = b ^ r.shift();
      r.push(0);
      for (let i = 0; i < div.length; i++) r[i] ^= gfMul(div[i], f);
    }
    return r;
  }

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 0;
    let dataCw = 0;
    for (let v = 1; v <= 10; v++) {
      const cw = Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v - 1] * NUM_BLOCKS[v - 1];
      if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= cw * 8) {
        ver = v;
        dataCw = cw;
        break;
      }
    }
    if (!ver) throw new Error('Text too long for this QR generator');

    // --- data bits ---
    const bits = [];
    const put = function (val, len) {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    put(0x4, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(function (b) {
      put(b, 8);
    });
    const cap = dataCw * 8;
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }

    // --- error correction + interleaving ---
    const numBlocks = NUM_BLOCKS[ver - 1];
    const eccLen = ECC_PER_BLOCK[ver - 1];
    const raw = Math.floor(rawModules(ver) / 8);
    const numShort = numBlocks - (raw % numBlocks);
    const shortLen = Math.floor(raw / numBlocks);
    const div = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const all = [];
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) {
        if (i !== shortLen - eccLen || j >= numShort) all.push(blocks[j][i]);
      }
    }

    // --- matrix ---
    const size = ver * 4 + 17;
    const mod = [];
    const fn = [];
    for (let y = 0; y < size; y++) {
      mod.push(new Array(size).fill(false));
      fn.push(new Array(size).fill(false));
    }
    const set = function (x, y, d) {
      mod[y][x] = d;
      fn[y][x] = true;
    };
    for (let i = 0; i < size; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    const finder = function (cx, cy) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) {
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            set(x, y, d !== 2 && d !== 4);
          }
        }
      }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    const al = ALIGN[ver - 1];
    const na = al.length;
    for (let i = 0; i < na; i++) {
      for (let j = 0; j < na; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    const drawFormat = function (mask) {
      const d = (0 << 3) | mask; // level M = 0b00
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((d << 10) | rem) ^ 0x5412;
      const bit = function (i) {
        return ((b >>> i) & 1) === 1;
      };
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6));
      set(8, 8, bit(7));
      set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bt = ((b >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const c = Math.floor(i / 3);
        set(a, c, bt);
        set(c, a, bt);
      }
    }
    let n = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const up = ((right + 1) & 2) === 0;
          const y = up ? size - 1 - vert : vert;
          if (!fn[y][x] && n < all.length * 8) {
            mod[y][x] = ((all[n >>> 3] >>> (7 - (n & 7))) & 1) === 1;
            n++;
          }
        }
      }
    }

    // --- masking ---
    const maskFns = [
      function (x, y) { return (x + y) % 2 === 0; },
      function (x, y) { return y % 2 === 0; },
      function (x, y) { return x % 3 === 0; },
      function (x, y) { return (x + y) % 3 === 0; },
      function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
      function (x, y) { return ((x * y) % 2) + ((x * y) % 3) === 0; },
      function (x, y) { return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; },
      function (x, y) { return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; },
    ];
    const applyMask = function (m) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) if (!fn[y][x] && maskFns[m](x, y)) mod[y][x] = !mod[y][x];
      }
    };
    const penalty = function () {
      let s = 0;
      for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
          let run = 1;
          for (let b = 1; b < size; b++) {
            const cur = pass ? mod[b][a] : mod[a][b];
            const prev = pass ? mod[b - 1][a] : mod[a][b - 1];
            if (cur === prev) {
              run++;
              if (run === 5) s += 3;
              else if (run > 5) s++;
            } else run = 1;
          }
          for (let b = 0; b + 10 < size; b++) {
            let str = '';
            for (let k = 0; k < 11; k++) str += (pass ? mod[b + k][a] : mod[a][b + k]) ? '1' : '0';
            if (str === '10111010000' || str === '00001011101') s += 40;
          }
        }
      }
      for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
          const c = mod[y][x];
          if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) s += 3;
        }
      }
      let dark = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mod[y][x]) dark++;
      s += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
      return s;
    };
    let best = 0;
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      const sc = penalty();
      if (sc < bestScore) {
        bestScore = sc;
        best = m;
      }
      applyMask(m);
    }
    applyMask(best);
    drawFormat(best);
    return { size: size, modules: mod, version: ver, mask: best };
  }

  function svg(text) {
    const q = encode(text);
    const n = q.size + 8;
    let d = '';
    for (let y = 0; y < q.size; y++) {
      for (let x = 0; x < q.size; x++) if (q.modules[y][x]) d += 'M' + (x + 4) + ',' + (y + 4) + 'h1v1h-1z';
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>'
    );
  }

  root.QR = { encode: encode, svg: svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.QR;
})(typeof window !== 'undefined' ? window : globalThis);
