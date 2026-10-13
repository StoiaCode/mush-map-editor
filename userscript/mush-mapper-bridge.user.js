// ==UserScript==
// @name         MUSH Mapper bridge
// @namespace    stoia.red
// @version      1.0.0
// @description  Links MUSH Mapper to the Philadelphia by Night client: the map follows your position, and routes can be walked for you.
// @match        https://map.stoia.red/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @match        https://philadelphiabynight.net/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @noframes
// @downloadURL  https://map.stoia.red/userscript/mush-mapper-bridge.user.js
// @updateURL    https://map.stoia.red/userscript/mush-mapper-bridge.user.js
// ==/UserScript==

// Two roles, picked per page:
//   mapper — the page has <meta name="mush-mapper">. Relays between the page (window.postMessage)
//            and the PbN tab (shared userscript storage). All the actual logic is in js/live.js.
//   client — philadelphiabynight.net/play. Watches chat for "You move <dir> to <room>." and
//            types commands into the command box when asked.
// Shared storage keys:
//   mm_cmd     {seq, cmds}                   mapper → client: commands to type
//   mm_evt     {events:[{seq, dir, name}]}   client → mapper: recent moves, newest last
//   mm_ping / mm_pong {id}                   is a PbN tab there?
//   mm_active  tab id                        only the most recently used PbN tab acts, so a second
//                                            tab (an alt, say) neither doubles commands nor reports moves
(function () {
  'use strict';

  const VERSION = '1.0.0';
  let seqBase = 0;
  const nextSeq = () => (seqBase = Math.max(Date.now(), seqBase + 1));

  if (document.querySelector('meta[name="mush-mapper"]')) mapperRole();
  else if (location.hostname === 'philadelphiabynight.net') clientRole();

  // --------------------------------------------------------------------------
  // Mapper page
  // --------------------------------------------------------------------------

  function mapperRole() {
    const toPage = (type, data) => window.postMessage(Object.assign({ mm: 'bridge', type }, data || {}), location.origin);
    const hello = () => toPage('hello', { v: VERSION });

    window.addEventListener('message', e => {
      if (e.origin !== location.origin || !e.data || e.data.mm !== 'page') return;
      const m = e.data;
      if (m.type === 'probe') hello();
      else if (m.type === 'send' && Array.isArray(m.cmds)) {
        GM_setValue('mm_cmd', { seq: nextSeq(), cmds: m.cmds.map(String).slice(0, 20) });
      }
    });

    // only moves that happen after this page opened
    let lastEvt = ((GM_getValue('mm_evt') || {}).events || []).reduce((a, ev) => Math.max(a, ev.seq), 0);
    GM_addValueChangeListener('mm_evt', (key, oldV, v) => {
      for (const ev of (v && v.events) || []) {
        if (ev.seq <= lastEvt) continue;
        lastEvt = ev.seq;
        toPage('move', { dir: ev.dir, name: ev.name });
      }
    });

    GM_addValueChangeListener('mm_pong', () => toPage('client'));
    const ping = () => GM_setValue('mm_ping', { id: nextSeq() });
    setInterval(ping, 5000);
    ping();
    hello();
  }

  // --------------------------------------------------------------------------
  // PbN client (/play)
  // --------------------------------------------------------------------------

  function clientRole() {
    const CHAT_SELECTOR    = '.chat-container';
    const ARTICLE_SELECTOR = '[role="article"]';
    // Confirmed: "[SYSTEM] You move northeast to Cuthbert Street Alley."
    const MOVE_RE = /^You move (.+?) to (.+?)\.?$/;

    const tabId = Math.random().toString(36).slice(2);
    const isActive = () => GM_getValue('mm_active') === tabId;
    let onPlay = false;
    const claim = () => { if (onPlay && !isActive()) GM_setValue('mm_active', tabId); };

    // --- reading chat (same article parsing as pbn-room-presence) ---
    function getSystemText(article) {
      const p = article.querySelector('p');
      if (!p) return null;
      const tagSpan = p.querySelector('span.text-orange-9.text-weight-bold');
      if (!tagSpan || tagSpan.textContent.trim() !== '[SYSTEM]') return null;
      const full = (p.textContent || '').replace(/\s+/g, ' ').trim();
      return full.replace(/^\[SYSTEM\]\s*/, '');
    }

    const events = [];
    const seen = new WeakSet();
    function processArticle(article) {
      if (seen.has(article)) return;
      seen.add(article);
      const text = getSystemText(article);
      const m = text && MOVE_RE.exec(text);
      if (!m || !isActive()) return;
      events.push({ seq: nextSeq(), dir: m[1].trim(), name: m[2].trim() });
      while (events.length > 20) events.shift();
      GM_setValue('mm_evt', { events: events.slice() });
    }

    // --- typing commands (same approach as pbn-command-buttons) ---
    function setNativeValue(el, value) {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function pressEnter(el) {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }
    function isVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    }
    function findInput() {
      const pools = [
        Array.from(document.querySelectorAll('textarea')),
        Array.from(document.querySelectorAll('input[type="text"], input:not([type])')),
      ];
      for (const pool of pools) {
        const visible = pool.filter(isVisible);
        if (visible.length) {
          return visible.sort((a, b) =>
            b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
        }
      }
      return null;
    }
    const tick = ms => new Promise(r => setTimeout(r, ms));

    // One at a time, letting Vue settle between them; whatever the player had half-typed
    // is put back afterwards.
    let sending = Promise.resolve();
    function sendLines(lines) {
      sending = sending.then(async () => {
        const input = findInput();
        if (!input) return;
        const draft = input.value;
        for (const line of lines) {
          setNativeValue(input, line);
          await tick(0);
          pressEnter(input);
          await tick(60);
        }
        if (draft && !input.value) setNativeValue(input, draft);
      });
    }

    GM_addValueChangeListener('mm_ping', (key, oldV, v) => {
      if (isActive()) GM_setValue('mm_pong', { id: v && v.id });
    });
    GM_addValueChangeListener('mm_cmd', (key, oldV, v) => {
      if (isActive() && v && Array.isArray(v.cmds)) sendLines(v.cmds);
    });
    window.addEventListener('focus', claim);
    document.addEventListener('keydown', claim, true);
    document.addEventListener('mousedown', claim, true);
    window.addEventListener('pagehide', () => { if (isActive()) GM_setValue('mm_active', ''); });

    // --- mount on /play only (Vue Router navigates without reloads) ---
    let chatObserver = null;
    let waiter = null;

    function mount() {
      const container = document.querySelector(CHAT_SELECTOR);
      if (!container) return false;
      // lines already on screen are history, not moves happening now
      container.querySelectorAll(ARTICLE_SELECTOR).forEach(el => seen.add(el));
      chatObserver = new MutationObserver(mutations => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.matches(ARTICLE_SELECTOR)) processArticle(node);
            else node.querySelectorAll(ARTICLE_SELECTOR).forEach(processArticle);
          }
        }
      });
      chatObserver.observe(container, { childList: true, subtree: true });
      return true;
    }

    function watchRoute(isActiveRoute, enter, exit) {
      let active = null;
      function check() {
        const on = !!isActiveRoute();
        if (on === active) return;
        active = on;
        (on ? enter : exit)();
      }
      check();
      window.addEventListener('popstate', check);
      setInterval(check, 500);
    }

    function enter() {
      onPlay = true;
      claim();
      if (mount()) return;
      waiter = new MutationObserver(() => { if (mount()) { waiter.disconnect(); waiter = null; } });
      waiter.observe(document.body, { childList: true, subtree: true });
    }

    function exit() {
      onPlay = false;
      if (isActive()) GM_setValue('mm_active', '');
      if (waiter) { waiter.disconnect(); waiter = null; }
      if (chatObserver) { chatObserver.disconnect(); chatObserver = null; }
    }

    watchRoute(() => location.pathname === '/play', enter, exit);
  }
})();
