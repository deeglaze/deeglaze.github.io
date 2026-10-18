// Renders a per-patch code walkthrough: each unit of the patch (function,
// struct, section, ...) as code on the left and commentary on the right.
//
// Usage: <div id="walk" data-patch="patches/NNNN-x.patch" data-json="walk/NN.json"></div>
//        <script src="../js/patch-review.js"></script>
//        <script src="../js/patch-walkthrough.js"></script>
(function () {
  'use strict';

  const { el, inline, renderDiff } = window.PatchReview;

  // Raw (unquoted) patch lines to the line objects renderDiff takes.
  function lineObject(raw) {
    if (raw.startsWith('@@')) return { kind: 'hunk', text: raw };
    switch (raw[0]) {
      case '+': return { kind: 'add', text: raw.slice(1) };
      case '-': return { kind: 'del', text: raw.slice(1) };
      case ' ': return { kind: 'ctx', text: raw.slice(1) };
      case undefined: return { kind: 'ctx', text: '' };
    }
    return { kind: 'meta', text: raw };
  }

  // Short text with backticks and "- " bullet lines.
  function prose(parent, text) {
    let list = null;
    let para = [];
    const flush = () => {
      if (para.length) {
        const p = el('p');
        inline(p, para.join(' '));
        parent.appendChild(p);
        para = [];
      }
    };
    for (const l of text.split('\n')) {
      const m = l.match(/^\s*[-*] (.*)/);
      if (m) {
        flush();
        if (!list) {
          list = el('ul');
          parent.appendChild(list);
        }
        const li = el('li');
        inline(li, m[1]);
        list.appendChild(li);
      } else if (!l.trim()) {
        flush();
        list = null;
      } else if (list && /^\s+\S/.test(l)) {
        const li = list.lastChild;
        li.appendChild(document.createTextNode(' '));
        inline(li, l.trim());
      } else {
        list = null;
        para.push(l.trim());
      }
    }
    flush();
  }

  function slug(s) {
    return s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function renderUnit(u, lines, id) {
    const row = el('div', 'walk-unit');
    row.id = id;
    const code = el('div', 'wcode');
    code.appendChild(renderDiff(lines.slice(u.start - 1, u.end).map(lineObject), { snip: false }));
    const note = el('div', 'wnote');
    const h = el('h4');
    const a = el('a', null, u.title);
    a.href = '#' + id;
    h.appendChild(a);
    h.appendChild(el('span', 'kind', u.kind));
    note.appendChild(h);
    const sum = el('p', 'wsum');
    inline(sum, u.summary);
    note.appendChild(sum);
    if (u.details) prose(note, u.details);
    row.append(code, note);
    return row;
  }

  function render(host, walk, lines) {
    const root = el('div', 'walk');

    const over = el('div', 'woverview');
    prose(over, walk.overview);
    root.appendChild(over);

    const toc = el('div', 'wtoc');
    toc.appendChild(el('h3', null, 'Files'));
    const tl = el('ul');
    toc.appendChild(tl);
    root.appendChild(toc);

    walk.files.forEach((f, fi) => {
      const fid = 'f' + (fi + 1) + '-' + slug(f.path);
      const li = el('li');
      const fa = el('a', null, f.path);
      fa.href = '#' + fid;
      li.appendChild(fa);
      li.appendChild(el('span', 'count', ' ' + f.units.length + ' unit' + (f.units.length === 1 ? '' : 's')));
      tl.appendChild(li);

      const sec = el('section', 'walk-file');
      sec.id = fid;
      sec.appendChild(el('h2', null, f.path));
      const pur = el('div', 'wpurpose');
      prose(pur, f.purpose);
      sec.appendChild(pur);
      f.units.forEach((u, ui) => sec.appendChild(renderUnit(u, lines, fid + '-u' + (ui + 1))));
      root.appendChild(sec);
    });
    host.appendChild(root);
  }

  const host = document.getElementById('walk');
  if (!host) return;
  Promise.all([fetch(host.dataset.json).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
               fetch(host.dataset.patch).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })])
    .then(([walk, patch]) => render(host, walk, patch.split('\n')))
    .catch(err => {
      const w = el('div', 'warn');
      w.appendChild(el('p', null, 'Could not load the walkthrough: ' + err.message +
        '. Browsers block fetch() on file:// URLs; serve the directory, for example with python3 -m http.server.'));
      host.appendChild(w);
    });
})();
