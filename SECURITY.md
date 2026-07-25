# Security Policy

## Supported versions

Iris is pre-1.0 and ships from `main`. Only the latest release receives security
fixes.

| Version | Supported |
| ------- | --------- |
| 0.3.x   | ✅        |
| < 0.3   | ❌        |

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues.**

Use GitHub's private vulnerability reporting on this repository:
[Report a vulnerability](https://github.com/ASHR12/iris/security/advisories/new).
This opens a private advisory visible only to you and the maintainers.

Please include the affected version or commit, your OS and Electron version,
reproduction steps, and the impact you believe it has. If a proof of concept
executes commands or touches the filesystem, describe it rather than attaching
anything that runs automatically.

Expect an acknowledgement within 7 days and a status update within 30 days.
Please give us a reasonable window to ship a fix before public disclosure. We
will credit you in the advisory and the changelog unless you ask us not to.

## Why this project's threat model is unusual

Iris is a voice front-end that delegates real work to **Hermes**, an agent with
terminal, filesystem, and network capability. A vulnerability that lets an
attacker influence what Iris dispatches is effectively remote code execution on
the user's machine. Reports touching the boundaries below are especially
valuable.

**The dispatch gate.** Sending work to Hermes is a deliberate two-step
handshake: `propose_hermes_task` stages a brief, and only a separate
`submit_hermes_task` call after the user answers in their own turn sends it.
Anything that lets a single model turn stage *and* submit, replays or mutates a
confirmed proposal, or dispatches without an explicit user request is a security
bug, not a UX bug.

**Approvals and secrets.** Approval choices (`once`, `session`, `always`,
`deny`) are verified against what the user actually said. Passwords, sudo
values, and other secrets are handled by secure UI only and must never be
requested, repeated, logged, or spoken. Any path that routes a secret prompt
through the voice channel or a transcript is in scope.

**Audio as untrusted input.** Anyone within earshot — including a video call, a
TV, or a smart speaker — can speak to Iris. Treat spoken audio and injected
Hermes output as untrusted input capable of prompt injection. Reports showing
that third-party audio or task output can drive a dispatch or an approval are in
scope.

**Renderer and window boundaries.** The Electron renderer runs with context
isolation; only the packaged app origin and the configured dev origin are
trusted, new windows are denied, and external navigation is handed to the system
browser. See `electron/windowSecurity.mjs` and `test/windowSecurity.test.mjs`.

**Credentials at rest.** The Gemini and Hermes keys live in a mode-`0600`
`~/.iris/.env`, are never returned to renderer state, and are never committed.
`API_SERVER_KEY` must be a strong secret — Hermes refuses keys under 16
characters because the endpoint dispatches terminal-capable work. Generate one
with `openssl rand -hex 32`.

**Protected paths.** `IRIS_HERMES_PROTECTED_PATHS` constrains where dispatched
work may operate. Bypasses of that constraint are in scope.

## What is out of scope

- Missing macOS notarization or code signing on local builds. Release artifacts
  are ad-hoc signed by design; `scripts/install-mac.mjs` clears quarantine on a
  bundle the user just built themselves.
- Bundle size warnings and npm advisories in `devDependencies` with no runtime
  path.
- The `sidecar/` Python server. It is a legacy reference fenced behind
  `IRIS_ENABLE_LEGACY_SIDECAR=1`, is not part of the shipped app, and is
  documented as having weaker boundaries than the Electron path.
- Content of `demo-obsidian-vault/`. It is generated fictional data.
- Findings that require an attacker to already have local code execution or
  physical access to an unlocked machine.

## Data handling

Camera frames and wake-word audio are processed entirely on-device and never
uploaded. Conversation audio goes to the Gemini Live API while Iris is awake; a
brief silent connection may renew the resumption handle during long standby. A
bounded snapshot of Hermes `USER.md` and `MEMORY.md` is sent to Gemini at
session setup, and brain-note content is retrieved only when relevant. Semantic
indexing uses Gemini embeddings when enabled.
