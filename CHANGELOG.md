# Changelog

All notable changes to Iris are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Iris is
pre-1.0, so minor versions may still contain breaking changes to configuration
and IPC surfaces.

## [Unreleased]

### Added

- **Conversation memory that spans the whole day.** A Live session only retains
  the last few minutes of speech, so Iris now summarizes each conversation into
  `~/.iris/journal/YYYY-MM-DD.md` — one section per wake-to-sleep cycle, closed
  with a short digest written in Iris's own voice. Today's digests are injected
  at connect, so "what did we decide this morning?" needs no lookup. Everything
  stays on the machine; only the one-shot summarization call leaves it.
- **`search_conversation` tool** for anything older than today, or for detail the
  digests omit. Search is a local scan over digest lines — roughly 0.06 ms per
  query, with no index to maintain and no network round trip.
- **Session lifecycle log** at `~/.iris/session-log.jsonl`, recording connects,
  resumes, rejected resume handles, refresh takeovers, and digest writes. There
  was previously no history of any of this once the log panel scrolled away.
- **Conversation memory setting** in Settings, plus `IRIS_CONVERSATION_JOURNAL`,
  `IRIS_JOURNAL_RAW_DAYS`, `IRIS_JOURNAL_DIGEST_DAYS`, `IRIS_DIGEST_MODEL`, and
  `IRIS_SESSION_LOG`. Raw spoken lines age out after 7 days, digests after 90.

### Changed

- **The Live context window is now compressed** at 40000 tokens down to 16000,
  which stops per-turn cost compounding across an all-day session and removes
  the 15-minute ceiling on audio-only sessions. The numbers are sized against
  the ~5.5k-token incompressible floor of tool schemas, instructions, and the
  `USER`/`MEMORY` snapshot: an earlier 16384/8192 attempt left too little room
  for a Google Search result to land, which is why it was reverted. Verified
  live — after a forced compression, a grounded search still returns a real
  figure.
- **Waking no longer waits on background handle renewal.** A standby refresh
  could hold the wake for tens of seconds while it connected and polled. A wake
  now yields to it for at most 1.5 s, then closes its socket and takes over. The
  refresh itself nudges immediately instead of after 4 s, cutting its worst case
  from ~27 s to ~16 s.
- **The microphone opens in parallel with the Gemini connect** rather than after
  it. In series, the device's own startup delay landed after "I'm back", so the
  first thing said on waking went into a microphone that was not listening yet.
- **`GoAway` is handled proactively.** When the server warns that a long-lived
  connection is about to be recycled, Iris now rotates it early during a silent
  moment instead of being cut off wherever the drop happens to fall. A busy
  connection is left alone for the existing reconnect path.
- **Gesture control is a remembered preference.** The camera no longer switches
  itself on at wake, in HUD mode, or when the Neural Map opens; it is off until
  you turn it on, and it stays however you left it (`IRIS_GESTURE_CONTROL`).

### Fixed

- **Farewells no longer guess the time of day.** Iris has no clock, so "go to
  sleep" could be answered with "good night" at three in the afternoon. The
  `go_to_sleep` tool response, the sleep rule, and the session-start greeting now
  agree on time-neutral wording.
- **Markdown no longer leaks into Hermes card previews.** The two-line preview in
  the side panel rendered `**bold**` and `##` literally while the opened reader
  showed it correctly. Previews are now flattened to prose.

## [0.4.0] — 2026-07-25

The Luminous Instrument redesign. The interface is rebuilt on flat surfaces and a
real token system, which also eliminates the colour banding that dark UIs
normally suffer from.

### Changed

- **The UI is rebuilt on flat surfaces.** The deck, HUD, and overlays no longer
  use stacked gradient washes. Depth now comes from one step of fill tone plus
  spacing rather than from washes and outlines, and nested 1px borders are gone
  from panels, bubbles, and cards — edges are kept only for floating menus.
- **The palette is lifted off near-black**, from `#030509` to `#0b111c`. This is
  the core fix for contour lines: below the sRGB toe, brightness is proportional
  to code value, so one code step at value 7 is a ~14% brightness jump while at
  value 21 it is ~5% and stops reading as an edge.
- **Tokens are retuned** into proper type, space, radius, and elevation scales,
  and the reactive accent now tracks the orb state so ambient light follows what
  Iris is doing.
- **Light only exists while the reactor runs.** The canvas halo carried a fixed
  alpha floor, so a sleeping orb still emitted a glow disc wider than its drawn
  ring, which the asleep filter turned into a grey smudge. The halo is now gated
  on how far energy sits above rest, keyed off a single shared constant, with
  stops rebalanced so the awake look is unchanged.
