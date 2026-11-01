// ==UserScript==
// @name         MUSH Mapper bridge
// @namespace    stoia.red
// @version      1.6.7
// @description  Links MUSH Mapper to the Philadelphia by Night client: the map follows your position, and routes can be walked for you.
// @match        https://map.stoia.red/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @match        https://philadelphiabynight.net/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      map.stoia.red
// @connect      localhost
// @connect      127.0.0.1
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
//   mm_cmd     {seq, cmds, char}             mapper → client: commands to type (only that character's tab)
//   mm_evt     {events:[...]}                client → mapper, newest last:
//                {seq, kind:'move', dir, name}   "You move <dir> to <name>.", sent at once
//                {seq, kind:'room', room}        what the side panel shows (see readRoom), sent
//                                                once it has caught up with the move
//                {seq, kind:'goto', q}           "//goto <q>" typed in PbN (never sent to the game)
//                {seq, kind:'sys', text}         a refused move: "You can't go that way.",
//                                                "You are moving too quickly. Slow down." and the like
//                {seq, kind:'train', text}       a /train line: waiting, aboard, stop set, arriving,
//                                                doors closing, stepped off
//                {seq, kind:'gather', text}      "/scavenge" or "/harvest" was just sent (still goes to
//                                                the game), or its result: "[You haul away 2 units of
//                                                paper stock.]", "There is nothing worth scavenging here."
//                every client event also carries char: the name the journal shows (an Obfuscate
//                mask shows the mask's name), and sess: a token per visit to /play. Switching
//                characters always leaves /play, so names seen in one visit are one character.
//   mm_reply   {seq, lines, char}            mapper → client: shown as a local [MAPPER] chat line
//   mm_relay   {code, api} | null            this browser's PbN tab feeds a mapper on ANOTHER device
//                                            through the site's relay (server/app.py), instead of a
//                                            mapper here: events go to <api>/relay/<code>/up, commands
//                                            come from .../down. Set from this browser's mapper page.
//   mm_ping / mm_pong {id, char}             is a PbN tab there, and which character is it?
//   mm_active  tab id                        only the most recently used PbN tab acts, so a second
//                                            tab (a second window, say) neither doubles commands nor reports moves
//   mm_mapper  tab id                        likewise only the most recently used mapper tab answers
//                                            //goto, so two open mappers don't both start a walk
(function () {
  'use strict';

  // read from the @version header above, so the two can't drift apart (GM_info needs no @grant)
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.6.7';
  let seqBase = 0;
  const nextSeq = () => (seqBase = Math.max(Date.now(), seqBase + 1));

  if (document.querySelector('meta[name="mush-mapper"]')) mapperRole();
  else if (location.hostname === 'philadelphiabynight.net') clientRole();

  // --------------------------------------------------------------------------
  // Mapper page
  // --------------------------------------------------------------------------

  function mapperRole() {
    const toPage = (type, data) => window.postMessage(Object.assign({ mm: 'bridge', type }, data || {}), location.origin);
    const hello = () => toPage('hello', { v: VERSION, sending: !!GM_getValue('mm_relay') });

    window.addEventListener('message', e => {
      if (e.origin !== location.origin || !e.data || e.data.mm !== 'page') return;
      const m = e.data;
      const char = typeof m.char === 'string' ? m.char : null;
      if (m.type === 'probe') hello();
      else if (m.type === 'send' && Array.isArray(m.cmds)) {
        GM_setValue('mm_cmd', { seq: nextSeq(), cmds: m.cmds.map(String).slice(0, 20), char });
      } else if (m.type === 'reply' && Array.isArray(m.lines)) {
        GM_setValue('mm_reply', { seq: nextSeq(), lines: m.lines.map(String).slice(0, 15), char });
      } else if (m.type === 'pair' && typeof m.code === 'string' && typeof m.api === 'string') {
        GM_setValue('mm_relay', { code: m.code, api: m.api });
        hello();
      } else if (m.type === 'unpair') {
        GM_setValue('mm_relay', null);
        hello();
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
        const char = ev.char || null, sess = ev.sess || null;
        if (ev.kind === 'room') toPage('room', { room: ev.room, char, sess });
        else if (ev.kind === 'goto') { if (GM_getValue('mm_mapper') === tabId) toPage('goto', { q: ev.q, char, sess }); }
        else if (ev.kind === 'sys') toPage('sys', { text: ev.text, char, sess });
        else if (ev.kind === 'train') toPage('train', { text: ev.text, char, sess });
        else if (ev.kind === 'gather') toPage('gather', { text: ev.text, char, sess });
        else toPage('move', { dir: ev.dir, name: ev.name, char, sess });
      }
    });

    GM_addValueChangeListener('mm_pong', (key, oldV, v) => toPage('client', { char: (v && v.char) || null, sess: (v && v.sess) || null }));
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
    // Confirmed: "[SYSTEM] You follow Graves north to The SchreckNET Terminal." (same groups as MOVE_RE)
    const FOLLOW_RE = /^You follow .+? (north|northeast|east|southeast|south|southwest|west|northwest|up|down) to (.+?)\.?$/;
    // On connect: "[LOCATION] You are in Le Cafe de Rien - Coffee Bar"
    const YOU_ARE_IN_RE = /^You are in (.+?)\.?$/;
    // Confirmed: "You can't go that way." / "You are moving too quickly. Slow down."
    // Confirmed /train lines, e.g. "You step aboard the Broad Street Line. ...",
    // "The brakes bite and the train slows. Now arriving: Ellsworth-Federal Station. The doors open."
    const TRAIN_RE = /^(?:You wait for the next train|You step aboard the |You will step off at |You step off onto |The brakes bite.*Now arriving: |The chime sounds\. The doors close on )/;
    // Confirmed: "[You haul away 2 units of paper stock.]", "[You gather 1 unit of ritual herbs.]",
    // "There is nothing worth scavenging here.", "There is nothing of ritual use to gather here."
    // Aloft: "There is nothing to scavenge in the open air. ...", "There is nothing to gather here but empty air. ..."
    // Nightly cap: "You have gathered all the night will give you. ..." (harvest),
    // "You have pushed your luck across the city enough for one night. ..." (scavenge)
    const GATHER_RE = /\[You (?:haul away|gather) \d+ units? of [^\]]+?\.\]|^There is nothing (?:worth scavenging|of ritual use to gather|to scavenge in the open air|to gather here but empty air)|^You have (?:gathered all the night will give you|pushed your luck across the city enough for one night)/;
    const REFUSED_RE = /^You (?:can't|cannot|can not|are moving too quickly)\b/i;

    const tabId = Math.random().toString(36).slice(2);
    let sess = null;   // token for this visit to /play (see mm_evt)
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
      ev.char = characterName();   // the mapper forgets your position when this changes...
      ev.sess = sess;              // ...unless it's still the same visit to /play (a mask)
      events.push(ev);
      while (events.length > 20) events.shift();
      GM_setValue('mm_evt', { events: events.slice() });
      if (GM_getValue('mm_relay')) { upQueue.push(ev); flushUp(); }
    }

    // --- relay to a mapper on another device (mm_relay) ---
    // Up: every event, batched. Down: polled once a second while this tab is the active PbN tab.
    // A link the mapper ended (404) is forgotten, with a note in the chat.
    const myChar = c => !c || c === characterName();
    function relayReq(method, path, body) {
      const r = GM_getValue('mm_relay');
      if (!r) return Promise.resolve(null);
      return new Promise(done => GM_xmlhttpRequest({
        method, url: r.api.replace(/\/$/, '') + '/relay/' + encodeURIComponent(r.code) + path,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        data: body ? JSON.stringify(body) : undefined,
        timeout: 8000,
        onload: x => {
          if (x.status === 404 && GM_getValue('mm_relay')) {
            GM_setValue('mm_relay', null);
            localLine(['The link to the mapper on your other device has ended.']);
            return done(null);
          }
          try { done(x.status < 300 ? JSON.parse(x.responseText) : null); } catch (e) { done(null); }
        },
        onerror: () => done(null), ontimeout: () => done(null),
      }));
    }
    let upQueue = [], upBusy = false;
    async function flushUp() {
      if (upBusy || !upQueue.length) return;
      upBusy = true;
      const batch = upQueue.slice(0, 50);
      const ok = await relayReq('POST', '/up', { items: batch });
      if (ok) upQueue = upQueue.slice(batch.length);
      else upQueue = upQueue.slice(-100);   // offline for a while: keep only the latest
      upBusy = false;
      if (ok && upQueue.length) flushUp();
    }
    let downAfter = -1, downBusy = false;
    setInterval(async () => {
      if (!onPlay || !isActive() || downBusy || !GM_getValue('mm_relay')) return;
      downBusy = true;
      const res = await relayReq('GET', '/down?after=' + downAfter);
      downBusy = false;
      if (!res) return;
      if (downAfter >= 0) for (const m of res.items || []) {
        if (m.kind === 'ping') mapperPinged();
        else if (m.kind === 'cmd' && Array.isArray(m.cmds) && myChar(m.char)) sendLines(m.cmds.map(String).slice(0, 20));
        else if (m.kind === 'reply' && Array.isArray(m.lines) && myChar(m.char)) localLine(m.lines.map(String).slice(0, 15));
      }
      downAfter = res.last;
    }, 1000);
    // tells the mapper this tab is alive and who's playing, like mm_pong does next door
    setInterval(() => {
      if (onPlay && isActive() && GM_getValue('mm_relay')) { upQueue.push({ kind: 'pong', char: characterName(), sess }); flushUp(); }
    }, 5000);

    const seen = new WeakSet();
    function processArticle(article) {
      if (seen.has(article)) return;
      seen.add(article);
      const text = getSystemText(article);
      const m = text && (MOVE_RE.exec(text) || FOLLOW_RE.exec(text));
      if (m) {
        const name = m[2].trim();
        push({ kind: 'move', dir: m[1].trim(), name });
        reportRoom(name);
        return;
      }
      if (text && REFUSED_RE.test(text)) { push({ kind: 'sys', text }); return; }
      // the haul line sits in the same message, after a <br>: "...what you need.\n[You gather 1 unit of ritual herbs.]"
      if (text && GATHER_RE.test(text)) { push({ kind: 'gather', text: text.match(GATHER_RE)[0] }); return; }
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
      // The image box cross-fades: for a moment it holds the old image (fading out) and the new one
      // (still loading), while its label already names the new room. Only once a single, loaded
      // image is left is that image this room's.
      const imgs = wrap ? [...wrap.querySelectorAll('img.q-img__image')] : [];
      const settled = imgs.length === 1 && imgs[0].classList.contains('q-img__image--loaded');
      const img = imgOk && settled ? imgs[0] : null;
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
        imageReady: !wrap || !!img,
        exits, grid,
      };
    }

    // The chat line and the panel update at roughly the same time, in either order: poll briefly
    // until the panel shows the room we expect. A newer move cancels an older wait.
    let roomToken = 0;
    // A large image can take seconds: after ~1.5s everything else is sent without it, and the
    // image follows in a second snapshot once it has loaded (up to ~8s).
    async function reportRoom(expectName) {
      const token = ++roomToken;
      await tick(100);
      let early = false;
      for (let i = 0; i < 160; i++) {
        if (token !== roomToken) return;
        const snap = readRoom();
        if (snap && (!expectName || snap.name === expectName)) {
          const ready = snap.imageReady;
          delete snap.imageReady;
          if (ready) { push({ kind: 'room', room: snap }); return; }
          if (!early && i >= 30) { early = true; push({ kind: 'room', room: { ...snap, image: '' } }); }
        }
        await tick(50);
      }
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

    // The journal sidebar is always in the page: <span class="journal-title">Vergil's Journal</span>
    function characterName() {
      const el = document.querySelector('.journal-title');
      const m = el && /^(.+?)['’]s?\s+Journal$/.exec(el.textContent.trim());
      return m ? m[1].trim() : null;
    }
    let mapperSeen = 0;   // mapper tabs ping every 5s
    // A mapper that just opened only knows where this character was last time: show it the room now.
    function mapperPinged() {
      const fresh = Date.now() - mapperSeen > 15000;
      mapperSeen = Date.now();
      if (fresh && onPlay && isActive()) reportRoom(null);
    }
    GM_addValueChangeListener('mm_ping', (key, oldV, v) => {
      mapperPinged();
      if (isActive()) GM_setValue('mm_pong', { id: v && v.id, char: characterName(), sess });
    });
    GM_addValueChangeListener('mm_reply', (key, oldV, v) => {
      if (isActive() && v && Array.isArray(v.lines) && myChar(v.char)) localLine(v.lines);
    });

    // --- //goto: caught before the game's own Enter handler, never sent to the server ---
    const GOTO_RE = /^\/\/goto(?:\s+([\s\S]*))?$/i;
    let swallowEnter = false;
    window.addEventListener('keydown', e => {
      if (!onPlay || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      const input = e.target;
      if (!input || input.tagName !== 'TEXTAREA' || input !== findInput()) return;
      // /scavenge and /harvest are only noted, not stopped: the mapper times the result from here
      const gather = /^\/(scavenge|harvest)\b/i.exec(input.value.trim());
      if (gather) { push({ kind: 'gather', text: '/' + gather[1].toLowerCase() }); return; }
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
      if (isActive() && v && Array.isArray(v.cmds) && myChar(v.char)) sendLines(v.cmds);
    });
    window.addEventListener('focus', claim);
    document.addEventListener('keydown', claim, true);
    document.addEventListener('mousedown', claim, true);
    window.addEventListener('pagehide', () => { if (isActive()) GM_setValue('mm_active', ''); });

    // --- mount on /play only (Vue Router navigates without reloads) ---
    let chatObserver = null;
    let waiter = null;

    // Only messages that arrive live may be acted on. PbN rebuilds the whole list with new
    // elements when you switch chat tabs (RP / Activity), and every old "You move" line would
    // look new. So: a tab click mutes the watcher for a moment, more than BULK messages in one go
    // is a rebuild (live chat comes a line or two at a time), and a swapped-out chat box is
    // re-attached with everything in it counted as old.
    const BULK = 3, TAB_MUTE_MS = 2000;
    let mutedUntil = 0, chatBox = null;
    document.addEventListener('click', e => {
      if (e.target.closest && e.target.closest('.chat-tab, [role="tab"]')) mutedUntil = Date.now() + TAB_MUTE_MS;
    }, true);
    function mount() {
      const container = document.querySelector(CHAT_SELECTOR);
      if (!container) return false;
      if (chatObserver) chatObserver.disconnect();
      chatBox = container;
      // lines already on screen are history, not moves happening now
      container.querySelectorAll(ARTICLE_SELECTOR).forEach(el => seen.add(el));
      chatObserver = new MutationObserver(mutations => {
        const added = [];
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.matches(ARTICLE_SELECTOR)) added.push(node);
            else node.querySelectorAll(ARTICLE_SELECTOR).forEach(a => added.push(a));
          }
        }
        const fresh = added.filter(a => !seen.has(a));
        if (Date.now() < mutedUntil || fresh.length > BULK) { fresh.forEach(a => seen.add(a)); return; }
        fresh.forEach(processArticle);
      });
      chatObserver.observe(container, { childList: true, subtree: true });
      reportRoom(null);   // where we are right now, so the mapper can anchor without a move
      return true;
    }
    // Switching characters puts you somewhere else, often without a chat line: report the new
    // character's room right away, so the mapper re-finds the position instead of guessing.
    let lastChar = null;
    setInterval(() => {
      if (!onPlay) return;
      const c = characterName();
      if (c && lastChar && c !== lastChar) reportRoom(null);
      if (c) lastChar = c;
    }, 1000);
    // PbN may also replace the chat box itself; pick the new one up (its contents count as old)
    setInterval(() => {
      if (!onPlay || !chatBox) return;
      const now = document.querySelector(CHAT_SELECTOR);
      if (now && now !== chatBox) mount();
    }, 500);

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
      sess = Math.random().toString(36).slice(2);   // a new visit: possibly another character
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
