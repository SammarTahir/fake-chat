#!/usr/bin/env node
'use strict';
/*
 * fake-chat server
 *  - serves /overlay (OBS) and /control (Chrome) plus /emotes/*
 *  - WebSocket hub on /ws (role=overlay | role=control)
 *  - ambient scheduler, persona roster, emote trains, viewer walk, join/leave
 *  - reactive layer via local Ollama (degrades to ambient-only silently)
 * Everything is tuned from config.json (hot-reloaded) or the control page.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

let WebSocketServer;
try { ({ WebSocketServer } = require('ws')); }
catch (e) {
  console.error('The "ws" package is missing. Run:  npm install');
  process.exit(1);
}
const { ensurePlaceholderEmotes } = require('./tools/gen_emotes.js');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PERSONAS_PATH = path.join(ROOT, 'personas.json');
const AMBIENT_PATH = path.join(ROOT, 'ambient.json');
const EMOTES_DIR = path.join(ROOT, 'emotes');
const PUBLIC_DIR = path.join(ROOT, 'public');

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ================================================================ config
// config.json may contain // and /* */ comments (stripped before JSON.parse).
function stripJsonComments(src) {
  let out = '', inStr = false, inLine = false, inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) { out += c; if (c === '\\') { out += n; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

const DEFAULTS = {
  port: 8080,
  chat: {
    messagesPerMinute: 40, minGapMs: 400, maxGapMs: 3000,
    emoteOnlyShare: 0.22, replyChance: 0.08,
    emoteTrainChance: 0.3, emoteTrainLength: [2, 6],
    appendEmoteChance: 0.18, typoChance: 0.06, maxWords: 8,
    reactiveEchoChance: 0.6,
  },
  joins: { eventsPerMinute: 1.5, joinerChatsChance: 0.4, joinerChatDelaySec: [4, 20] },
  viewers: {
    enabled: true, start: 47, min: 5, driftPerTick: 2, tickSec: 4,
    spikeChance: 0.04, spikeSize: [5, 25], corner: 'top-right', margin: [24, 24],
  },
  overlay: {
    width: 460, height: 1250, anchor: 'bottom-left', margin: [24, 24],
    fontSize: 26, emoteScale: 1.15, msgSpacing: 6, maxMessages: 14,
  },
  ollama: {
    url: 'http://localhost:11434', model: 'llama3.2:3b', timeoutMs: 12000,
    reactiveIntervalSec: 12, transcriptWindowSec: 15, maxPerCycle: 10,
    temperature: 0.9,
  },
  personas: { count: 60 },
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (over == null || typeof over !== 'object') return out;
  if (Array.isArray(over)) return over.slice();
  for (const k of Object.keys(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && typeof over[k] === 'object' && !Array.isArray(over[k])
      ? deepMerge(base[k], over[k])
      : (Array.isArray(over[k]) ? over[k].slice() : over[k]);
  }
  return out;
}

let cfg = deepMerge(DEFAULTS, {});
let lastSelfWrite = 0;

function serializeConfig(c) {
  return `{
  // ============================================================================
  // fake-chat config — hot-reloaded on save; safe to edit while streaming.
  // NOTE: saving settings from the control page rewrites this file (values kept,
  // custom comments regenerated).
  // ============================================================================

  // Port for the web server + websocket. Overlay: http://localhost:PORT/overlay
  "port": ${c.port},

  "chat": {
    // Ambient chat density target. The actual gap between messages is randomized
    // around 60000/messagesPerMinute, clamped to [minGapMs, maxGapMs].
    "messagesPerMinute": ${c.chat.messagesPerMinute},
    "minGapMs": ${c.chat.minGapMs},
    "maxGapMs": ${c.chat.maxGapMs},

    // Share of ambient traffic that is emote-only messages (0..1).
    "emoteOnlyShare": ${c.chat.emoteOnlyShare},
    // Chance a message is an @reply to a recent chatter (0..1).
    "replyChance": ${c.chat.replyChance},

    // When a message contains an emote: chance the next 2-6 messages from
    // different users repeat that emote ("emote train").
    "emoteTrainChance": ${c.chat.emoteTrainChance},
    "emoteTrainLength": [${c.chat.emoteTrainLength[0]}, ${c.chat.emoteTrainLength[1]}],

    // Chance a canned text line gets a random emote appended.
    "appendEmoteChance": ${c.chat.appendEmoteChance},
    // Chance a message gets a small typo injected.
    "typoChance": ${c.chat.typoChance},
    // After an LLM comment posts, chance other chatters "echo" it
    // (@mentions, repeated emotes, repeated keywords) over the next few seconds.
    "reactiveEchoChance": ${c.chat.reactiveEchoChance},
    // Hard word cap enforced on every message (LLM output included).
    "maxWords": ${c.chat.maxWords}
  },

  "joins": {
    // "X joined" / "X left" system lines per minute (approx).
    "eventsPerMinute": ${c.joins.eventsPerMinute},
    // Chance a joiner starts chatting shortly after joining.
    "joinerChatsChance": ${c.joins.joinerChatsChance},
    // Delay range (seconds) before a joiner's first message.
    "joinerChatDelaySec": [${c.joins.joinerChatDelaySec[0]}, ${c.joins.joinerChatDelaySec[1]}]
  },

  "viewers": {
    // Fake viewer counter (red dot + number on the overlay).
    "enabled": ${c.viewers.enabled},
    "start": ${c.viewers.start},
    "min": ${c.viewers.min},
    // Max +/- change per tick, and seconds between ticks.
    "driftPerTick": ${c.viewers.driftPerTick},
    "tickSec": ${c.viewers.tickSec},
    // Occasional small spikes (raid/host feel).
    "spikeChance": ${c.viewers.spikeChance},
    "spikeSize": [${c.viewers.spikeSize[0]}, ${c.viewers.spikeSize[1]}],
    // Counter position: top-left | top-right | bottom-left | bottom-right, margin [x, y] px.
    "corner": "${c.viewers.corner}",
    "margin": [${c.viewers.margin[0]}, ${c.viewers.margin[1]}]
  },

  "overlay": {
    // Chat column geometry inside the 1080x1920 canvas (the OBS browser source
    // should be full-canvas; position the column here instead of moving the source).
    "width": ${c.overlay.width},
    "height": ${c.overlay.height},
    // Column anchor corner: bottom-left | bottom-right | top-left | top-right.
    "anchor": "${c.overlay.anchor}",
    // Distance [x, y] px from the anchored edges.
    "margin": [${c.overlay.margin[0]}, ${c.overlay.margin[1]}],
    "fontSize": ${c.overlay.fontSize},
    // Emote height = fontSize * emoteScale (26 * 1.15 ≈ 30px).
    "emoteScale": ${c.overlay.emoteScale},
    "msgSpacing": ${c.overlay.msgSpacing},
    // Messages visible before the oldest fades out (also caps DOM size).
    "maxMessages": ${c.overlay.maxMessages}
  },

  "ollama": {
    "url": "${c.ollama.url}",
    // Keep this a ~3B model — it shares the GPU with NVENC.
    "model": "${c.ollama.model}",
    // Hard timeout per generation; on timeout the cycle is skipped silently.
    "timeoutMs": ${c.ollama.timeoutMs},
    // How often to send recent transcript to the LLM (seconds).
    "reactiveIntervalSec": ${c.ollama.reactiveIntervalSec},
    // How much recent transcript to include (seconds).
    "transcriptWindowSec": ${c.ollama.transcriptWindowSec},
    // Max comments kept per LLM call.
    "maxPerCycle": ${c.ollama.maxPerCycle},
    "temperature": ${c.ollama.temperature}
  },

  "personas": {
    // Roster size generated into personas.json on first run.
    "count": ${c.personas.count}
  }
}
`;
}

function loadConfig() {
  try {
    const parsed = JSON.parse(stripJsonComments(fs.readFileSync(CONFIG_PATH, 'utf8')));
    cfg = deepMerge(DEFAULTS, parsed);
  } catch (e) {
    console.warn(`[config] could not parse config.json (${e.message}) — keeping previous values`);
  }
}
function saveConfig() {
  lastSelfWrite = Date.now();
  fs.writeFileSync(CONFIG_PATH, serializeConfig(cfg));
}
if (!fs.existsSync(CONFIG_PATH)) saveConfig();
else loadConfig();

// ================================================================ personas
const PALETTE = ['#FF0000', '#0000FF', '#008000', '#B22222', '#FF7F50', '#9ACD32', '#FF4500',
  '#2E8B57', '#DAA520', '#D2691E', '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F'];
const TAGS = ['hype', 'lurker', 'questioner', 'joker', 'contrarian', 'emote_spammer', 'newbie'];
const TAG_WEIGHTS = { hype: 0.2, lurker: 0.13, questioner: 0.16, joker: 0.16, contrarian: 0.1, emote_spammer: 0.15, newbie: 0.1 };
const WORDS_A = ['shadow', 'pixel', 'toast', 'frost', 'night', 'cheese', 'mango', 'gnome', 'duck',
  'crispy', 'salty', 'cosmic', 'turbo', 'sleepy', 'spicy', 'lucky', 'grim', 'neon', 'soggy',
  'hollow', 'rusty', 'silent', 'wobbly', 'feral', 'mellow', 'static', 'gloomy', 'zesty'];
const WORDS_B = ['wolf', 'lord', 'king', 'bean', 'duck', 'gnome', 'wizard', 'goblin', 'mage',
  'weasel', 'gamer', 'byte', 'fox', 'toad', 'panda', 'raven', 'noodle', 'biscuit', 'knight',
  'pilot', 'ghost', 'squid', 'moth', 'drifter', 'walrus', 'badger'];

function makeHandle() {
  const a = pick(WORDS_A), b = pick(WORDS_B);
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const r = Math.random();
  if (r < 0.10) return `xX_${a}${b}_Xx`;
  if (r < 0.25) return `${a}${b}_ttv`;
  if (r < 0.45) return `${a}${b}${randInt(1, 999)}`;
  if (r < 0.60) return `${cap(a)}${cap(b)}`;
  if (r < 0.72) return `${a}_${b}`;
  if (r < 0.85) return `${a}${b}`;
  if (r < 0.93) return a;
  return `${cap(a)}${cap(b)}${randInt(1, 99)}`;
}
function weightedTag() {
  let r = Math.random(), acc = 0;
  for (const t of TAGS) { acc += TAG_WEIGHTS[t]; if (r < acc) return t; }
  return 'hype';
}
function generatePersonas(n) {
  const used = new Set();
  const list = [];
  for (let i = 0; i < n; i++) {
    let name;
    do { name = makeHandle(); } while (used.has(name.toLowerCase()));
    used.add(name.toLowerCase());
    const badges = [];
    if (chance(0.15)) badges.push('sub' + (chance(0.8) ? 1 : chance(0.75) ? 2 : 3));
    if (!badges.length && chance(0.2)) badges.push('prime');
    list.push({
      name,
      color: pick(PALETTE),
      badges,
      tag: weightedTag(),
      // long-tail chattiness: a few heavy hitters, many rare posters
      weight: +Math.pow(Math.random(), 2.4).toFixed(4) + 0.01,
    });
  }
  // exactly one mod, one broadcaster, a few VIPs
  list[0].badges = ['mod'];
  list[0].weight = Math.max(list[0].weight, 0.5);
  list[1].badges = ['broadcaster'];
  list[1].weight = 0.02; // broadcaster rarely types
  for (let i = 2; i < Math.min(5, n); i++) if (chance(0.7)) list[i].badges = ['vip', ...list[i].badges.filter((b) => b.startsWith('sub'))];
  return list;
}
let personas;
if (fs.existsSync(PERSONAS_PATH)) {
  try { personas = JSON.parse(fs.readFileSync(PERSONAS_PATH, 'utf8')); }
  catch (e) { console.warn('[personas] personas.json unreadable, regenerating'); }
}
if (!Array.isArray(personas) || personas.length === 0) {
  personas = generatePersonas(cfg.personas.count);
  fs.writeFileSync(PERSONAS_PATH, JSON.stringify(personas, null, 2));
  console.log(`[personas] generated ${personas.length} personas -> personas.json`);
}
function pickPersona(excludeNames) {
  const pool = excludeNames ? personas.filter((p) => !excludeNames.has(p.name)) : personas;
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of pool) { r -= p.weight; if (r <= 0) return p; }
  return pool[pool.length - 1] || personas[0];
}
function personaByName(name) { return personas.find((p) => p.name === name); }

// ================================================================ ambient pool
let ambient = { generic: ['lol'], replies: ['@{u} lol'] };
function loadAmbient() {
  try { ambient = JSON.parse(fs.readFileSync(AMBIENT_PATH, 'utf8')); }
  catch (e) { console.warn('[ambient] could not parse ambient.json:', e.message); }
}
loadAmbient();

// ================================================================ emotes
let emotes = new Map(); // name -> filename
function scanEmotes() {
  emotes = new Map();
  try {
    for (const f of fs.readdirSync(EMOTES_DIR)) {
      const m = /^(.+)\.(png|gif|webp)$/i.exec(f);
      if (m) emotes.set(m[1], f);
    }
  } catch (e) { /* folder missing — ensurePlaceholderEmotes creates it */ }
}
const writtenEmotes = ensurePlaceholderEmotes(EMOTES_DIR);
if (writtenEmotes.length) console.log(`[emotes] wrote ${writtenEmotes.length} placeholder emotes`);
scanEmotes();
console.log(`[emotes] ${emotes.size} emotes loaded: ${[...emotes.keys()].join(' ')}`);

const emoteNames = () => [...emotes.keys()];
function emotesMatching(re) {
  const hit = emoteNames().filter((n) => re.test(n));
  return hit.length ? hit : emoteNames();
}
const hypeEmotes = () => emotesMatching(/pog|hype|party|jam|dance|ez|wicked|fire|clap/i);
const laughEmotes = () => emotesMatching(/kek|lul|laugh|lol|icant|omega/i);

// text -> parts array; whitespace-delimited tokens matching emote names (case-sensitive) become images
function buildParts(text) {
  const parts = [];
  for (const tok of String(text).split(/(\s+)/)) {
    if (emotes.has(tok)) parts.push({ t: 'e', n: tok, u: '/emotes/' + emotes.get(tok) });
    else if (/^@\w[\w-]*$/.test(tok)) parts.push({ t: 'm', v: tok });
    else if (tok.length) parts.push({ t: 't', v: tok });
  }
  // merge adjacent text parts
  const merged = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (p.t === 't' && last && last.t === 't') last.v += p.v;
    else merged.push({ ...p });
  }
  return merged;
}

// ================================================================ websocket hub
const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ server, path: '/ws' });
const overlays = new Set();
const controls = new Set();

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } }
function toOverlays(obj) { const s = JSON.stringify(obj); for (const ws of overlays) { try { ws.send(s); } catch (e) {} } }
function toControls(obj) { const s = JSON.stringify(obj); for (const ws of controls) { try { ws.send(s); } catch (e) {} } }

