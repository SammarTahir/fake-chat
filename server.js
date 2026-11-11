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
const { spawn } = require('child_process');

// --app: launched by the desktop app (FakeChat.vbs). Chat starts paused until
// the user clicks Start, and the server exits by itself once the app window
// has been closed, so no hidden process is ever left running.
const APP_MODE = process.argv.includes('--app');

let WebSocketServer;
try { ({ WebSocketServer } = require('ws')); }
catch (e) {
  console.error('The "ws" package is missing. Run:  npm install');
  process.exit(1);
}
const { ensurePlaceholderEmotes } = require('./tools/gen_emotes.js');
const { searchBTTV, downloadEmote } = require('./tools/fetch_emotes.js');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PERSONAS_PATH = path.join(ROOT, 'personas.json');
const AMBIENT_PATH = path.join(ROOT, 'ambient.json');
const GAMES_PATH = path.join(ROOT, 'games.json');
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
    onlyWhenTalking: false, quietAfterSec: 20,
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
    url: 'http://localhost:11434', model: 'gemma3:4b', timeoutMs: 12000,
    reactiveIntervalSec: 12, transcriptWindowSec: 15, maxPerCycle: 10,
    temperature: 0.9,
  },
  personas: { count: 60 },
  stream: { game: '', notes: '' },
  emotes: { disabled: [] },
  compliments: { share: 0, identity: '' },
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
    // true = chat only moves while you are talking: background messages and
    // join/leave lines stop quietAfterSec seconds after you last spoke, and
    // start again when you speak. AI reactions are unaffected.
    "onlyWhenTalking": ${c.chat.onlyWhenTalking},
    "quietAfterSec": ${c.chat.quietAfterSec},
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
    // Keep this a small (3-4B) model — it shares the GPU with OBS/NVENC.
    // gemma3:4b gave the most reliable batches in testing; thinking models
    // (e.g. qwen3.5) work too since reasoning is switched off per request.
    "model": "${c.ollama.model}",
    // Hard timeout per generation; on timeout the cycle is skipped silently.
    "timeoutMs": ${c.ollama.timeoutMs},
    // The AI reacts right after you finish a sentence; this is the minimum gap
    // between AI batches (seconds). Higher = less GPU use. Nothing you say is
    // dropped — speech during the gap goes into the next batch.
    "reactiveIntervalSec": ${c.ollama.reactiveIntervalSec},
    // When a new line is very short ("no way"), how far back to include
    // earlier speech as context (seconds).
    "transcriptWindowSec": ${c.ollama.transcriptWindowSec},
    // Max comments kept per LLM call.
    "maxPerCycle": ${c.ollama.maxPerCycle},
    "temperature": ${c.ollama.temperature}
  },

  "personas": {
    // Roster size generated into personas.json on first run.
    "count": ${c.personas.count}
  },

  "stream": {
    // What you're playing, typed however you like ("fc 27", "mw4", "cod").
    // Matching a pack in games.json loads that game's knowledge for the AI.
    "game": ${JSON.stringify(c.stream.game)},
    // Anything the AI should know right now, e.g. "Rivals div 3, team has Mbappe".
    "notes": ${JSON.stringify(c.stream.notes)}
  },

  "emotes": {
    // Emotes switched off in the app (chat and the AI never use these).
    // Game-specific emotes are listed per game in games.json.
    "disabled": ${JSON.stringify(c.emotes.disabled || [])}
  },

  "compliments": {
    // Share of background messages that compliment you (0 = off, 0.15 = a
    // steady trickle). The AI also slips a couple into its reactions.
    // Lines live in ambient.json -> "compliments".
    "share": ${c.compliments.share},
    // Fills "favourite ___ streamer" lines, e.g. "Pakistani". Empty = skip those.
    "identity": ${JSON.stringify(c.compliments.identity || '')}
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

// ================================================================ game packs
// games.json: per-game knowledge for the AI prompt plus game-flavoured
// background lines. The new titles came out after the model's training data,
// so without a pack it has no idea what "The Grounds" or "Reactor J92" are.
let gamePacks = { reactionEmotes: [], games: {} };
function loadGames() {
  try { gamePacks = JSON.parse(fs.readFileSync(GAMES_PATH, 'utf8')); }
  catch (e) { console.warn('[games] could not parse games.json:', e.message); }
}
loadGames();

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// match what the streamer typed ("fc 27", "MW4", "call of duty") to a pack;
// unknown games still get their name passed to the AI via the general pack
function activeGame() {
  const typed = norm(cfg.stream.game);
  const games = gamePacks.games || {};
  for (const [key, g] of Object.entries(games)) {
    const names = [key, g.name, ...(g.aliases || [])].map(norm);
    if (names.includes(typed)) return { key, ...g, known: true };
  }
  const general = games.general || { name: 'Just Chatting', context: '', terms: [], chatLines: [] };
  return typed
    ? { key: null, ...general, name: cfg.stream.game.trim(), context: `The streamer is playing ${cfg.stream.game.trim()}.`, known: false }
    : { key: 'general', ...general, known: false };
}
function gameSummary() {
  const g = activeGame();
  return { typed: cfg.stream.game, name: g.name, known: g.known, key: g.key };
}
// ---------------------------------------------------------------- emote manager
let lastGamesWrite = 0;
function saveGames() {
  lastGamesWrite = Date.now();
  fs.writeFileSync(GAMES_PATH, JSON.stringify(gamePacks, null, 2) + '\n');
}
function emoteState() {
  const g = activeGame();
  const off = disabledEmotes();
  const mine = new Set(g.emotes || []);
  return {
    type: 'emoteState',
    list: emoteNames()
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map((n) => ({ name: n, url: '/emotes/' + encodeURIComponent(emotes.get(n)), on: !off.has(n), game: mine.has(n) })),
    // an unrecognised typed game has no pack to save emotes into
    game: { key: g.key, name: g.name, taggable: !!g.key, search: g.emoteSearch || [] },
  };
}
function setEmoteEnabled(name, on) {
  if (!emotes.has(name)) return;
  const off = disabledEmotes();
  if (on) off.delete(name); else off.add(name);
  cfg.emotes.disabled = [...off].sort();
  saveConfig();
  toControls(emoteState());
}
function setEmoteForGame(name, on) {
  const key = activeGame().key;
  const pack = key && gamePacks.games[key];
  if (!pack || !emotes.has(name)) return;
  const list = new Set(pack.emotes || []);
  if (on) list.add(name); else list.delete(name);
  pack.emotes = [...list];
  saveGames();
  toControls(emoteState());
}
async function bttvSearch(ws, query) {
  if (!query) return;
  try {
    const have = new Set(emoteNames().map((n) => n.toLowerCase()));
    const results = (await searchBTTV(query, 36)).map((r) => ({ ...r, have: have.has(r.code.toLowerCase()) }));
    send(ws, { type: 'bttvResults', query, results });
  } catch (e) {
    send(ws, { type: 'bttvResults', query, results: [], error: 'Could not reach BetterTTV. Check your internet connection.' });
  }
}
async function addEmote(ws, m) {
  try {
    const { code } = await downloadEmote(String(m.id), String(m.code), EMOTES_DIR);
    scanEmotes();
    console.log('[emotes] added ' + code);
    if (m.forGame) setEmoteForGame(code, true);
    else toControls(emoteState());
    send(ws, { type: 'emoteAdded', id: m.id, code, ok: true });
  } catch (e) {
    send(ws, { type: 'emoteAdded', id: m.id, code: m.code, ok: false, error: e.message });
  }
}

function gameList() {
  return Object.entries(gamePacks.games || {})
    .filter(([key]) => key !== 'general')
    .map(([key, g]) => ({ key, name: g.name }));
}

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
// Emotes switched off in the app are never picked by chat or the AI (they
// still render if you type one yourself). The active game's emotes are
// favoured, so a football stream gets GOAL and SIUUU, not only KEKW.
const disabledEmotes = () => new Set(cfg.emotes.disabled || []);
const usableEmotes = () => {
  const off = disabledEmotes();
  // emotes starred only for other games stay out (no SNIPER in a football stream)
  const mine = new Set(activeGame().emotes || []);
  for (const g of Object.values(gamePacks.games || {})) for (const n of g.emotes || []) if (!mine.has(n)) off.add(n);
  return emoteNames().filter((n) => !off.has(n));
};
function gameEmotes() {
  const off = disabledEmotes();
  return (activeGame().emotes || []).filter((n) => emotes.has(n) && !off.has(n));
}
function emotePool() {
  const g = gameEmotes();
  return g.length && chance(0.45) ? g : usableEmotes();
}
function emotesMatching(re) {
  const all = usableEmotes();
  const hit = all.filter((n) => re.test(n));
  return hit.length ? hit : all;
}
const hypeEmotes = () => [...gameEmotes(), ...emotesMatching(/pog|hype|party|jam|dance|ez|wicked|fire|clap/i)];
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
// when the last control page disconnected (0 = one is connected); app mode
// exits after a grace period with no window, see the idle watcher at startup
let appIdleSince = Date.now();

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
    emoteState: emoteState(),
    models: state.models,
    games: gameList(),
    game: gameSummary(),
    running: state.running,
    appMode: APP_MODE,
    port: cfg.port,
    overlays: overlays.size,
    status: { ollama: state.ollama, model: cfg.ollama.model, viewers: state.viewers },
  };
}
function broadcastClients() { toControls({ type: 'clients', overlays: overlays.size }); }