- **View → Toggle Full Screen** is replaced by **Toggle Glass HUD**. The old item
  was a no-op on this frameless window; the HUD now has a menu-bar exit.

### Fixed

- **Colour banding in dark areas.** The visible contour lines were 8-bit
  quantization, not a rendering bug. A soft gradient spread across ~900px has
  fewer code levels than pixels to cross, so it renders as wide flat plateaus
  with hard 1-level edges. It only showed in dim states because the aurora and
  glow were dimmed there, leaving the near-flat base ramp as the only structure
  on screen. The six-wash drifting aurora, the full-window vignette, and the
  window-sized deck and boot gradients are now flat fills.
- **Phantom depth around the orb.** The dark radial scrim behind the HUD orb and
  the plinth under every orb stage are gone. Both were soft washes standing in
  for depth, and on a flat dark surface they read as shadow rather than light.

### Added

- **"Dark UI without colour banding"** in the README — a full writeup of the
  cause and the five rules Iris follows, since the problem is general to dark
  interfaces and the analysis transfers to any project.
- A Cursor rule scoped to `src/styles` that enforces those rules for future work.

## [0.3.0] — 2026-07-25

The all-day release. Iris gains a searchable knowledge graph, survives a full
workday on one conversation, hears her own name far more reliably, and installs
as a real macOS app.

### Added

- **Neural Map** — the Hermes brain vault (`IRIS_BRAIN_PATH`) rendered as a
  force-directed constellation over the desktop in HUD mode, with Obsidian-style
  physics, degree-scaled link distances, label-aware collision, and a folder
  legend. Navigable by voice (`focus_brain_node`, `open_brain_note`,
  `close_brain_note`) and by gesture (palm pan, two-palm zoom, point-dwell
  select). Notes render as clean markdown with clickable wikilinks, strictly
  read-only.
- **Semantic brain search** — `electron/brainIndex.mjs` is a dependency-free
  module and CLI owning the whole retrieval stack: a content-hashed incremental
  embedding index under `~/.iris/brain-index` (`gemini-embedding-2`, 768-dim
  MRL, atomic writes, rename/prune handling), BM25F lexical search, cosine
  similarity, and reciprocal-rank fusion with confidence gating. Exposed to
  Gemini as `search_brain` for spoken recall with citations. The same file ships
  in the Hermes brain skill so both sides rank identically.
- **Standby mode** — Iris drops the Gemini Live session after a quiet spell
  (default 30s) and resumes the same conversation on wake, because an idle Live
  session bills roughly 25 tokens/sec. Hermes completions auto-wake her to
  announce results. Resume tokens renew silently at the 110-minute mark
  (validity ceiling 118 min), expired or rejected handles fall back to a fresh
  session, reconnects use backoff, and queued announcements survive drops.
  Standby has its own moonlit breathing animation, distinct from manual sleep.
- **Map isolation mode and magnetic pinch grab** — voice focus isolates a node's
  local graph while a status pill offers the exits (`show_full_brain_graph`,
  background tap, layered Esc). Pinch is now the grab hand with strict OK-sign
  engagement, symmetric release, and a magnetic latch that grabs a nearby node
  and never pans. Per-hand gesture tags and a "Holding" toast make every grab
  visible.
- **`filter_brain_graph`** — keeps every note matching a spoken query visible via
  full-text substring matching over all note bodies, plus confident semantic
  widening for paraphrase.
- **One-command macOS install** — `npm run install:mac` builds, packages,
  installs to `/Applications`, and relaunches. `scripts/install-mac.mjs` quits
  the running app, replaces the bundle via `ditto`, and clears quarantine.
- **Full Hermes interaction protocol** — clarification requests and approval
  gates are answered by voice through `respond_hermes_interaction`, while
  passwords, sudo values, and secrets are routed to secure UI only and never
  handled by voice.
- **Device pickers** — mic and camera selection moved out of Settings onto the
  main screen as portal-rendered menus positioned to never cover conversation
  text. Devices bind with exact-with-fallback constraints and the live mic
  hot-swaps without dropping the session.
- **Demo vault** — `demo-obsidian-vault/` ships a Constellation Field Guide of
  164 fully linked fictional notes, with a deterministic generator, so the
  Neural Map can be demoed publicly without personal data.
- **Voice HUD control** — "enter HUD mode" and "exit HUD" via new
  `enter_hud_mode` / `exit_hud_mode` actions.