function overlayInit() {
  return {
    type: 'init',
    overlay: {
      ...cfg.overlay,
      showViewers: cfg.viewers.enabled,
      viewerCorner: cfg.viewers.corner,
      viewerMargin: cfg.viewers.margin,
    },
    viewers: state.viewers,
  };
}
function controlInit() {
  return {
    type: 'init',
    config: cfg,
    personas: personas.map((p) => ({ name: p.name, color: p.color, tag: p.tag, badges: p.badges })),
    emotes: emoteNames(),
    status: { ollama: state.ollama, model: cfg.ollama.model, viewers: state.viewers },
  };
}

wss.on('connection', (ws, req) => {
  const role = /role=control/.test(req.url || '') ? 'control' : 'overlay';
  (role === 'control' ? controls : overlays).add(ws);
  send(ws, role === 'control' ? controlInit() : overlayInit());
  ws.on('close', () => { overlays.delete(ws); controls.delete(ws); });
  ws.on('error', () => {});
  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (role !== 'control') return;
    handleControlMsg(m);
  });
});

function handleControlMsg(m) {
  switch (m.type) {
    case 'transcript':
      if (typeof m.text === 'string' && m.text.trim()) {
        state.transcript.push({ t: Date.now(), text: m.text.trim() });
        if (state.transcript.length > 200) state.transcript.splice(0, 100);
      }
      break;
    case 'trigger': runTrigger(m.kind); break;
    case 'inject': {
      const p = personaByName(m.name) || pickPersona();
      if (typeof m.text === 'string' && m.text.trim()) sendChat(p, m.text.trim(), { skipMutate: true });
      break;
    }
    case 'panic':
      toOverlays({ type: 'clear' });
      state.reactiveQueue.length = 0;
      state.train = null;
      break;
    case 'set': {
      cfg = deepMerge(cfg, m.patch || {});
      if (m.patch && m.patch.viewers && typeof m.patch.viewers.start === 'number') {
        state.viewers = m.patch.viewers.start;
        toOverlays({ type: 'viewers', n: state.viewers });
      }
      saveConfig();
      applyRuntimeConfig();
      break;
    }
  }
}

