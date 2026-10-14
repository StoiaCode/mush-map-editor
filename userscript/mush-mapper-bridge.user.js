// ==UserScript==
// @name         MUSH Mapper bridge
// @namespace    stoia.red
// @version      1.4.0
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
//   mm_evt     {events:[...]}                client → mapper, newest last:
//                {seq, kind:'move', dir, name}   "You move <dir> to <name>.", sent at once
//                {seq, kind:'room', room}        what the side panel shows (see readRoom), sent
//                                                once it has caught up with the move
//                {seq, kind:'goto', q}           "//goto <q>" typed in PbN (never sent to the game)
//                {seq, kind:'sys', text}         a refused move: "You can't go that way.",
//                                                "You are moving too quickly. Slow down." and the like
//                {seq, kind:'train', text}       a /train line: waiting, aboard, stop set, arriving,
//                                                doors closing, stepped off
//   mm_reply   {seq, lines}                  mapper → client: shown as a local [MAPPER] chat line
//   mm_ping / mm_pong {id}                   is a PbN tab there?
//   mm_active  tab id                        only the most recently used PbN tab acts, so a second
//                                            tab (an alt, say) neither doubles commands nor reports moves
//   mm_mapper  tab id                        likewise only the most recently used mapper tab answers
//                                            //goto, so two open mappers don't both start a walk
(function () {
  'use strict';

  const VERSION = '1.4.0';
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
      } else if (m.type === 'reply' && Array.isArray(m.lines)) {
        GM_setValue('mm_reply', { seq: nextSeq(), lines: m.lines.map(String).slice(0, 15) });
      }
    });

    // only moves that happen after this page opened
    const tabId = Math.random().toString(36).slice(2);
    const claim = () => GM_setValue('mm_mapper', tabId);
    claim();
    window.addEventListener('focus', claim);
    document.addEventListener('mousedown', claim, true);

    let lastEvt = ((GM_getValue('mm_evt') || {}).events || []).reduce((a, ev) => Math.max(a, ev.seq), 0);
    GM_addValueChangeListener('mm_evt', (key, oldV, v) => {
      for (const ev of (v && v.events) || []) {
        if (ev.seq <= lastEvt) continue;
        lastEvt = ev.seq;
        if (ev.kind === 'room') toPage('room', { room: ev.room });
        else if (ev.kind === 'goto') { if (GM_getValue('mm_mapper') === tabId) toPage('goto', { q: ev.q }); }
        else if (ev.kind === 'sys') toPage('sys', { text: ev.text });
        else if (ev.kind === 'train') toPage('train', { text: ev.text });
        else toPage('move', { dir: ev.dir, name: ev.name });
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
    // On connect: "[LOCATION] You are in Le Cafe de Rien - Coffee Bar"
    const YOU_ARE_IN_RE = /^You are in (.+?)\.?$/;
    // Confirmed: "You can't go that way." / "You are moving too quickly. Slow down."
    // Confirmed /train lines, e.g. "You step aboard the Broad Street Line. ...",
    // "The brakes bite and the train slows. Now arriving: Ellsworth-Federal Station. The doors open."
    const TRAIN_RE = /^(?:You wait for the next train|You step aboard the |You will step off at |You step off onto |The brakes bite.*Now arriving: |The chime sounds\. The doors close on )/;
    const REFUSED_RE = /^You (?:can't|cannot|can not|are moving too quickly)\b/i;

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

    function getLocationText(article) {
      const p = article.querySelector('p');
      const tagSpan = p && p.querySelector('span.text-teal-8.text-weight-bold');
      if (!tagSpan || tagSpan.textContent.trim() !== '[LOCATION]') return null;
      return (p.textContent || '').replace(/\s+/g, ' ').trim().replace(/^\[LOCATION\]\s*/, '');
    }

    const events = [];
    function push(ev) {
      if (!isActive()) return;
      ev.seq = nextSeq();
      events.push(ev);
      while (events.length > 20) events.shift();
      GM_setValue('mm_evt', { events: events.slice() });
    }

    const seen = new WeakSet();
    function processArticle(article) {
      if (seen.has(article)) return;
      seen.add(article);
      const text = getSystemText(article);
      const m = text && MOVE_RE.exec(text);
      if (m) {
        const name = m[2].trim();
        push({ kind: 'move', dir: m[1].trim(), name });
        reportRoom(name);
        return;
      }
      if (text && REFUSED_RE.test(text)) { push({ kind: 'sys', text }); return; }
      if (text && TRAIN_RE.test(text)) {
        push({ kind: 'train', text });
        const off = /^You step off onto (.+?)\.$/.exec(text);
        if (off) reportRoom(off[1]);   // a train ride ends without a "You move" line
      }
      const loc = getLocationText(article);
      const here = loc && YOU_ARE_IN_RE.exec(loc);
      if (here) reportRoom(here[1].trim());
    }

    // --- reading the side panel ---
    // Exits come from the site's own compass and .vertical-exit-btn (Compass Tools only hides the
    // latter with CSS), always via aria-label: Compass Tools' title tooltips can be stale.
    //   "Go west to John F. Kennedy Boulevard"   "Go north to Gallery Upper Offices (locked)"
    //   "Go north (aerial)" (flight exits never name their destination)   "Go up (locked)"
    const DIR_KEYS = {
      north: 'N', northeast: 'NE', east: 'E', southeast: 'SE',
      south: 'S', southwest: 'SW', west: 'W', northwest: 'NW', up: 'UP', down: 'DOWN',
    };
    const EXIT_RE = /^Go (\w+)(?: to (.+?))?(?: \((locked|aerial)\))?$/;
    const GRID_RE = /^(\w+): (.+)$/;

    function readRoom() {
      const nameEl = document.querySelector('.info-tab .room-name');
      if (!nameEl) return null;
      const name = nameEl.textContent.trim();
      // The image wrapper names its room, so an image still fading out from the last room
      // can't be mistaken for this one's.
      const wrap = document.querySelector('.room-image');
      const imgOk = !!wrap && wrap.getAttribute('aria-label') === 'Room image: ' + name;
      const img = imgOk ? wrap.querySelector('img.q-img__image') : null;
      const descEl = document.querySelector('.info-tab .room-description');
      const exits = {};
      document.querySelectorAll('.compass .compass__cell, .vertical-exits .vertical-exit-btn').forEach(el => {
        const m = EXIT_RE.exec((el.getAttribute('aria-label') || '').trim());
        const dir = m && DIR_KEYS[m[1].toLowerCase()];
        if (dir) exits[dir] = { name: m[2] ? m[2].trim() : null, locked: m[3] === 'locked', aerial: m[3] === 'aerial' };
      });
      // The mini-map shows which rooms sit next to this one on the game's grid, walkable or not.
      const grid = {};
      document.querySelectorAll('.mini-map .mini-map__cell--room').forEach(el => {
        const m = GRID_RE.exec((el.getAttribute('aria-label') || '').trim());
        const dir = m && DIR_KEYS[m[1].toLowerCase()];
        if (dir) grid[dir] = m[2].trim();
      });
      return {
        name,
        description: descEl ? descEl.textContent.trim() : '',
        image: img ? (img.getAttribute('src') || '') : '',
        imageReady: imgOk || !wrap,
        exits, grid,
      };
    }

    // The chat line and the panel update at roughly the same time, in either order: poll briefly
    // until the panel shows the room we expect. A newer move cancels an older wait.
    let roomToken = 0;
    async function reportRoom(expectName) {
      const token = ++roomToken;
      await tick(100);
      let snap = null;
      for (let i = 0; i < 30; i++) {
        if (token !== roomToken) return;
        snap = readRoom();
        if (snap && (!expectName || snap.name === expectName) && snap.imageReady) break;
        await tick(50);
      }
      if (token !== roomToken || !snap || (expectName && snap.name !== expectName)) return;
      delete snap.imageReady;
      push({ kind: 'room', room: snap });
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

    let mapperSeen = 0;   // mapper tabs ping every 5s
    GM_addValueChangeListener('mm_ping', (key, oldV, v) => {
      mapperSeen = Date.now();
      if (isActive()) GM_setValue('mm_pong', { id: v && v.id });
    });
    GM_addValueChangeListener('mm_reply', (key, oldV, v) => {
      if (isActive() && v && Array.isArray(v.lines)) localLine(v.lines);
    });

    // --- //goto: caught before the game's own Enter handler, never sent to the server ---
    const GOTO_RE = /^\/\/goto(?:\s+([\s\S]*))?$/i;
    let swallowEnter = false;
    window.addEventListener('keydown', e => {
      if (!onPlay || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      const input = e.target;
      if (!input || input.tagName !== 'TEXTAREA' || input !== findInput()) return;
      const m = GOTO_RE.exec(input.value.trim());
      if (!m) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      swallowEnter = true;
      setNativeValue(input, '');
      claim();
      if (Date.now() - mapperSeen > 15000) {
        localLine(["MUSH Mapper isn't open. Open map.stoia.red in another tab, then try again."]);
        return;
      }
      push({ kind: 'goto', q: (m[1] || '').trim() });
    }, true);
    // the same Enter's keypress/keyup must not reach the game either
    for (const type of ['keypress', 'keyup']) {
      window.addEventListener(type, e => {
        if (swallowEnter && e.key === 'Enter') {
          e.preventDefault(); e.stopImmediatePropagation();
          if (type === 'keyup') swallowEnter = false;
        }
      }, true);
    }

    // A [MAPPER] line in the chat, in this page only: the server never sees it and nobody else
    // does either. Copies the scoped-style attribute from a real message so it looks the same.
    // It goes right after the last message, not at the very end: Vue inserts new messages before
    // its own end marker, so a line appended past that marker would stay stuck at the bottom.
    function localLine(lines) {
      const container = document.querySelector(CHAT_SELECTOR);
      if (!container) return;
      const rows = container.querySelectorAll(ARTICLE_SELECTOR);
      const last = rows[rows.length - 1];
      const row = document.createElement('div');
      row.className = 'q-pa-xs chat-message-row';
      row.setAttribute('role', 'article');
      row.dataset.mmLocal = '1';
      if (last) for (const a of last.attributes) if (a.name.startsWith('data-v-')) row.setAttribute(a.name, '');
      const p = document.createElement('p');
      const tag = document.createElement('span');
      tag.className = 'text-weight-bold';
      tag.style.color = '#5b9dff';   // the mapper's own accent blue
      tag.textContent = '[MAPPER]';
      p.append(tag, ' ');
      lines.forEach((line, i) => { if (i) p.append(document.createElement('br')); p.append(line); });
      row.appendChild(p);
      seen.add(row);
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
      if (last) last.after(row); else container.appendChild(row);
      if (atBottom) container.scrollTop = container.scrollHeight;
    }
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
      reportRoom(null);   // where we are right now, so the mapper can anchor without a move
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