wss.on('connection', (ws, req) => {
  const role = /role=control/.test(req.url || '') ? 'control' : 'overlay';
  (role === 'control' ? controls : overlays).add(ws);
  send(ws, role === 'control' ? controlInit() : overlayInit());
  if (role === 'overlay') broadcastClients();
  else { appIdleSince = 0; refreshModels(); }
  ws.on('close', () => {
    overlays.delete(ws);
    controls.delete(ws);
    if (role === 'overlay') broadcastClients();
    else if (controls.size === 0) appIdleSince = Date.now();
  });
  ws.on('error', () => {});
  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (role !== 'control') return;
    handleControlMsg(m, ws);
  });
});

function handleControlMsg(m, ws) {
  switch (m.type) {
    case 'emoteSet': setEmoteEnabled(m.name, !!m.on); break;
    case 'emoteGame': setEmoteForGame(m.name, !!m.on); break;
    case 'bttvSearch': bttvSearch(ws, String(m.query || '').trim()); break;
    case 'emoteAdd': addEmote(ws, m); break;
    case 'transcript':
      if (typeof m.text === 'string' && m.text.trim()) {
        const t = Date.now();
        state.transcript.push({ t, text: m.text.trim() });
        heardLog('HEARD  ' + m.text.trim());
        state.lastSpeechAt = t;
        if (!state.speechPendingSince) state.speechPendingSince = t;
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
    case 'run': setRunning(!!m.on); break;
    case 'models': refreshModels(); break;
    case 'quit': shutdown('quit from app'); break;
    case 'set': {
      const prevModel = cfg.ollama.model;
      cfg = deepMerge(cfg, m.patch || {});
      if (m.patch && m.patch.viewers && typeof m.patch.viewers.start === 'number') {
        state.viewers = m.patch.viewers.start;
        toOverlays({ type: 'viewers', n: state.viewers });
      }
      saveConfig();
      applyRuntimeConfig();
      if (cfg.ollama.model !== prevModel) switchModel(prevModel);
      break;
    }
  }
}

// logs/heard.log: what the mic picked up and what the AI answered, so you
// can check after a stream what was actually understood (local file only)
function heardLog(line) {
  try {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(ROOT, 'logs', 'heard.log'), '[' + new Date().toLocaleString() + '] ' + line + '\n');
  } catch (e) { /* logging must never break chat */ }
}
function setRunning(on) {
  if (state.running === on) return;
  state.running = on;
  if (!on) {
    toOverlays({ type: 'clear' });
    state.reactiveQueue.length = 0;
    state.train = null;
    state.transcript.length = 0;
    state.speechPendingSince = 0;
  }
  console.log(`[chat] ${on ? 'started' : 'stopped'}`);
  toControls({ type: 'run', on });
}