// ================================================================ state
const state = {
  viewers: cfg.viewers.start,
  transcript: [],           // [{t, text}]
  reactiveQueue: [],        // strings from the LLM, dripped into ambient slots
  recentLLM: [],            // dedupe window
  train: null,              // {emote, remaining, used:Set}
  lastChatters: [],         // recent authors for @replies
  online: [],               // names that "joined" (for leave events)
  slowUntil: 0,
  ollama: 'unknown',        // ready | missing | down
  llmBusy: false,
};

// ================================================================ message factory
function mutateText(text) {
  if (!chance(cfg.chat.typoChance)) return text;
  // typo one word — never an emote name or @mention (would break rendering)
  const toks = String(text).split(' ');
  const idxs = toks.map((t, i) => (t.length > 3 && !emotes.has(t) && !t.startsWith('@')) ? i : -1).filter((i) => i >= 0);
  if (!idxs.length) return text;
  const i = pick(idxs);
  const w = toks[i], j = randInt(1, w.length - 3);
  toks[i] = chance(0.5) ? w.slice(0, j) + w[j + 1] + w[j] + w.slice(j + 2)  // swap
                        : w.slice(0, j) + w.slice(j + 1);                   // drop
  return toks.join(' ');
}
function capWords(text) {
  const words = String(text).trim().split(/\s+/);
  return words.slice(0, cfg.chat.maxWords).join(' ');
}
let msgSeq = 0;
function sendChat(p, text, opts = {}) {
  let t = capWords(text);
  if (!opts.skipMutate) t = mutateText(t);
  const parts = buildParts(t);
  if (!parts.length) return;
  const msg = {
    type: 'chat', id: 'm' + (++msgSeq),
    name: p.name, color: p.color, badges: p.badges, parts,
  };
  toOverlays(msg);
  toControls({ ...msg, type: 'feed' });
  state.lastChatters.push(p.name);
  if (state.lastChatters.length > 12) state.lastChatters.shift();
  // maybe start an emote train off any emote in this message
  const em = parts.find((x) => x.t === 'e');
  if (em && !state.train && !opts.noTrain && chance(cfg.chat.emoteTrainChance)) {
    const [lo, hi] = cfg.chat.emoteTrainLength;
    state.train = { emote: em.n, remaining: randInt(lo, hi), used: new Set([p.name]) };
  }
}
function sendSystem(text) {
  toOverlays({ type: 'system', text });
  toControls({ type: 'feed_sys', text });
}

