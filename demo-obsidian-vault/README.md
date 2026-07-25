---
type: meta
tags: [meta]
---
# Demo vault — Constellation Field Guide

A fictional astronomy research vault for testing and demoing Iris's **Neural Map** without exposing personal notes. ~176 notes, ~600 links, 11 folders — enough structure for constellations, semantic search, and voice traversal.

## Use it with Iris

1. Settings → Hermes → **Hermes brain vault** → set to this folder's absolute path
2. (Optional) **Build index now** to enable semantic search — embeddings cache under `~/.iris/brain-index/`, never in this repo
3. Enter HUD mode and say **“show your brain”**

Try by voice: “focus on Kepler-442b” · “open the meteor signal from June” · “which notes mention gravitational lensing?”

## Regenerate

```bash
npm run demo:vault
```

Deterministic — same output every run. Edit `scripts/generate-demo-vault.mjs` to reshape it. Everything here is fictional; see [[conventions]].