// free the old model's VRAM right away instead of after keep_alive expires —
// two 3-4B models resident at once is a real squeeze on an 8 GB card
function switchModel(prevModel) {
  unloadModel(prevModel);
  state.reactiveQueue.length = 0;
  // a warm-up in flight notices the switch when it finishes and restarts itself
  if (state.ollama === 'loading') return;
  setOllama('unknown');
  checkOllama();
}
function unloadModel(model) {
  return fetch(cfg.ollama.url + '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(3000),
    body: JSON.stringify({ model, keep_alive: 0 }),
  }).catch(() => {});
}

async function refreshModels() {
  try {
    const res = await fetch(cfg.ollama.url + '/api/tags', { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    state.models = (data.models || [])
      .filter((m) => !/embed/i.test(m.name))
      .map((m) => ({ name: m.name, size: m.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) { /* Ollama down: keep the last known list */ }
  toControls({ type: 'models', models: state.models });
}

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[app] shutting down (${reason})`);
  state.running = false;
  toOverlays({ type: 'clear' });
  toControls({ type: 'bye' });
  await unloadModel(cfg.ollama.model); // hand the VRAM back to games
  setTimeout(() => process.exit(0), 200);
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
  ollama: 'unknown',        // unknown | down | missing | loading | ready
  llmBusy: false,
  speechPendingSince: 0,    // first unanswered speech since the last AI batch
  lastSpeechAt: 0,
  lastLlmAt: 0,
  batchAt: 0,               // when the newest AI batch arrived
  running: !APP_MODE,       // chat on/off (Start/Stop in the app)
  models: [],               // installed Ollama models [{name, size}]
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
  // single choke point: triggers, echoes and joiner greetings scheduled
  // before a Stop all land here and are dropped
  if (!state.running) return;
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
  if (!state.running) return;
  toOverlays({ type: 'system', text });
  toControls({ type: 'feed_sys', text });
}

function emoteOnlyText(pool) {
  const list = pool && pool.length ? pool : emotePool();
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
// a line that was used recently is not used again for a while — hearing the
// same sentence twice in ten minutes is the fastest way to sound like a bot
const recentCanned = [];
function pickFresh(list) {
  for (let i = 0; i < 8; i++) {
    const l = pick(list);
    if (l.length <= 6 || !recentCanned.includes(l)) {
      if (l.length > 6) { recentCanned.push(l); if (recentCanned.length > 120) recentCanned.shift(); }
      return l;
    }
  }
  return pick(list);
}
function complimentLine() {
  const id = String(cfg.compliments.identity || '').trim();
  const pool = (ambient.compliments || []).filter((l) => id || !l.includes('{id}'));
  return pool.length ? pickFresh(pool).replace('{id}', id) : null;
}
function cannedFor(p) {
  if (chance(cfg.compliments.share)) {
    const c = complimentLine();
    if (c) return c;
  }
  // 40% of background lines come from the active game's pack, so even the
  // non-AI chat sounds like it's watching this game
  const gameLines = activeGame().chatLines;
  if (Array.isArray(gameLines) && gameLines.length && chance(0.4)) return pickFresh(gameLines);
  const pools = [];
  const tagPool = ambient[p.tag];
  if (Array.isArray(tagPool) && tagPool.length && chance(0.55)) pools.push(tagPool);
  pools.push(ambient.generic || ['lol']);
  return pickFresh(pick(pools));
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
// "only when I'm talking" mode: background chat goes quiet a while after
// the streamer stops speaking
function chatIsQuiet() {
  return cfg.chat.onlyWhenTalking && Date.now() - state.lastSpeechAt > cfg.chat.quietAfterSec * 1000;
}
function produceMessage() {
  if (!state.running || (overlays.size === 0 && controls.size === 0)) return; // stopped / nobody watching
  if (chatIsQuiet()) return;
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
  const extra = emotePool();
  if (chance(cfg.chat.appendEmoteChance) && extra.length) line += ' ' + pick(extra);
  sendChat(p, line);
}

// reactive (LLM) messages drip on their own clock, independent of ambient
// density — lowering messagesPerMinute never throttles AI comments.
function reactiveDripTick() {
  try {
    if (chatIsQuiet()) state.reactiveQueue.length = 0; // quiet mode: no stragglers
    if (state.reactiveQueue.length && (overlays.size || controls.size)) {
      const text = state.reactiveQueue.shift();
      const p = pickPersona();
      sendChat(p, text);
      if (chance(cfg.chat.reactiveEchoChance)) scheduleEchoes(p, text);
    }
  } catch (e) { /* keep scheduling */ }
  // drain faster when the queue is deep, breathe when it's shallow
  // a fresh batch lands in a quick burst, like real chat piling in right
  // after something happens; then it eases off
  const fresh = Date.now() - state.batchAt < 6000;
  const gap = fresh ? rand(500, 1300) : state.reactiveQueue.length > 8 ? rand(800, 1800) : rand(1400, 3600);
  setTimeout(reactiveDripTick, gap);
}

// other chatters pile on after an LLM comment: @mentions, repeated emotes,
// repeated keywords — real chat echoes itself constantly
function scheduleEchoes(srcPersona, text) {
  const toks = String(text).split(/\s+/);
  const emoteToks = toks.filter((w) => emotes.has(w));
  const used = new Set([srcPersona.name]);
  let delay = 0;
  for (let i = 0, n = randInt(1, 3); i < n; i++) {
    delay += rand(1200, 4200);
    setTimeout(() => {
      if (chatIsQuiet()) return;
      const p = pickPersona(used);
      used.add(p.name);
      const r = Math.random();
      let line;
      if (r < 0.35) line = '@' + srcPersona.name + ' ' + pick(['real', 'fr', 'lmao', 'true', 'W', 'this', 'facts']);
      else if (r < 0.6 && emoteToks.length) line = Array(randInt(1, 3)).fill(pick(emoteToks)).join(' ');
      else line = pick(['fr', 'real', 'lol', 'true', 'same', 'this', 'facts', 'exactly', 'W', 'nah fr']);
      sendChat(p, line, { noTrain: true });
    }, delay);
  }
}

// ================================================================ join / leave
function joinTick() {
  try {
    if (state.running && !chatIsQuiet() && (overlays.size || controls.size)) {
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
    if (!cfg.viewers.enabled || !state.running) return;
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
    case 'compliments':
      stagger(Array(randInt(6, 8)).fill(0), 300, 1100, () => {
        const c = complimentLine();
        if (c) sendChat(freshPersona(), c);
      });
      break;
    case 'slow':
      state.slowUntil = Date.now() + 30000;
      break;
  }
}

// ================================================================ Ollama reactive layer
function setOllama(st) {
  if (state.ollama === st) return;
  state.ollama = st;
  toControls({ type: 'status', ollama: st, model: cfg.ollama.model });
}

let ollamaKickedAt = 0;
async function checkOllama() {
  if (state.ollama === 'loading') return; // a warm-up is already in flight
  try {
    const res = await fetch(cfg.ollama.url + '/api/tags', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    const want = cfg.ollama.model;
    const ok = models.some((n) => n === want || n === want + ':latest' || n.split(':')[0] === want.split(':')[0]);
    if (!ok) {
      if (state.ollama !== 'missing') {
        console.log(`[ollama] model "${want}" is not pulled. Run:\n\n    ollama pull ${want}\n\n  Running in ambient-only mode until then.`);
      }
      setOllama('missing');
      return;
    }
    if (state.ollama !== 'ready') {
      // preload into VRAM before enabling the reactive layer, so the first
      // real cycles fit inside timeoutMs instead of timing out on a cold load
      setOllama('loading');
      const loaded = await warmModel();
      if (want !== cfg.ollama.model) { // model switched while this one loaded
        unloadModel(want);
        state.ollama = 'unknown';
        return checkOllama();
      }
      setOllama(loaded ? 'ready' : 'down');
      if (loaded) { placementLoggedAt = 0; logPlacement('loaded'); }
      if (loaded) console.log(`[ollama] model "${want}" ready — reactive layer enabled`);
    }
  } catch (e) {
    if (state.ollama !== 'down') console.log('[ollama] not reachable at ' + cfg.ollama.url + ' — ambient-only mode');
    setOllama('down');
    kickOllama();
  }
}

// Ollama's desktop app often isn't running (it doesn't start with Windows by
// default). Any `ollama` CLI call starts it, so do that once, then recheck.
function kickOllama() {
  if (Date.now() - ollamaKickedAt < 60000) return;
  ollamaKickedAt = Date.now();
  try {
    spawn('ollama', ['list'], { windowsHide: true, stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
    console.log('[ollama] starting Ollama...');
    for (const d of [4000, 9000, 16000, 30000]) setTimeout(checkOllama, d);
  } catch (e) { /* not installed: stay in ambient-only mode */ }
}

async function warmModel() {
  try {
    const res = await fetch(cfg.ollama.url + '/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model: cfg.ollama.model, prompt: '', keep_alive: '30m' }),
    });
    return res.ok;
  } catch (e) { return false; }
}

// Handing a 4B model all 55 emote names made half of every batch bare emotes
// and almost nothing about what was said (measured: 52% emote-only, 13% on
// topic). So: tell it the game, give it the game's vocabulary, offer only a
// short emote list, and show one worked example as a prior turn, which small
// models copy far more reliably than written rules.
function reactionEmotes() {
  const usable = new Set(usableEmotes());
  const listed = (gamePacks.reactionEmotes || []).filter((e) => usable.has(e));
  // the game's own emotes go first so the AI actually uses them
  return [...new Set([...gameEmotes().slice(0, 5), ...(listed.length >= 4 ? listed : [...usable])])].slice(0, 12);
}
function complimentRule() {
  if (!(cfg.compliments.share > 0)) return '';
  const id = String(cfg.compliments.identity || '').trim();
  return `\nSome viewers adore the streamer: ${cfg.compliments.share >= 0.2 ? 3 : 2} of the 8 messages should instead compliment the streamer personally (how good looking or hot they are, their vibe${id ? `, being their favourite ${id} streamer` : ''}). Playful, like real viewers.`;
}
function llmMessages(said) {
  const g = activeGame();
  const notes = String(cfg.stream.notes || '').trim();
  const asUser = (t) => `The streamer just said: "${t}"`;
  const system = `You are the live chat of a small Twitch stream. The streamer is playing ${g.name}.
${g.context || ''}${notes ? '\nRight now: ' + notes : ''}
${g.terms && g.terms.length ? 'Words viewers use: ' + g.terms.join(', ') + '.' : ''}

You get what the streamer just said out loud. Write 8 chat messages, each from a different viewer, reacting to THAT.
Every message must respond to what was said: answer their question, give advice or backseat, hype it, roast it, doubt it, joke about it, ask a follow-up, or repeat a detail they mentioned.
Style: mostly lowercase, 2 to 7 words, twitch slang, typos are fine. No emoji, no hashtags, no full formal sentences.
At most 2 of the 8 may be a single emote, and only from: ${reactionEmotes().join(', ')}.${complimentRule()}
Reply as JSON: {"messages": ["...", "..."]}`;
  const shot = g.example && g.example.said && Array.isArray(g.example.chat)
    ? [{ role: 'user', content: asUser(g.example.said) }, { role: 'assistant', content: JSON.stringify({ messages: g.example.chat.slice(0, 8) }) }]
    : [];
  return [{ role: 'system', content: system }, ...shot, { role: 'user', content: asUser(said) }];
}

function parseLLMItems(content) {
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
  return items;
}
// returns a function that turns one raw model string into a chat line (or null)
function makeCleaner() {
  // models write "pepeHands" / "CatJAM" for PepeHands / catJAM — fix the case
  // so they render as emotes. Only tokens with a capital letter: lowercase
  // "cooked" or "vibe" are ordinary words that happen to match an emote name.
  const byLower = new Map(emoteNames().map((n) => [n.toLowerCase(), n]));
  const fixEmoteCase = (s) => s.split(' ')
    .map((t) => (/[A-Z]/.test(t) && byLower.get(t.toLowerCase())) || t)
    .join(' ');
  const isEmoteOnly = (s) => s.split(' ').every((t) => emotes.has(t));
  let emoteOnlyLeft = 2; // background chat already carries plenty of emotes
  const seen = new Set();
  return (raw) => {
    if (typeof raw !== 'string') return null;
    let s = fixEmoteCase(raw.replace(/[*_`#>\[\]]/g, '').replace(/\s+/g, ' ').trim());
    if (isEmoteOnly(s) && emoteOnlyLeft-- <= 0) return null;
    s = s.replace(/[\s\-–—]+$/, '').replace(/([.!?]){2,}$/, '$1'); // trailing dash/punct junk
    if (!s || s.length > 70) return null;
    if (/as an ai|i cannot|great point|here (are|is)|json|assistant|keep at it|good luck|you got this|proud of you/i.test(s)) return null;
    if (s.split(',').length > 2) return null; // comma-listing = assistant voice, not chat
    // de-formalize: "Nice play there." -> "nice play there"
    if (/^[A-Z][a-z]/.test(s) && !emotes.has(s.split(' ')[0])) s = s[0].toLowerCase() + s.slice(1);
    s = s.replace(/[.]+$/, '');
    s = capWords(s);
    const key = s.toLowerCase();
    if (seen.has(key) || state.recentLLM.includes(key)) return null;
    seen.add(key);
    return s;
  };
}
// the complete string literals inside the JSON array received so far
function streamedItems(content) {
  const start = content.indexOf('[');
  if (start < 0) return [];
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(content))) { try { out.push(JSON.parse(m[0])); } catch (e) { out.push(null); } }
  return out;
}

// where the model actually sits. When a game fills the VRAM, part of the
// model is pushed to the CPU and generation gets 10x slower — the usual
// reason for timeouts mid-stream.
let placementLoggedAt = 0;
async function logPlacement(why) {
  if (Date.now() - placementLoggedAt < 60000) return;
  placementLoggedAt = Date.now();
  try {
    const r = await fetch(cfg.ollama.url + '/api/ps', { signal: AbortSignal.timeout(2000) });
    const m = ((await r.json()).models || []).find((x) => x.name === cfg.ollama.model || x.model === cfg.ollama.model);
    if (!m || !m.size) return;
    state.gpuPct = Math.round(((m.size_vram || 0) / m.size) * 100);
    console.log(`[ollama] ${why}: model is ${state.gpuPct}% on the GPU` +
      (state.gpuPct < 100 ? ' — the rest runs on the CPU (slow); something else is using the video memory' : ''));
  } catch (e) { /* diagnostics only */ }
}

// The AI reacts to speech, not to a clock: once a sentence has settled (or
// every 4s of continuous talking), send everything said since the last
// batch. reactiveIntervalSec is only a cooldown that caps GPU use.
function tryReact() {
  if (!state.running || state.llmBusy || state.ollama !== 'ready' || !state.speechPendingSince) return;
  const now = Date.now();
  const settled = now - state.lastSpeechAt > 1000 || now - state.speechPendingSince > 4000;
  const cooledDown = now - state.lastLlmAt >= cfg.ollama.reactiveIntervalSec * 1000;
  if (settled && cooledDown) llmCallOnce();
}
async function llmCallOnce() {
  const now = Date.now();
  const fresh = state.transcript.filter((x) => x.t >= state.speechPendingSince).map((x) => x.text);
  // a short new line ("no way") gets the last few seconds before it as context
  const context = fresh.join(' ').length < 40
    ? state.transcript.filter((x) => x.t < state.speechPendingSince && now - x.t < cfg.ollama.transcriptWindowSec * 1000).map((x) => x.text)
    : [];
  const said = [...context, ...fresh].join(' ').trim();
  state.speechPendingSince = 0; // speech arriving during the call starts the next batch
  if (said.length < 10) return;
  state.lastLlmAt = now;
  state.llmBusy = true;

  const kept = [];
  const clean = makeCleaner();
  let content = '', emitted = 0, firstMs = 0, timedOut = false, failed = null;
  // each line goes to chat the moment the model finishes writing it
  const accept = (s) => {
    if (!kept.length) {
      state.reactiveQueue.length = 0; // fresh reactions replace stale ones
      state.batchAt = Date.now();
      firstMs = Date.now() - now;
    }
    kept.push(s);
    state.reactiveQueue.push(s);
    state.recentLLM.push(s.toLowerCase());
    if (state.recentLLM.length > 40) state.recentLLM.shift();
  };
  try {
    const res = await fetch(cfg.ollama.url + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(cfg.ollama.timeoutMs),
      body: JSON.stringify({
        model: cfg.ollama.model,
        stream: true,
        format: 'json',
        keep_alive: '30m',
        // thinking models otherwise burn the whole timeout reasoning and
        // return nothing; non-thinking models ignore this
        think: false,
        options: { temperature: cfg.ollama.temperature, num_predict: 320 },
        messages: llmMessages(said.slice(-500)),
      }),
    });
    if (!res.ok) throw new Error('http ' + res.status);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const d = JSON.parse(line);
        if (d.error) throw new Error(d.error);
        content += (d.message && d.message.content) || '';
        const items = streamedItems(content);
        while (emitted < items.length && kept.length < cfg.ollama.maxPerCycle) {
          const s = clean(items[emitted++]);
          if (s) accept(s);
        }
      }
    }
    // odd output shapes (no array) only parse once complete
    if (!kept.length) for (const s of parseLLMItems(content).map(clean).filter(Boolean).slice(0, cfg.ollama.maxPerCycle)) accept(s);
  } catch (e) {
    if (/abort|timeout/i.test(String(e))) timedOut = true;
    else failed = e;
  } finally {
    state.llmBusy = false;
  }
  const ms = Date.now() - now;
  if (failed) { console.log('[llm] error: ' + (failed.stack || failed)); checkOllama(); }
  else if (timedOut) console.log(`[llm] timed out after ${cfg.ollama.timeoutMs}ms, kept ${kept.length}${kept.length ? ' (partial)' : ''}`);
  else console.log(`[llm] ${ms}ms (first line ${firstMs}ms), kept ${kept.length}` + (kept.length < 3 ? ` | raw: ${content.slice(0, 160).replace(/\n/g, ' ')}` : ''));
  if (timedOut) await logPlacement('after a timeout');
  heardLog((kept.length ? 'CHAT   ' + kept.join(' | ') : 'CHAT   (no AI reply' + (timedOut ? ', timed out' : '') + ')') + '\n       reacting to: ' + said.slice(-200));
  if (kept.length) toControls({ type: 'llm', queued: state.reactiveQueue.length, added: kept });
  toControls({ type: 'aiHealth', ok: kept.length > 0, timedOut, ms, firstMs, gpuPct: state.gpuPct });
}
setInterval(tryReact, 400);

