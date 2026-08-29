// SPDX-License-Identifier: AGPL-3.0-or-later
// Injected into every page of the golden browser journeys (Playwright
// `context.addInitScript({ path })`, design §2.3 / §4.5). Plain script — no
// imports — so it runs before any app code. Exposes `window.__golden`:
//
//   captureState()   JSON-safe snapshot of window.PROJECT (F7): the same volatile
//                    keys the project-io strips (`charts`, `chartsReady`), functions
//                    dropped, typed arrays → arrays, NaN/±Infinity → strings (so the
//                    Node normaliser sees the same shape as in the Node tier).
//                    `stage6Cache` of the active CPT is captured separately under
//                    `cache` because it holds the Stage 6 analyses (legacy-controller
//                    renderStage6). The active CPT appears once, under `active`; its
//                    slot in `project.cpts` is a reference marker.
//   domText(sels)    innerText of the listed containers, whitespace-collapsed, one
//                    "## <selector>" header per match (design §1 "DOM text").
//   live()           live (unstripped) references for state-predicate waits (F6).
//   evalPredicate(s) evaluates a predicate source string against live() — the Node
//                    side passes `fn.toString()` through page.waitForFunction.
//   waitState(fn,ms) in-page promise variant of the same (polls every 20 ms).
//   nextFrame()      resolves after two animation frames (renderStage6 builds its
//                    charts in requestAnimationFrame, legacy-controller.js:16813).
(function () {
  if (window.__golden) return;
  var DROP = { charts: true, chartsReady: true };

  function replacer(key, value) {
    if (DROP[key] === true) return undefined;
    if (typeof value === 'function') return undefined;
    if (typeof value === 'number' && !isFinite(value)) return String(value);
    if (value && typeof value === 'object') {
      if (ArrayBuffer.isView(value)) return Array.prototype.slice.call(value);
      if (value instanceof Map) { var o = {}; value.forEach(function (v, k) { o[k] = v; }); return o; }
      if (value instanceof Set) return Array.from(value);
      if (typeof Element !== 'undefined' && value instanceof Element) return '<element:' + value.tagName.toLowerCase() + (value.id ? '#' + value.id : '') + '>';
    }
    return value;
  }
  function strip(v) {
    var text = JSON.stringify(v === undefined ? null : v, replacer);
    return text === undefined ? null : JSON.parse(text);
  }
  function collapse(text) {
    return String(text || '')
      .split('\n')
      .map(function (l) { return l.replace(/\s+/g, ' ').trim(); })
      .filter(Boolean)
      .join('\n');
  }

  window.__golden = {
    live: function () {
      var P = window.PROJECT;
      var S = P && P.cpts ? P.cpts[P.activeCptIdx] : null;
      return { project: P, active: S, cache: S ? S.stage6Cache : null, stage: this.activeStage() };
    },
    activeStage: function () {
      var panels = Array.prototype.slice.call(document.querySelectorAll('.panel'));
      for (var i = 0; i < panels.length; i++) if (panels[i].classList.contains('active')) return i;
      return -1;
    },
    captureState: function () {
      var P = window.PROJECT;
      if (!P) return null;
      var idx = P.activeCptIdx;
      var S = P.cpts[idx];
      var project = {};
      for (var k in P) if (Object.prototype.hasOwnProperty.call(P, k)) project[k] = P[k];
      project.cpts = P.cpts.map(function (c, i) {
        if (i === idx) return { '<active>': c.id };
        var o = {}; for (var kk in c) if (Object.prototype.hasOwnProperty.call(c, kk) && kk !== 'stage6Cache') o[kk] = c[kk];
        return o;
      });
      var active = {};
      for (var k2 in S) if (Object.prototype.hasOwnProperty.call(S, k2) && k2 !== 'stage6Cache') active[k2] = S[k2];
      return {
        stage: this.activeStage(),
        phase: P.phase,
        activeCptIdx: idx,
        project: strip(project),
        active: strip(active),
        cache: strip(S.stage6Cache || {})
      };
    },
    domText: function (selectors) {
      var out = [];
      (selectors || []).forEach(function (sel) {
        var els = Array.prototype.slice.call(document.querySelectorAll(sel));
        if (!els.length) { out.push('## ' + sel + '\n<absent>'); return; }
        els.forEach(function (el, i) {
          out.push('## ' + sel + (els.length > 1 ? ' [' + i + ']' : '') + '\n' + collapse(el.innerText));
        });
      });
      return out.join('\n');
    },
    localStorageByPrefix: function (prefix) {
      var out = [];
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf(prefix) === 0) {
          var raw = localStorage.getItem(key);
          var parsed; try { parsed = JSON.parse(raw); } catch (e) { parsed = raw; }
          out.push({ key: key, value: strip(parsed) });
        }
      }
      out.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
      return out;
    },
    evalPredicate: function (src) {
      var fn = (0, eval)('(' + src + ')');
      try { return !!fn(this.live()); } catch (e) { return false; }
    },
    waitState: function (fn, timeoutMs) {
      var self = this;
      var limit = timeoutMs || 30000;
      var t0 = Date.now();
      return new Promise(function (resolve, reject) {
        (function poll() {
          var ok = false;
          try { ok = !!fn(self.live()); } catch (e) { ok = false; }
          if (ok) return resolve(true);
          if (Date.now() - t0 > limit) return reject(new Error('waitState timeout after ' + limit + ' ms'));
          setTimeout(poll, 20);
        })();
      });
    },
    nextFrame: function () {
      return new Promise(function (resolve) {
        requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(true); }); });
      });
    }
  };
})();
