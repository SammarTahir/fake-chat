#!/usr/bin/env node
'use strict';
/*
 * Download BetterTTV emotes into emotes/ so chat uses real Twitch emotes.
 *
 *   node tools/fetch_emotes.js                 # 50 trending emotes
 *   node tools/fetch_emotes.js trending 100    # 100 trending
 *   node tools/fetch_emotes.js global          # BTTV global set
 *   node tools/fetch_emotes.js search pepe kek pog
 *
 * Existing files are never overwritten — codes already present are skipped,
 * so it is safe to re-run and safe to mix with your own emote files.
 * Emotes are downloaded for your own local use; they are not redistributed
 * with this project (see README).
 */

const fs = require('fs');
const path = require('path');

const EMOTES_DIR = process.env.EMOTES_DIR || path.join(__dirname, '..', 'emotes');
const API = 'https://api.betterttv.net/3';
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'referer': 'https://betterttv.com/',
  'accept': 'application/json',
};
const EXT = { 'image/webp': 'webp', 'image/gif': 'gif', 'image/png': 'png' };

const getJSON = async (url) => {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${url} -> http ${r.status}`);
  return r.json();
};

// every endpoint returns either {id, code} or {emote: {id, code}}
const normalize = (list) => list.map((x) => x.emote || x).filter((e) => e && e.id && e.code);

async function collect(mode, args) {
  if (mode === 'global') return normalize(await getJSON(`${API}/cached/emotes/global`));
  if (mode === 'search') {
    if (!args.length) throw new Error('search needs at least one term, e.g. "search pepe kek"');
    const out = [];
    for (const q of args) {
      // note: this endpoint accepts offset, trending does not
      out.push(...normalize(await getJSON(`${API}/emotes/shared/search?query=${encodeURIComponent(q)}&offset=0&limit=20`)));
    }
    return out;
  }
  // trending — the API rejects an `offset` param here, so only `limit` is sent
  const limit = Math.min(parseInt(args[0], 10) || 50, 100);
  return normalize(await getJSON(`${API}/emotes/shared/trending?limit=${limit}`));
}

(async () => {
  const [, , modeArg, ...rest] = process.argv;
  const mode = ['global', 'search', 'trending'].includes(modeArg) ? modeArg : 'trending';
  const args = ['global', 'search', 'trending'].includes(modeArg) ? rest : (modeArg ? [modeArg] : []);

  fs.mkdirSync(EMOTES_DIR, { recursive: true });
  console.log(`fetching ${mode} emotes into ${EMOTES_DIR}\n`);

  const list = await collect(mode, args);
  // case-insensitive: Windows filenames collide where Twitch codes would not
  const taken = new Set(fs.readdirSync(EMOTES_DIR).map((f) => path.parse(f).name.toLowerCase()));

  let ok = 0, skipped = 0;
  const problems = [];
  for (const { id, code } of list) {
    if (/[\\/:*?"<>|\s]/.test(code)) { skipped++; problems.push(`${code} (unusable as a filename)`); continue; }
    if (taken.has(code.toLowerCase())) { skipped++; continue; }
    try {
      const r = await fetch(`https://cdn.betterttv.net/emote/${id}/2x`, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (!r.ok) { skipped++; problems.push(`${code} (http ${r.status})`); continue; }
      const ext = EXT[(r.headers.get('content-type') || '').split(';')[0]];
      if (!ext) { skipped++; problems.push(`${code} (unsupported image type)`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(path.join(EMOTES_DIR, `${code}.${ext}`), buf);
      taken.add(code.toLowerCase());
      ok++;
      console.log(`  ${code}.${ext}  ${(buf.length / 1024).toFixed(1)} KB`);
    } catch (e) { skipped++; problems.push(`${code} (${e.message})`); }
  }

  console.log(`\ndownloaded ${ok}, skipped ${skipped} (already present or unusable)`);
  if (problems.length) console.log('notes: ' + problems.slice(0, 10).join(', '));
  if (ok) console.log('\nThe server picks these up automatically — no restart needed.');
})().catch((e) => {
  console.error('\nfailed: ' + e.message);
  console.error('BetterTTV may be unreachable or may have changed its API. Your existing emotes are untouched;');
  console.error('you can always drop .png/.gif/.webp files into emotes/ by hand instead.');
  process.exit(1);
});
