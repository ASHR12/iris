# Changelog

All notable changes to Iris are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Iris is
pre-1.0, so minor versions may still contain breaking changes to configuration
and IPC surfaces.

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

[0.3.0]: https://github.com/ASHR12/iris/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ASHR12/iris/releases/tag/v0.2.0