function emoteOnlyText(pool) {
  const list = pool && pool.length ? pool : emoteNames();
  if (!list.length) return 'lol';
  const e = pick(list);
  const reps = chance(0.55) ? 1 : randInt(2, 4);
  if (reps === 1 && chance(0.35)) {
    const others = list.filter((x) => x !== e);
    const combo = [e];
    for (let i = 0; i < randInt(1, 3) && others.length; i++) combo.push(pick(others));
    return combo.join(' ');
  }
  return Array(reps).fill(e).join(' ');
}
function cannedFor(p) {
  const pools = [];
  const tagPool = ambient[p.tag];
  if (Array.isArray(tagPool) && tagPool.length && chance(0.55)) pools.push(tagPool);
  pools.push(ambient.generic || ['lol']);
  return pick(pick(pools));
}

// ================================================================ ambient scheduler
function nextGap() {
  const base = 60000 / Math.max(1, cfg.chat.messagesPerMinute);
  let gap = base * rand(0.35, 1.8);
  if (Date.now() < state.slowUntil) gap *= 3;
  return clamp(gap, cfg.chat.minGapMs, Math.max(cfg.chat.maxGapMs, base * 2));
}
function ambientTick() {
  try { produceMessage(); } catch (e) { console.warn('[ambient]', e.message); }
  setTimeout(ambientTick, nextGap());
}
function produceMessage() {
  if (overlays.size === 0 && controls.size === 0) return; // nobody watching
  // 1. emote train in progress
  if (state.train) {
    const tr = state.train;
    if (tr.remaining > 0 && chance(0.85)) {
      const p = pickPersona(tr.used);
      tr.used.add(p.name);
      tr.remaining--;
      const reps = randInt(1, 3);
      sendChat(p, Array(reps).fill(tr.emote).join(' '), { noTrain: true });
      if (tr.remaining <= 0) state.train = null;
      return;
    }
    if (tr.remaining <= 0) state.train = null;
  }
  // 2. ambient
  const p = pickPersona();
  const r = Math.random();
  if (p.tag === 'emote_spammer' && chance(0.6)) return sendChat(p, emoteOnlyText());
  if (r < cfg.chat.emoteOnlyShare) return sendChat(p, emoteOnlyText());
  if (r < cfg.chat.emoteOnlyShare + cfg.chat.replyChance && state.lastChatters.length) {
    const target = pick(state.lastChatters.filter((n) => n !== p.name));
    if (target) return sendChat(p, pick(ambient.replies || ['@{u} lol']).replace('{u}', target));
  }
  let line = cannedFor(p);
  if (chance(cfg.chat.appendEmoteChance) && emotes.size) line += ' ' + pick(emoteNames());
  sendChat(p, line);
}