- **Orb micro-expressions** and synthesized interface sounds.
- **Test suite** — 49 tests across 17 files covering the dispatch gate, Live
  session lifecycle, tool coordination, Hermes transport and events, run
  registry persistence, memory, routing, sleep intent, and window security.
- **CI** — GitHub Actions runs `npm run verify` (tests, Electron checks,
  typecheck, bundle, Python reference compile) on every push and pull request.

### Changed

- **Hermes confirmation is now conversational.** Gemini interprets whether the
  user authorized a dispatch from full conversational meaning instead of
  matching fixed phrases, while the structural two-step propose/submit
  safeguard stays enforced in code. This cut `electron/hermesGate.mjs` roughly
  in half.
- **Google Search status reports only real Live API evidence** (grounding
  metadata or executable-code parts), never predicted intent from a partial
  transcript.
- **Wake/sleep hotkeys require Option** — wake is ⌥W, sleep ⌥S, and the HUD
  hotkey moved from ⌥Space to ⌥H. All three are OS-level global shortcuts, so
  they work while another app has focus in HUD mode.
- **Native macOS traffic lights** replace the hand-drawn window buttons
  (`titleBarStyle: hiddenInset`), hidden in HUD mode and re-pinned on exit.
- **Standby is speech-aware** — the idle clock resets on sustained mic energy
  against an adaptive ambient floor rather than lagging transcripts, so a long
  utterance is never cut off mid-sentence.
- **Hermes context survives sessions** — complete results are delivered to
  Gemini, and answering a question about a historical task now requires an
  explicit `read_hermes_task_result` retrieval instead of inferring from the
  card title.
- **HUD layout respects a single 100px Dock-clearance line** across the camera,
  reactor cluster, and controls. The task panel is capped at 42vh, and the
  Neural Map layers below HUD chrome with a soft vignette.
- **The map no longer swallows the desktop** — the stage is click-through and the
  window only accepts the mouse over a node or map UI, keeping apps, Dock, and
  the orb usable.
- **`API_SERVER_KEY` must be a strong secret.** Hermes refuses keys under 16
  characters, so the old `iris-local-dev` default is gone in favor of
  `openssl rand -hex 32` with the same value on both sides.
- **Sleep is time-neutral** — every parting phrase triggers `go_to_sleep`, and
  farewells never assume time of day.

### Fixed

- **Hermes gateway auto-start** — if the API is unreachable at launch, Iris
  restarts the gateway itself (launchd on macOS, falling back to the `hermes`
  CLI via `HERMES_BIN`, `PATH`, or the venv module) and polls until it answers.
  Opt out with `IRIS_HERMES_AUTOSTART=false`.
- **Wake-word false activations** — confidence thresholds raised and paired with
  an independent on-device human-speech confirmation, so noise-only spikes are
  rejected. Sensitivity is configurable (relaxed/balanced/strict) and both
  configured and effective scores are exposed for tuning.
- **Mouse lockout on the Neural Map** — window interactivity was reusing the
  strict gesture hit-test, which rejected nearly every node at overview zoom.
  Interactivity now uses a size-free proximity test while gestures keep the
  strict one, pinned by a regression suite that drives a real mouse.
- **Alt chord handling** — the pre-existing modifier guard rejected all Alt
  combinations before the new hotkey handlers could run.
- **Boot screen re-arming during power-off** — now plays only on the power-on
  edge.
- **Internal events no longer leak into Comms** — `SYSTEM_EVENT_*` injections are
  filtered out of the visible transcript.
- **Installer staging** — packaged app copies are removed after installation to
  avoid duplicate Finder entries.
- **Wake diagnostics** are temporary rather than a persistent HUD overlay.

## [0.2.0] — 2026-07-02

First public release.

### Added

- Gemini Live voice companion with a Hermes worker loop, two-step dispatch
  confirmation, and richer task briefs.
- Glass HUD overlay mode with gesture-first interaction.
- Deep Space design system, Orbital Deck UI, reactive HUD, and app icon.
- MediaPipe hand-gesture control with disintegration effect and visual handoff.
- Voice-driven UI context, task matching, live Hermes activity feed, and voice
  step controls.
- On-device "Hey Iris" wake word (openWakeWord-style ONNX pipeline).
- Voice-controlled sleep with conditional topic resumption.
- macOS packaging and production launch support.
- README showcase with demo video and screenshots.

[0.4.0]: https://github.com/ASHR12/iris/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ASHR12/iris/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ASHR12/iris/releases/tag/v0.2.0