// ================================================================ config hot reload
function applyRuntimeConfig() {
  startViewerTimer();
  toOverlays(overlayInit());
  toControls({ type: 'config', config: cfg, game: gameSummary() });
  toControls(emoteState()); // game tags depend on the active game
}
fs.watchFile(CONFIG_PATH, { interval: 700 }, () => {
  if (Date.now() - lastSelfWrite < 1500) return;
  console.log('[config] config.json changed — reloading');
  loadConfig();
  applyRuntimeConfig();
});
fs.watchFile(AMBIENT_PATH, { interval: 2000 }, () => { loadAmbient(); console.log('[ambient] reloaded'); });
fs.watchFile(GAMES_PATH, { interval: 2000 }, () => {
  if (Date.now() - lastGamesWrite < 3000) return; // our own save from the app
  loadGames();
  console.log('[games] reloaded');
  toControls({ type: 'games', games: gameList(), active: gameSummary() });
  toControls(emoteState());
});
let emoteRescan = null;
try {
  fs.watch(EMOTES_DIR, () => {
    clearTimeout(emoteRescan);
    emoteRescan = setTimeout(() => {
      // Windows also fires this when files are merely read, so only act on
      // real additions/removals
      const before = emoteNames().join('|');
      scanEmotes();
      if (emoteNames().join('|') === before) return;
      console.log(`[emotes] rescanned: ${emotes.size} emotes`);
      toControls(emoteState());
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
  if (url === '/control' || url === '/app') return serveFile(res, path.join(PUBLIC_DIR, 'control.html'));
  if (url === '/icon.png') return serveFile(res, path.join(ROOT, 'assets', 'icon.png'));
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
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
  ambientTick();
  reactiveDripTick();
  joinTick();
  checkOllama();
  refreshModels();
  setInterval(checkOllama, 60000);

  if (APP_MODE) {
    console.log('  [app mode] chat starts paused; exits when the app window closes\n');
    // generous grace while the window first opens (Chrome cold start), then
    // a short one so a page reload doesn't kill the server
    let graceMs = 60000;
    setInterval(() => {
      if (controls.size === 0 && appIdleSince && Date.now() - appIdleSince > graceMs) shutdown('app window closed');
      if (controls.size > 0) graceMs = 15000;
    }, 3000);
  }
});

process.on('SIGINT', () => shutdown('ctrl+c'));