// reactive (LLM) messages drip on their own clock, independent of ambient
// density — lowering messagesPerMinute never throttles AI comments.
function reactiveDripTick() {
  try {
    if (state.reactiveQueue.length && (overlays.size || controls.size)) {
      const text = state.reactiveQueue.shift();
      const p = pickPersona();
      sendChat(p, text);
      if (chance(cfg.chat.reactiveEchoChance)) scheduleEchoes(p, text);
    }
  } catch (e) { /* keep scheduling */ }
  // drain faster when the queue is deep, breathe when it's shallow
  const gap = state.reactiveQueue.length > 8 ? rand(800, 1800) : rand(1400, 3600);
  setTimeout(reactiveDripTick, gap);
}

// other chatters pile on after an LLM comment: @mentions, repeated emotes,
// repeated keywords — real chat echoes itself constantly
function scheduleEchoes(srcPersona, text) {
  const toks = String(text).split(/\s+/);
  const words = toks.filter((w) => /^[a-zA-Z']{4,}$/.test(w) && !emotes.has(w));
  const emoteToks = toks.filter((w) => emotes.has(w));
  const used = new Set([srcPersona.name]);
  let delay = 0;
  for (let i = 0, n = randInt(1, 3); i < n; i++) {
    delay += rand(1200, 4200);
    setTimeout(() => {
      const p = pickPersona(used);
      used.add(p.name);
      const r = Math.random();
      let line;
      if (r < 0.35) line = '@' + srcPersona.name + ' ' + pick(['real', 'fr', 'lmao', 'true', 'W', 'this', 'facts']);
      else if (r < 0.6 && emoteToks.length) line = Array(randInt(1, 3)).fill(pick(emoteToks)).join(' ');
      else if (words.length) line = (pick(words).toLowerCase() + ' ' + pick(['lol', 'fr', 'tho', ''])).trim();
      else line = pick(['fr', 'real', 'lol', 'true', 'same']);
      sendChat(p, line, { noTrain: true });
    }, delay);
  }
}

// ================================================================ join / leave
function joinTick() {
  try {
    if (overlays.size || controls.size) {
      if (chance(0.6)) {
        // join — roster persona or one-off name
        const name = chance(0.6) ? pickPersona().name : makeHandle();
        sendSystem(`${name} joined`);
        state.online.push(name);
        if (state.online.length > 40) state.online.shift();
        const p = personaByName(name);
        if (p && chance(cfg.joins.joinerChatsChance)) {
          const [lo, hi] = cfg.joins.joinerChatDelaySec;
          setTimeout(() => {
            const greet = chance(0.5) ? pick(['hi chat', 'yo', 'sup', 'just got here what i miss', 'hello', 'im here']) : cannedFor(p);
            sendChat(p, greet);
          }, rand(lo, hi) * 1000);
        }
      } else if (state.online.length) {
        const i = randInt(0, state.online.length - 1);
        sendSystem(`${state.online.splice(i, 1)[0]} left`);
      }
    }
  } catch (e) { /* keep scheduling */ }
  const base = 60000 / Math.max(0.1, cfg.joins.eventsPerMinute);
  setTimeout(joinTick, base * rand(0.4, 1.8));
}

// ================================================================ viewers
let viewerTimer = null;
function startViewerTimer() {
  if (viewerTimer) clearInterval(viewerTimer);
  viewerTimer = setInterval(() => {
    if (!cfg.viewers.enabled) return;
    const v = cfg.viewers;
    let n = state.viewers + randInt(-v.driftPerTick, v.driftPerTick);
    // gentle mean reversion toward the configured start value so the count
    // wanders but never bleeds out or runs away
    if (chance(0.35)) n += Math.sign(v.start - n);
    if (chance(v.spikeChance)) n += randInt(v.spikeSize[0], v.spikeSize[1]) * (chance(0.7) ? 1 : -1);
    state.viewers = Math.max(v.min, n);
    toOverlays({ type: 'viewers', n: state.viewers });
    toControls({ type: 'viewers', n: state.viewers });
  }, Math.max(1, cfg.viewers.tickSec) * 1000);
}

// ================================================================ triggers
function stagger(items, gapLo, gapHi, fn) {
  let t = 0;
  for (const item of items) {
    t += rand(gapLo, gapHi);
    setTimeout(() => fn(item), t);
  }
}
function runTrigger(kind) {
  const used = new Set();
  const freshPersona = () => { const p = pickPersona(used); used.add(p.name); return p; };
  switch (kind) {
    case 'hype':
      stagger(Array(randInt(7, 10)).fill(0), 180, 650, () => {
        const p = freshPersona();
        sendChat(p, chance(0.45) ? emoteOnlyText(hypeEmotes()) : pick(ambient.hype || ['LETS GOOO']));
      });
      break;
    case 'questions':
      stagger(Array(randInt(3, 5)).fill(0), 900, 2200, () => {
        sendChat(freshPersona(), pick(ambient.questioner || ['what game is this']));
      });
      break;
    case 'laugh':
      stagger(Array(randInt(6, 9)).fill(0), 150, 600, () => {
        const p = freshPersona();
        sendChat(p, chance(0.6) ? emoteOnlyText(laughEmotes()) : pick(['LMAOOO', 'IM CRYING', 'lmaooo', 'im dead', 'HELP', 'NOO WAY', 'icant', 'BAHAHA']));
      });
      break;
    case 'emote_spam':
      stagger(Array(randInt(8, 12)).fill(0), 120, 500, () => {
        sendChat(freshPersona(), emoteOnlyText(), { noTrain: true });
      });
      break;
    case 'slow':
      state.slowUntil = Date.now() + 30000;
      break;
  }
}

// ================================================================ Ollama reactive layer
async function checkOllama() {
  try {
    const res = await fetch(cfg.ollama.url + '/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    const want = cfg.ollama.model;
    const ok = models.some((n) => n === want || n === want + ':latest' || n.split(':')[0] === want.split(':')[0]);
    const prev = state.ollama;
    state.ollama = ok ? 'ready' : 'missing';
    if (state.ollama !== prev) {
      if (state.ollama === 'missing') {
        console.log(`[ollama] model "${want}" is not pulled. Run:\n\n    ollama pull ${want}\n\n  Running in ambient-only mode until then.`);
      } else {
        console.log(`[ollama] model "${want}" ready — reactive layer enabled`);
        warmModel(); // preload into VRAM so real cycles fit inside timeoutMs
      }
      toControls({ type: 'status', ollama: state.ollama, model: cfg.ollama.model });
    }
  } catch (e) {
    if (state.ollama !== 'down') {
      console.log('[ollama] not reachable at ' + cfg.ollama.url + ' — ambient-only mode');
      toControls({ type: 'status', ollama: 'down', model: cfg.ollama.model });
    }
    state.ollama = 'down';
  }
}

async function warmModel() {
  try {
    await fetch(cfg.ollama.url + '/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model: cfg.ollama.model, prompt: '', keep_alive: '30m' }),
    });
    console.log('[ollama] model warmed');
  } catch (e) { /* warm-up is best-effort */ }
}

function llmSystemPrompt() {
  const names = emoteNames().join(', ');
  return `You write fake Twitch chat messages reacting to what a streamer just said out loud.
Return ONLY a JSON array of 10 to 14 strings. No other text, no markdown.
Rules for every message:
- max 8 words, most should be under 5
- casual twitch chat slang, mostly lowercase, sloppy punctuation is good
- never formal, never full grammatical sentences, never assistant-speak
- no hashtags, no emoji, no markdown
- react specifically to what was said when possible
- you may use these emote codes as standalone words (case sensitive): ${names}
Example output: ["no way he said that","KEKW","actually cooking rn","wait fr?","W take"]`;
}

function salvageLLM(content) {
  let items = null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  let v = tryParse(content);
  if (!v) {
    const stripped = content.replace(/```(?:json)?/gi, '').trim();
    v = tryParse(stripped);
    if (!v) {
      const m = stripped.match(/\[[\s\S]*\]/);
      if (m) v = tryParse(m[0]);
    }
  }
  if (Array.isArray(v)) items = v;
  else if (v && typeof v === 'object') {
    // models return every shape: {"messages":[...]}, {"msg":"..."}, or even
    // the messages as KEYS ({"no way": [[5]], "LOLL": [[5]]}) — take whichever
    // part actually contains chat-looking strings
    const arr = Object.values(v).find((x) => Array.isArray(x) && x.some((s) => typeof s === 'string' && s.length > 1));
    if (arr) items = arr;
    else {
      const strVals = Object.values(v).filter((x) => typeof x === 'string' && x.length > 1);
      const keys = Object.keys(v).filter((k) => k.length > 1 && !/^(message|msg|response|output|comment)s?$/i.test(k));
      items = strVals.length >= keys.length ? strVals : keys;
    }
  }
  if (!items) {
    // last resort: quoted strings or short lines
    const quoted = [...content.matchAll(/"([^"\n]{1,60})"/g)].map((m) => m[1]);
    items = quoted.length ? quoted : content.split('\n');
  }
  const out = [];
  for (let raw of items) {
    if (typeof raw !== 'string') continue;
    let s = raw.replace(/[*_`#>\[\]]/g, '').replace(/\s+/g, ' ').trim();
    s = s.replace(/[\s\-–—]+$/, '').replace(/([.!?]){2,}$/, '$1'); // trailing dash/punct junk
    if (!s || s.length > 70) continue;
    if (/as an ai|i cannot|great point|here (are|is)|json|assistant|keep at it|good luck|you got this|proud of you/i.test(s)) continue;
    if (s.split(',').length > 2) continue; // comma-listing = assistant voice, not chat
    // de-formalize: "Nice play there." -> "nice play there"
    if (/^[A-Z][a-z]/.test(s) && !emotes.has(s.split(' ')[0])) s = s[0].toLowerCase() + s.slice(1);
    s = s.replace(/[.]+$/, '');
    s = capWords(s);
    const key = s.toLowerCase();
    if (state.recentLLM.includes(key)) continue;
    out.push(s);
  }
  return out;
}

// each cycle fires two staggered generations for volume; the second lands
// half an interval later with whatever transcript is freshest by then
function reactiveCycle() {
  llmCallOnce();
  setTimeout(llmCallOnce, Math.max(2, cfg.ollama.reactiveIntervalSec / 2) * 1000);
}
async function llmCallOnce() {
  if (state.llmBusy || state.ollama !== 'ready') return;
  const windowMs = cfg.ollama.transcriptWindowSec * 1000;
  const now = Date.now();
  const recent = state.transcript.filter((x) => now - x.t < windowMs).map((x) => x.text).join(' ').trim();
  if (recent.length < 10) return;
  state.llmBusy = true;
  try {
    const res = await fetch(cfg.ollama.url + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(cfg.ollama.timeoutMs),
      body: JSON.stringify({
        model: cfg.ollama.model,
        stream: false,
        format: 'json',
        keep_alive: '30m',
        options: { temperature: cfg.ollama.temperature, num_predict: 512 },
        messages: [
          { role: 'system', content: llmSystemPrompt() },
          { role: 'user', content: `The streamer just said: "${recent.slice(-500)}"` },
        ],
      }),
    });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    const content = (data.message && data.message.content) || '';
    const msgs = salvageLLM(content).slice(0, cfg.ollama.maxPerCycle);
    console.log(`[llm] ${Math.round((data.total_duration || 0) / 1e6)}ms, kept ${msgs.length}, queue ${state.reactiveQueue.length + msgs.length}` +
      (msgs.length < 3 ? ` | raw: ${content.slice(0, 160).replace(/\n/g, ' ')}` : ''));
    for (const s of msgs) {
      state.recentLLM.push(s.toLowerCase());
      if (state.recentLLM.length > 40) state.recentLLM.shift();
      if (state.reactiveQueue.length < 30) state.reactiveQueue.push(s);
    }
    if (msgs.length) toControls({ type: 'llm', queued: state.reactiveQueue.length, added: msgs });
  } catch (e) {
    // timeout / error: skip silently, recheck availability soon
    if (!/abort|timeout/i.test(String(e))) checkOllama();
  } finally {
    state.llmBusy = false;
  }
}
let reactiveTimer = null;
function startReactiveTimer() {
  if (reactiveTimer) clearInterval(reactiveTimer);
  reactiveTimer = setInterval(reactiveCycle, Math.max(3, cfg.ollama.reactiveIntervalSec) * 1000);
}

// ================================================================ config hot reload
function applyRuntimeConfig() {
  startViewerTimer();
  startReactiveTimer();
  toOverlays(overlayInit());
  toControls({ type: 'config', config: cfg });
}
fs.watchFile(CONFIG_PATH, { interval: 700 }, () => {
  if (Date.now() - lastSelfWrite < 1500) return;
  console.log('[config] config.json changed — reloading');
  loadConfig();
  applyRuntimeConfig();
});
fs.watchFile(AMBIENT_PATH, { interval: 2000 }, () => { loadAmbient(); console.log('[ambient] reloaded'); });
let emoteRescan = null;
try {
  fs.watch(EMOTES_DIR, () => {
    clearTimeout(emoteRescan);
    emoteRescan = setTimeout(() => {
      scanEmotes();
      console.log(`[emotes] rescanned: ${emotes.size} emotes`);
      toControls({ type: 'emotes', emotes: emoteNames() });
    }, 500);
  });
} catch (e) { /* fs.watch can be flaky; startup scan already done */ }

// ================================================================ http
const MIME = {
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.json': 'application/json', '.js': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml',
};
function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}
function handleHttp(req, res) {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/' || url === '/overlay') return serveFile(res, path.join(PUBLIC_DIR, 'overlay.html'));
  if (url === '/control') return serveFile(res, path.join(PUBLIC_DIR, 'control.html'));
  if (url.startsWith('/emotes/')) {
    const name = path.basename(url); // no traversal
    return serveFile(res, path.join(EMOTES_DIR, name));
  }
  res.writeHead(404); res.end('not found');
}

// ================================================================ start
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${cfg.port} is already in use. Is another copy of the server running?\nChange "port" in config.json or stop the other process.`);
    process.exit(1);
  }
  throw e;
});
server.listen(cfg.port, () => {
  console.log('');
  console.log('  fake-chat running');
  console.log(`  overlay (OBS browser source): http://localhost:${cfg.port}/overlay`);
  console.log(`  control (Chrome, 2nd monitor): http://localhost:${cfg.port}/control`);
  console.log(`  overlay demo (styling check):  http://localhost:${cfg.port}/overlay?demo`);
  console.log('');
  startViewerTimer();
  startReactiveTimer();
  ambientTick();
  reactiveDripTick();
  joinTick();
  checkOllama();
  setInterval(checkOllama, 60000);
});
