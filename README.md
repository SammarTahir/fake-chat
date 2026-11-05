# fake-chat

A locally-run fake Twitch chat overlay for OBS. Listens to your mic (in Chrome),
generates contextual chat with a local LLM (Ollama), and renders a Twitch-style
chat column in an OBS browser source. Everything runs offline — no cloud APIs,
no accounts, no keys.

Built for solo streamers, VOD/short-form recording, and testing chat-reactive
overlays without a live audience.

```
Chrome tab (control page)         Node server              OBS browser source
  mic → Web Speech API        →   WebSocket :8080     →      renders chat
  live transcript                      ↕                    (display only)
  triggers / settings             Ollama :11434
```

**Why three processes?** OBS browser sources run on CEF, which does not
implement the Web Speech API — mic access and `SpeechRecognition` both fail
inside OBS even though the same page works in Chrome. So speech recognition
lives in a Chrome tab, and the overlay is a pure renderer that only draws what
the server sends it.

## Requirements

- **Node.js** 18+ (uses the built-in `fetch`) — only dependency is `ws`
- **OBS Studio** with a browser source
- **Chrome** (or another Chromium browser) for the control page — needed for
  the Web Speech API
- **[Ollama](https://ollama.com)** — optional; without it the overlay runs in
  ambient-only mode

Developed on Windows 11; the server is plain Node and the pages are plain
HTML/JS, so macOS and Linux should work — only the `.bat` launchers are
Windows-specific.

## Setup

```
npm install
node server.js
```

That's it — no build step, no bundler, no framework. On first run it generates
`personas.json` (60 chatters), a commented `config.json`, and a placeholder
emote set in `emotes/`.

Windows users can double-click **`start-chat.bat`** instead: it starts Ollama,
starts the server in its own window, and opens the control page. **`stop-chat.bat`**
shuts it down.

Optional (for the LLM reactive layer):

```
ollama pull llama3.2:3b
```

If Ollama isn't running or the model isn't pulled, the app runs in
**ambient-only mode** — canned chat still flows, nothing breaks, nothing shows
on stream. The server prints the exact pull command it needs.
Any pulled model works: set `ollama.model` in `config.json` (a ~3B model is
recommended so it doesn't starve NVENC on the shared GPU).

## The three pages

| URL | Where | What |
|---|---|---|
| `http://localhost:8080/overlay` | OBS browser source | The chat renderer. No mic, no LLM, silent if the server dies. |
| `http://localhost:8080/control` | Chrome, second monitor | Mic capture, transcript, triggers, settings, panic button. |
| `http://localhost:8080/overlay?demo` | Chrome | Self-contained styling check — fake generator, no server traffic needed. |

## OBS browser source settings (Twitch_Stream profile, 1080×1920 vertical canvas)

Add **Browser** source to your vertical scene:

| Setting | Value |
|---|---|
| URL | `http://localhost:8080/overlay` |
| Width | `1080` |
| Height | `1920` |
| Use custom frame rate | off (leave at canvas FPS) |
| Custom CSS | leave empty (background is already transparent) |
| **Shutdown source when not visible** | **OFF** — keeps chat history flowing so the column is already full when you switch scenes |
| **Refresh browser when scene becomes active** | **OFF** — a refresh would visibly wipe the column mid-stream. Use the control page's CLEAR button if you ever need a reset. |

Make the source full-canvas (1080×1920) and **position the chat column via
`config.json` → `overlay`** (anchor/margin/width/height), not by moving the
source. That keeps the viewer counter corner and the chat column independently
placeable.

Right-hand column example: `"anchor": "bottom-right", "width": 460, "height": 1250`.
Lower-third block example: `"anchor": "bottom-left", "width": 1032, "height": 500, "margin": [24, 180]`.

Animated GIF emotes animate inside OBS (they're plain `<img>` tags — CEF plays
them natively).

## Daily flow

1. `node server.js` (keep the terminal open)
2. Open `http://localhost:8080/control` in Chrome on your second monitor,
   click **Start mic**, allow mic access once.
3. Start OBS. Done — ambient chat runs constantly; contextual comments appear
   a few seconds after you say things.

Chrome kills continuous speech recognition after ~60s of silence; the control
page restarts it automatically, forever. The overlay reconnects with backoff if
the server restarts, and never shows an error on stream.

## Tuning

Everything lives in `config.json` — heavily commented, **hot-reloaded on save**
(no restart needed). Highlights:

- `chat.messagesPerMinute` — ambient density (also on the control page)
- `chat.emoteOnlyShare` / `emoteTrainChance` — emote traffic feel
- `overlay.*` — column position, size, font, max visible messages
- `viewers.*` — fake viewer counter start value, drift, corner, on/off
- `ollama.*` — model, reactive cadence, transcript window, timeout

`ambient.json` is the canned line pool (also hot-reloaded) — edit it to match
your stream's vibe; that's where most of the realism comes from.

`personas.json` is your chatter roster, generated once and then yours to edit:
names, colors, badges (`broadcaster`, `mod`, `vip`, `sub1..3`, `prime`),
personality tag, and `weight` (chattiness — big weight = regular, small = rare).
Delete the file to regenerate a fresh roster.

## Emotes

Drop `.png`, `.gif`, or `.webp` files into `emotes/`. Filename = emote code,
case-sensitive, exactly like Twitch (`Kappa.png` → `Kappa`). The folder is
rescanned automatically (and on startup), the LLM is told which codes exist,
and animated GIFs just work.

**This repo ships no emote images.** On first run the server generates its own
placeholder set so the overlay works immediately. To use real Twitch emotes,
fetch them yourself:

```
node tools/fetch_emotes.js                 # 50 trending BetterTTV emotes
node tools/fetch_emotes.js global          # the BTTV global set
node tools/fetch_emotes.js search pepe kek pog
```

Existing files are never overwritten, so it is safe to re-run and to mix with
your own emote files. Emote artwork belongs to its respective creators and is
downloaded for local use only — that is why it is not committed here.

## Notes

- The overlay caps its DOM at `maxMessages` + a small buffer and removes
  faded-out nodes, so it runs indefinitely without memory growth.
- Ollama being down/slow/missing degrades to ambient-only silently. LLM calls
  hard-timeout (`ollama.timeoutMs`, default 12s) and skip the cycle.
- The ambient layer (canned lines + emotes) runs constantly on its own clock;
  LLM comments drip in on a **separate** clock, so lowering
  `chat.messagesPerMinute` for a quiet baseline never throttles the AI
  reactions. After an LLM comment lands, other chatters echo it (`@mentions`,
  repeated emotes/keywords) at `chat.reactiveEchoChance`.
- Every generation logs `[llm] 4062ms, kept 8, queue 22` so you can see whether
  the model is keeping up. If `kept` is regularly low, raise `ollama.timeoutMs`
  or use a smaller model.
- The control page saves settings back into `config.json` (custom comments in
  the file are regenerated on save; values are kept).

## License

MIT — see [LICENSE](LICENSE).

Emote images and any Twitch/BetterTTV branding are not covered by this license
and are not distributed with this project.
