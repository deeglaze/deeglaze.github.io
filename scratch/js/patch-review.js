// Renders an inline-reply patch review (a format-patch file whose quoted
// lines start with "> " and whose reviewer comments are unquoted) as HTML.
//
// Usage: <div id="review" data-src="path/to/review.patch"></div>
//        <script src="../js/patch-review.js"></script>
(function () {
  'use strict';

  // Quoted hunks with more body lines than SNIP_LIMIT are snipped to at most
  // SNIP_KEEP lines, fewer if a function definition or hunk header comes
  // sooner. "show +N" reveals SNIP_STEP more lines.
  const SNIP_LIMIT = 20;
  const SNIP_KEEP = 10;
  const SNIP_STEP = 10;
  // Inline highlighting is skipped when less than this share of a changed
  // line pair is common; the lines are then unrelated, not edited.
  const MIN_COMMON = 0.3;
  // Token-level LCS is quadratic; fall back to prefix/suffix beyond this.
  const LCS_CAP = 40000;

  const DIFF_KINDS = new Set(['file', 'meta', 'hunk', 'add', 'del', 'ctx']);
  // A list item starts with "- " or "N. " / "N) ", indented by up to three
  // spaces.
  const ITEM = /^ {0,3}(?:-|\d+[.)]) /;
  const BODY_KINDS = new Set(['add', 'del', 'ctx']);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---- parsing -----------------------------------------------------------

  function classify(body, st) {
    let m;
    if (st.mode === 'sig') return 'msg';
    if (body.startsWith('diff --git ')) {
      st.mode = 'file';
      st.file = (body.match(/ b\/(.*)$/) || [])[1] || st.file;
      return 'file';
    }
    if ((m = body.match(/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/))) {
      if (m[1]) st.file = m[1];
      st.mode = 'file';
      return 'meta';
    }
    if (/^--- (?:a\/|\/dev\/null)/.test(body)) {
      st.mode = 'file';
      return 'meta';
    }
    if (/^@@ -\d/.test(body)) {
      st.mode = 'hunk';
      return 'hunk';
    }
    if (st.mode === 'head') return 'msg';
    if (st.mode === 'file') return 'meta';
    if (body === '-- ' || body === '--') {
      st.mode = 'sig';
      return 'msg';
    }
    switch (body[0]) {
      case '+': return 'add';
      case '-': return 'del';
      case '\\': return 'meta';
      case ' ':
      case undefined: return 'ctx';
    }
    return 'msg';
  }

  // Returns blocks of consecutive quoted lines ({quoted: true, lines: [{kind,
  // text, file}]}) and of consecutive reviewer lines ({quoted: false, lines:
  // [string]}).
  function parse(text) {
    const blocks = [];
    const st = { mode: 'head', file: null };
    let cur = null;
    for (const raw of text.replace(/\n$/, '').split('\n')) {
      const quoted = raw.startsWith('>');
      if (!cur || cur.quoted !== quoted) {
        cur = { quoted, lines: [] };
        blocks.push(cur);
      }
      if (!quoted) {
        cur.lines.push(raw);
        continue;
      }
      const body = raw.startsWith('> ') ? raw.slice(2) : raw.slice(1);
      const kind = classify(body, st);
      const text = BODY_KINDS.has(kind) ? body.slice(1) : body;
      cur.lines.push({ kind, text, file: st.file });
    }
    return blocks;
  }

  // ---- in-line change highlighting --------------------------------------

  function tokens(s) {
    return s.match(/\w+|\s+|[^\w\s]/g) || [];
  }

  // Returns [oldChanged[], newChanged[]] flags per token, or null if the
  // lines share too little to be called an edit of each other.
  function diffTokens(a, b) {
    let lo = 0;
    while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
    let ha = a.length, hb = b.length;
    while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) { ha--; hb--; }

    const fa = a.map((_, i) => i >= lo && i < ha);
    const fb = b.map((_, i) => i >= lo && i < hb);
    const n = ha - lo, m = hb - lo;
    if (n && m && n * m <= LCS_CAP) {
      const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
      for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
          t[i][j] = a[lo + i] === b[lo + j] ? t[i + 1][j + 1] + 1
                                            : Math.max(t[i + 1][j], t[i][j + 1]);
      for (let i = 0, j = 0; i < n && j < m;) {
        if (a[lo + i] === b[lo + j]) { fa[lo + i] = fb[lo + j] = false; i++; j++; }
        else if (t[i + 1][j] >= t[i][j + 1]) i++;
        else j++;
      }
    }
    const common = (s, f) => s.reduce((n, tk, i) => n + (f[i] ? 0 : tk.length), 0);
    const total = Math.min(a.join('').length, b.join('').length);
    if (!total || common(a, fa) / total < MIN_COMMON) return null;
    return [fa, fb];
  }

  function segments(toks, flags) {
    const segs = [];
    toks.forEach((tk, i) => {
      const last = segs[segs.length - 1];
      if (last && last[1] === flags[i]) last[0] += tk;
      else segs.push([tk, flags[i]]);
    });
    return segs;
  }

  // Pairs the i-th removed line of each remove run with the i-th added line
  // of the add run that follows it.
  function markInline(lines) {
    for (let i = 0; i < lines.length;) {
      if (lines[i].kind !== 'del') { i++; continue; }
      let d = i;
      while (d < lines.length && lines[d].kind === 'del') d++;
      let a = d;
      while (a < lines.length && lines[a].kind === 'add') a++;
      for (let k = 0; k < Math.min(d - i, a - d); k++) {
        const o = lines[i + k], n = lines[d + k];
        const ot = tokens(o.text), nt = tokens(n.text);
        const r = diffTokens(ot, nt);
        if (!r) continue;
        o.segs = segments(ot, r[0]);
        n.segs = segments(nt, r[1]);
      }
      i = a;
    }
  }

  // ---- snipping ----------------------------------------------------------

  function isFuncDef(text) {
    if (/;\s*$/.test(text)) return false;
    if (/^(?:async\s+)?def\s+\w+|^class\s+\w+|^\w+\(\)\s*\{?\s*$/.test(text)) return true;
    if (/^(?:if|for|while|switch|return|else|do|goto|case|typedef|sizeof)\b/.test(text)) return false;
    return /^[A-Za-z_][\w *]*[ *]\w+\(/.test(text);
  }

  // Index of the first line to show: the nearest hunk header or function
  // definition among the last SNIP_KEEP lines of the run, else the first of
  // those lines. Runs that are short enough are shown whole.
  function snipStart(lines) {
    if (lines.filter(l => BODY_KINDS.has(l.kind)).length <= SNIP_LIMIT) return 0;
    const floor = Math.max(0, lines.length - SNIP_KEEP);
    for (let i = lines.length - 1; i >= floor; i--) {
      const l = lines[i];
      if (l.kind === 'hunk' || (BODY_KINDS.has(l.kind) && isFuncDef(l.text))) return i;
    }
    return floor;
  }

  // ---- rendering ---------------------------------------------------------

  function renderLine(l) {
    const row = el('div', 'l ' + l.kind);
    if (l.kind === 'add' || l.kind === 'del' || l.kind === 'ctx') {
      row.appendChild(el('span', 'sg', { add: '+', del: '-', ctx: ' ' }[l.kind]));
      const t = el('span', 't');
      if (l.segs) {
        for (const [s, changed] of l.segs)
          t.appendChild(changed ? el('span', 'ch', s) : document.createTextNode(s));
      } else {
        t.textContent = l.text;
      }
      row.appendChild(t);
    } else {
      row.textContent = l.text;
    }
    return row;
  }

  // opts.snip === false shows the whole run.
  function renderDiff(lines, opts) {
    markInline(lines);
    const start = opts && opts.snip === false ? 0 : snipStart(lines);
    const box = el('div', 'diff');
    const inner = el('div', 'diff-in');
    box.appendChild(inner);

    if (start > 0) {
      const file = lines[start].file;
      if (file) inner.appendChild(el('div', 'l file', file));
      const hidden = lines.slice(0, start).map(renderLine);
      let revealed = 0;
      const bar = el('div', 'snip');
      const more = el('button', null);
      const all = el('button', null);
      const msg = el('span');
      [more, all].forEach(b => { b.type = 'button'; });
      bar.append(msg, more, all);
      const update = () => {
        const left = start - revealed;
        hidden.forEach((r, i) => { r.hidden = i < left; });
        bar.hidden = false;
        msg.textContent = '⋯ ' + left + ' line' + (left === 1 ? '' : 's') + ' snipped';
        more.hidden = left === 0;
        more.textContent = 'show +' + Math.min(SNIP_STEP, left);
        all.textContent = left === 0 ? 'hide' : 'show all';
      };
      more.addEventListener('click', () => {
        revealed = Math.min(start, revealed + SNIP_STEP);
        update();
      });
      all.addEventListener('click', () => {
        revealed = revealed === start ? 0 : start;
        update();
      });
      update();
      inner.appendChild(bar);
      hidden.forEach(r => inner.appendChild(r));
    }
    lines.slice(start).forEach(l => inner.appendChild(renderLine(l)));
    return box;
  }

  function renderQuoted(block) {
    const out = document.createDocumentFragment();
    let run = [];
    const flush = () => {
      if (!run.length) return;
      if (DIFF_KINDS.has(run[0].kind)) {
        out.appendChild(renderDiff(run));
      } else {
        const q = el('blockquote', 'q');
        q.appendChild(el('pre', null, run.map(l => l.text).join('\n')));
        out.appendChild(q);
      }
      run = [];
    };
    for (const l of block.lines) {
      if (run.length && DIFF_KINDS.has(run[0].kind) !== DIFF_KINDS.has(l.kind)) flush();
      run.push(l);
    }
    flush();
    return out;
  }

  function inline(parent, text) {
    text.split(/(`[^`]+`)/).forEach(part => {
      if (part.length > 2 && part[0] === '`' && part[part.length - 1] === '`')
        parent.appendChild(el('code', null, part.slice(1, -1)));
      else if (part)
        parent.appendChild(document.createTextNode(part));
    });
  }

  function renderComment(lines) {
    lines = lines.slice();
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) return null;

    const box = el('div', 'rc');
    const paras = [[]];
    for (const l of lines) {
      if (l.trim()) paras[paras.length - 1].push(l);
      else if (paras[paras.length - 1].length) paras.push([]);
    }
    // Consecutive indented paragraphs are one code block, blank lines included.
    const indented = p => p.length && p.every(l => /^\s{2,}|^\t/.test(l)) &&
                          !p.some(l => ITEM.test(l));
    for (let i = 0; i < paras.length; i++) {
      let p = paras[i];
      if (!p.length) continue;
      const code = indented(p);
      if (code) {
        while (i + 1 < paras.length && indented(paras[i + 1])) {
          p = p.concat([''], paras[++i]);
        }
      }
      if (!code && p.some(l => ITEM.test(l))) {
        // Lines before the first item are an introduction; lines that do
        // not start an item continue the previous one.
        const first = p.findIndex(l => ITEM.test(l));
        if (first > 0) {
          const e = el('p');
          inline(e, p.slice(0, first).map(l => l.trim()).join(' '));
          box.appendChild(e);
        }
        const num = p[first].match(/^ {0,3}(\d+)[.)] /);
        const list = el(num ? 'ol' : 'ul');
        if (num && num[1] !== '1') list.start = +num[1];
        const texts = [];
        for (const l of p.slice(first)) {
          if (ITEM.test(l)) texts.push('');
          texts[texts.length - 1] += (texts[texts.length - 1] ? ' ' : '') +
                                     l.replace(ITEM, '').trim();
        }
        for (const t of texts) {
          const li = el('li');
          inline(li, t);
          list.appendChild(li);
        }
        box.appendChild(list);
      } else if (code) {
        const e = el('pre');
        inline(e, p.join('\n'));
        box.appendChild(e);
      } else if (p.some(l => /^\s|^\*\s/.test(l))) {
        const e = el('p', 'list');
        inline(e, p.join('\n'));
        box.appendChild(e);
      } else {
        const e = el('p');
        inline(e, p.join(' '));
        box.appendChild(e);
      }
    }
    return box;
  }

  // Copies text to the clipboard; resolves on success. Falls back to
  // execCommand where the async clipboard API is missing or refuses.
  function copyText(text) {
    const legacy = () => new Promise((resolve, reject) => {
      const ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand('copy')) resolve();
        else reject(new Error('copy refused'));
      } catch (err) {
        reject(err);
      } finally {
        ta.remove();
      }
    });
    if (navigator.clipboard && window.isSecureContext)
      return navigator.clipboard.writeText(text).catch(legacy);
    return legacy();
  }

  // Shows a short-lived tooltip next to a link.
  function tooltip(link, message) {
    const old = link.parentNode.querySelector('.copied');
    if (old) old.remove();
    const tip = el('span', 'copied', message);
    tip.setAttribute('role', 'status');
    link.parentNode.appendChild(tip);
    setTimeout(() => tip.remove(), 1000);
  }

  // Gives a reply box an <a> anchor and a pilcrow link that jumps to the
  // anchor and copies its URL.
  function addAnchor(box, n) {
    const id = 'reply-' + n;
    const anchor = el('a', 'anchor');
    anchor.id = id;
    const link = el('a', 'pilcrow', '\u00b6');
    link.href = '#' + id;
    link.title = 'Link to this reply';
    link.setAttribute('aria-label', 'Link to reply ' + n);
    link.addEventListener('click', e => {
      e.preventDefault();
      location.hash = id;
      anchor.scrollIntoView();
      copyText(location.href)
        .then(() => tooltip(link, 'Copied to clipboard'))
        .catch(() => tooltip(link, 'Copy failed'));
    });
    box.prepend(anchor);
    box.appendChild(link);
  }

  function render(text) {
    const root = document.createDocumentFragment();
    let replies = 0;
    for (const b of parse(text)) {
      const node = b.quoted ? renderQuoted(b) : renderComment(b.lines);
      if (!node) continue;
      if (!b.quoted) addAnchor(node, ++replies);
      root.appendChild(node);
    }
    return root;
  }

  // ---- page glue ---------------------------------------------------------

  function init(host) {
    const src = host.dataset.src;
    const tabs = el('div', 'review-tabs');
    const mk = (id, label) => {
      const a = el('a', null, label);
      a.href = '#' + id;
      tabs.appendChild(a);
      return a;
    };
    const tStyled = mk('review', 'Stylized');
    const tRaw = mk('raw', 'Raw');
    const dl = el('a', 'rawlink', 'Download .patch');
    dl.href = src;
    dl.setAttribute('download', '');
    tabs.appendChild(dl);

    const styled = el('div', 'review-styled');
    const raw = el('pre', 'review-raw');
    raw.hidden = true;
    host.append(tabs, styled, raw);

    const show = () => {
      const isRaw = location.hash === '#raw';
      styled.hidden = isRaw;
      raw.hidden = !isRaw;
      tStyled.classList.toggle('here', !isRaw);
      tRaw.classList.toggle('here', isRaw);
    };
    window.addEventListener('hashchange', show);
    show();

    fetch(src)
      .then(r => {
        if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
        return r.text();
      })
      .then(text => {
        raw.textContent = text;
        styled.appendChild(render(text));
        // The browser scrolled before the replies existed.
        const target = location.hash.length > 1 && document.getElementById(location.hash.slice(1));
        if (target) target.scrollIntoView();
      })
      .catch(err => {
        const w = el('div', 'warn');
        w.appendChild(el('p', null, 'Could not load ' + src + ': ' + err.message +
          '. Browsers block fetch() on file:// URLs; serve the directory, ' +
          'for example with python3 -m http.server.'));
        styled.appendChild(w);
      });
  }

  // Shared with patch-walkthrough.js.
  window.PatchReview = { el, inline, renderDiff };

  const host = document.getElementById('review');
  if (host) init(host);
})();
