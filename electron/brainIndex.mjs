// ===== Hermes Brain semantic index =====
//
// One self-contained module (Node stdlib only — no npm deps) that owns
// everything about searching the brain vault:
//
//   - walking the vault and building clean per-note text
//   - Gemini embeddings (batched REST, retries, model fallback, MRL dims)
//   - the on-disk vector index (content-hash cache, atomic writes)
//   - BM25F lexical search (title/aliases/tags field + body field)
//   - hybrid retrieval (reciprocal-rank fusion of lexical + vector)
//
// It is used from three places, which is why it must stay dependency-free:
//   1. Iris' Electron main process imports it (packaged via electron/**).
//   2. `node electron/brainIndex.mjs` runs it as a CLI (sync / search / stats).
//   3. A byte-identical copy ships inside the private hermes-brain skill so
//      the Hermes agent can refresh the index right after a Notion sync.
//
// PRIVACY: vectors + manifest live under ~/.iris/brain-index/<vault-id>/ —
// never inside a repo, never inside the vault, never inside the skill folder.
//
// Bump VERSION when the embed-text recipe or file format changes; the version
// is part of the manifest and any mismatch triggers a clean full re-index.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const VERSION = 1;

// Newest first; the sync probes and uses the first model the key can access.
// gemini-embedding-2 is Google's first natively multimodal embedding model
// (we embed text today; the same index can hold image embeds later).
export const EMBED_MODELS = ["gemini-embedding-2-preview", "gemini-embedding-001"];

// Matryoshka (MRL) tier: 768 keeps ~search-parity with 3072 at 1/4 the bytes.
// Truncated embeddings MUST be re-normalized — done for every vector below.
export const EMBED_DIMS = 768;

const EMBED_BASE = "https://generativelanguage.googleapis.com/v1beta";
const BATCH_SIZE = 100; // API maximum for batchEmbedContents
const EMBED_TEXT_MAX = 12000; // chars; vault notes are ~120 lines, this covers whole notes
const RETRY_DELAYS_MS = [800, 2000, 5000];

// ---------- small utilities ----------

export function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function l2Normalize(values) {
  let norm = 0;
  for (const v of values) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = values[i] / norm;
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reads KEY=value lines without clobbering anything already in process.env.
export function loadIrisEnv(envPath = path.join(os.homedir(), ".iris", ".env")) {
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

// ---------- vault walking + note parsing ----------

export function walkVaultFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue; // .obsidian, .git, .trash
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(root);
  return files.sort();
}

function parseFrontmatter(raw) {
  const meta = {};
  let body = raw;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (match) {
    body = raw.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line
        .slice(idx + 1)
        .trim()
        .replace(/^[\["']+|[\]"']+$/g, "")
        .trim();
      if (key && value) meta[key] = value;
    }
  }
  return { meta, body };
}

// Strip Notion-sync scaffolding so we embed meaning, not markup.
function cleanBody(body) {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<empty-block\s*\/?>/gi, " ")
    .replace(/<\/?(?:columns|column)>/gi, " ")
    .replace(/<video[^>]*src="([^"]+)"[^>]*>\s*<\/video>/gi, " $1 ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // image embeds carry no text meaning
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * One retrieval record per note. `embedText` is what the vector represents;
 * `searchTitle` / `searchBody` feed the BM25F fields; `hash` keys the cache.
 */
export function buildNoteRecord(root, absPath) {
  const rel = path.relative(root, absPath);
  const raw = fs.readFileSync(absPath, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  const title = path.basename(rel, ".md");
  const folder = rel.includes(path.sep) ? rel.split(path.sep)[0] : "root";
  const cleaned = cleanBody(body);

  const aliases = (meta.aliases || meta.alias || "").trim();
  const tags = (meta.tags || "").trim();
  const headings = [...cleaned.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]).join(" · ");

  const embedText = [
    `Title: ${title}`,
    aliases ? `Aliases: ${aliases}` : "",
    tags ? `Tags: ${tags}` : "",
    `Folder: ${folder}`,
    headings ? `Sections: ${headings}` : "",
    "",
    cleaned.slice(0, EMBED_TEXT_MAX),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    rel,
    title,
    folder,
    hash: sha1(`v${VERSION}:${embedText}`),
    embedText,
    searchTitle: [title, aliases, tags, folder].filter(Boolean).join(" "),
    searchBody: cleaned.slice(0, EMBED_TEXT_MAX),
  };
}

export function readVaultRecords(root) {
  return walkVaultFiles(root).map((file) => buildNoteRecord(root, file));
}

// ---------- Gemini embedding REST ----------

async function embedBatchOnce({ apiKey, model, requests }) {
  const url = `${EMBED_BASE}/models/${model}:batchEmbedContents`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      requests: requests.map((request) => ({
        model: `models/${model}`,
        content: { parts: [{ text: request.text }] },
        taskType: request.taskType,
        ...(request.title ? { title: request.title } : {}),
        outputDimensionality: EMBED_DIMS,
      })),
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`Embedding HTTP ${response.status}: ${detail.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  const embeddings = payload.embeddings || [];
  if (embeddings.length !== requests.length) {
    throw new Error(`Embedding count mismatch: sent ${requests.length}, got ${embeddings.length}`);
  }
  return embeddings.map((embedding) => {
    const values = embedding.values || [];
    if (values.length !== EMBED_DIMS) {
      throw new Error(`Unexpected embedding dims: ${values.length} (wanted ${EMBED_DIMS})`);
    }
    return l2Normalize(values);
  });
}

async function embedBatch({ apiKey, model, requests, log }) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await embedBatchOnce({ apiKey, model, requests });
    } catch (error) {
      lastError = error;
      const retriable = error.status === 429 || error.status >= 500 || error.status === undefined;
      if (!retriable || attempt === RETRY_DELAYS_MS.length) throw error;
      const delay = RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 400);
      log(`embedding batch failed (${error.message.slice(0, 120)}), retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Picks the first embedding model this API key can actually use. */
export async function probeEmbedModel(apiKey, log = () => {}) {
  let lastError = null;
  for (const model of EMBED_MODELS) {
    try {
      await embedBatchOnce({ apiKey, model, requests: [{ text: "probe", taskType: "RETRIEVAL_QUERY" }] });
      return model;
    } catch (error) {
      lastError = error;
      log(`embed model ${model} unavailable (${String(error.message).slice(0, 120)})`);
    }
  }
  throw lastError ?? new Error("No embedding model available");
}

export async function embedQuery({ apiKey, model, text }) {
  const [vector] = await embedBatch({
    apiKey,
    model,
    requests: [{ text: text.slice(0, 2000), taskType: "RETRIEVAL_QUERY" }],
    log: () => {},
  });
  return vector;
}

// ---------- on-disk index ----------

export function indexDirFor(vaultRoot) {
  const abs = path.resolve(expandHome(vaultRoot));
  const id = `${path.basename(abs).replace(/[^a-zA-Z0-9_-]+/g, "-")}-${sha1(abs).slice(0, 8)}`;
  return path.join(os.homedir(), ".iris", "brain-index", id);
}

export function loadIndexFromDisk(vaultRoot) {
  const dir = indexDirFor(vaultRoot);
  const manifestPath = path.join(dir, "manifest.json");
  const vectorsPath = path.join(dir, "vectors.f32");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(vectorsPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const buffer = fs.readFileSync(vectorsPath);
    const vectors = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    if (manifest.version !== VERSION || manifest.dims !== EMBED_DIMS) return null;
    if (vectors.length !== manifest.notes.length * manifest.dims) return null;
    return { manifest, vectors };
  } catch {
    return null;
  }
}

function writeIndexAtomic(vaultRoot, manifest, vectors) {
  const dir = indexDirFor(vaultRoot);
  fs.mkdirSync(dir, { recursive: true });
  // Vectors first, manifest last — a crash can never leave a manifest that
  // references rows which don't exist yet.
  const vectorsPath = path.join(dir, "vectors.f32");
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(`${vectorsPath}.tmp`, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  fs.renameSync(`${vectorsPath}.tmp`, vectorsPath);
  fs.writeFileSync(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2));
  fs.renameSync(`${manifestPath}.tmp`, manifestPath);
}

/**
 * The sync: hash-diff every note against the manifest, embed only the delta,
 * reuse vectors across renames (same hash, new path), prune deleted notes,
 * write atomically. Returns the fresh in-memory index + stats.
 */
export async function syncBrainIndex({ vaultRoot, apiKey, log = () => {}, force = false, dryRun = false }) {
  const startedAt = Date.now();
  const root = path.resolve(expandHome(vaultRoot));
  if (!fs.existsSync(root)) throw new Error(`Vault not found: ${root}`);

  const records = readVaultRecords(root);
  const existing = force ? null : loadIndexFromDisk(root);

  // hash -> row lookup over the previous index (drives reuse + rename moves).
  const prevRows = new Map();
  if (existing) {
    existing.manifest.notes.forEach((note, row) => prevRows.set(note.hash, { note, row }));
  }

  const reused = [];
  const pending = [];
  let renamed = 0;
  for (const record of records) {
    const prev = prevRows.get(record.hash);
    if (prev) {
      reused.push({ record, row: prev.row });
      if (prev.note.path !== record.rel) renamed += 1;
    } else {
      pending.push(record);
    }
  }
  const prunedCount = existing
    ? existing.manifest.notes.length - (records.length - pending.length)
    : 0;

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      model: existing?.manifest.model ?? null,
      total: records.length,
      embedded: pending.length,
      reused: reused.length,
      renamed,
      pruned: Math.max(0, prunedCount),
      ms: Date.now() - startedAt,
      index: existing,
    };
  }

  let model = existing?.manifest.model ?? null;
  if (pending.length > 0) {
    if (!apiKey) throw new Error("GEMINI_API_KEY missing — cannot embed new/changed notes.");
    if (!model) model = await probeEmbedModel(apiKey, log);
  }

  // Model changed since the last index (or first run with a better model
  // available)? Everything must be re-embedded in the same space.
  if (pending.length > 0 && existing && existing.manifest.model !== model) {
    log(`embedding model changed (${existing.manifest.model} -> ${model}); full re-index`);
    return syncBrainIndex({ vaultRoot, apiKey, log, force: true, dryRun });
  }

  const vectors = new Float32Array(records.length * EMBED_DIMS);
  const notes = new Array(records.length);
  const rowOf = new Map(records.map((record, index) => [record.rel, index]));

  for (const { record, row } of reused) {
    const target = rowOf.get(record.rel);
    vectors.set(existing.vectors.subarray(row * EMBED_DIMS, (row + 1) * EMBED_DIMS), target * EMBED_DIMS);
    notes[target] = { path: record.rel, title: record.title, folder: record.folder, hash: record.hash };
  }

  let embedded = 0;
  for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
    const batch = pending.slice(offset, offset + BATCH_SIZE);
    const vectorsBatch = await embedBatch({
      apiKey,
      model,
      requests: batch.map((record) => ({
        text: record.embedText,
        title: record.title,
        taskType: "RETRIEVAL_DOCUMENT",
      })),
      log,
    });
    batch.forEach((record, i) => {
      const target = rowOf.get(record.rel);
      vectors.set(vectorsBatch[i], target * EMBED_DIMS);
      notes[target] = { path: record.rel, title: record.title, folder: record.folder, hash: record.hash };
      embedded += 1;
    });
    log(`embedded ${Math.min(offset + batch.length, pending.length)}/${pending.length}`);
  }

  const manifest = {
    version: VERSION,
    model: model ?? "none",
    dims: EMBED_DIMS,
    vault: root,
    updatedAt: new Date().toISOString(),
    notes,
  };
  writeIndexAtomic(root, manifest, vectors);

  return {
    ok: true,
    model: manifest.model,
    total: records.length,
    embedded,
    reused: reused.length,
    renamed,
    pruned: Math.max(0, prunedCount),
    ms: Date.now() - startedAt,
    index: { manifest, vectors },
  };
}

// ---------- BM25F lexical search ----------

const TITLE_WEIGHT = 2.6;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function tokenize(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((token) => token.length > 1);
}

/** Build the BM25F state over note records (in-memory, rebuilt per load). */
export function buildLexicon(records) {
  const docs = records.map((record) => {
    const titleTokens = tokenize(record.searchTitle);
    const bodyTokens = tokenize(record.searchBody);
    const tf = new Map();
    for (const token of titleTokens) tf.set(token, (tf.get(token) ?? 0) + TITLE_WEIGHT);
    for (const token of bodyTokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    return { record, tf, length: titleTokens.length * TITLE_WEIGHT + bodyTokens.length };
  });
  const df = new Map();
  for (const doc of docs) {
    for (const token of doc.tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  return { docs, df, avgLength, count: docs.length };
}

export function lexicalSearch(lexicon, query, topK = 12) {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return [];
  const scored = [];
  for (const doc of lexicon.docs) {
    let score = 0;
    for (const token of tokens) {
      const tf = doc.tf.get(token);
      if (!tf) continue;
      const df = lexicon.df.get(token) ?? 0;
      const idf = Math.log(1 + (lexicon.count - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / lexicon.avgLength))));
    }
    if (score > 0) scored.push({ record: doc.record, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

// ---------- vector + hybrid search ----------

export function vectorSearch(index, queryVector, topK = 12) {
  const { manifest, vectors } = index;
  const dims = manifest.dims;
  const scored = [];
  for (let row = 0; row < manifest.notes.length; row += 1) {
    let dot = 0;
    const base = row * dims;
    for (let i = 0; i < dims; i += 1) dot += vectors[base + i] * queryVector[i];
    scored.push({ note: manifest.notes[row], score: dot });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

function bestSnippet(body, query, width = 180) {
  const tokens = new Set(tokenize(query));
  if (tokens.size === 0) return body.slice(0, width);
  const lines = body.split(/\n+/).filter((line) => line.trim().length > 8);
  let best = null;
  let bestHits = 0;
  for (const line of lines) {
    const hits = tokenize(line).filter((token) => tokens.has(token)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = line;
    }
  }
  const chosen = (best ?? body).replace(/\s+/g, " ").trim();
  return chosen.length > width ? `${chosen.slice(0, width - 1)}…` : chosen;
}

const RRF_K = 60;

// Embedding similarity has no natural zero — nonsense still scores ~0.55-0.6
// against SOMETHING. A hit is only confident when its cosine clears this bar
// or its note actually contains most of the query's content words.
export const COSINE_CONFIDENT = 0.65;
export const COVERAGE_CONFIDENT = 0.6;

const CONTENT_STOPWORDS = new Set([
  "the", "a", "an", "for", "to", "of", "in", "on", "at", "about", "with",
  "my", "your", "our", "his", "her", "their", "its", "that", "this", "one",
  "note", "notes", "and", "or", "me", "show", "open", "find", "which", "what",
  "mentions", "mention", "do", "we", "have", "know", "anything",
]);

export function contentTokens(query) {
  return [...new Set(tokenize(query))].filter((token) => !CONTENT_STOPWORDS.has(token));
}

/** Fraction of the query's content words that actually appear in the note. */
export function queryCoverage(lexicon, rel, query) {
  const tokens = contentTokens(query);
  if (tokens.length === 0) return 0;
  const doc = lexicon.docs.find((item) => item.record.rel === rel);
  if (!doc) return 0;
  const hits = tokens.filter((token) => doc.tf.has(token)).length;
  return hits / tokens.length;
}

/**
 * Hybrid retrieval: reciprocal-rank fusion of BM25F and cosine rankings.
 * Either side may be missing (no index yet / no API key) — degrades cleanly.
 * Each hit carries its raw lexScore/cosScore + coverage so callers can judge
 * confidence instead of trusting rank blindly.
 */
export function hybridSearch({ lexicon, index, queryVector, query, topK = 8 }) {
  const fused = new Map(); // rel -> { rel, title, folder, score, sources, lexScore, cosScore }
  const recordByRel = new Map(lexicon ? lexicon.docs.map((doc) => [doc.record.rel, doc.record]) : []);

  const add = (rel, title, folder, rank, source, raw) => {
    const entry =
      fused.get(rel) ?? { rel, title, folder, score: 0, sources: [], lexScore: 0, cosScore: 0 };
    entry.score += 1 / (RRF_K + rank);
    entry.sources.push(source);
    if (source === "lexical") entry.lexScore = raw;
    else entry.cosScore = raw;
    fused.set(rel, entry);
  };

  if (lexicon) {
    lexicalSearch(lexicon, query, 12).forEach((hit, rank) =>
      add(hit.record.rel, hit.record.title, hit.record.folder, rank + 1, "lexical", hit.score),
    );
  }
  if (index && queryVector) {
    vectorSearch(index, queryVector, 12).forEach((hit, rank) =>
      add(hit.note.path, hit.note.title, hit.note.folder, rank + 1, "semantic", hit.score),
    );
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((entry) => ({
      ...entry,
      coverage: lexicon ? queryCoverage(lexicon, entry.rel, query) : 0,
      snippet: recordByRel.has(entry.rel) ? bestSnippet(recordByRel.get(entry.rel).searchBody, query) : "",
    }));
}

// ---------- CLI ----------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const option = (name) => {
    const at = args.indexOf(name);
    return at !== -1 && at + 1 < args.length ? args[at + 1] : null;
  };

  if (flag("--version")) {
    console.log(`brain-index v${VERSION} · models ${EMBED_MODELS.join(", ")} · dims ${EMBED_DIMS}`);
    process.exit(0);
  }

  const env = loadIrisEnv();
  const vaultRoot = option("--vault") || process.env.IRIS_BRAIN_PATH || env.IRIS_BRAIN_PATH;
  const apiKey = process.env.GEMINI_API_KEY || env.GEMINI_API_KEY || "";
  if (!vaultRoot) {
    console.error("No vault: pass --vault <path> or set IRIS_BRAIN_PATH in ~/.iris/.env");
    process.exit(1);
  }

  const log = (message) => console.error(`  ${message}`);

  if (option("--search")) {
    const query = option("--search");
    const root = path.resolve(expandHome(vaultRoot));
    const lexicon = buildLexicon(readVaultRecords(root));
    const index = loadIndexFromDisk(root);
    let queryVector = null;
    if (index && apiKey && !flag("--lexical-only")) {
      try {
        queryVector = await embedQuery({ apiKey, model: index.manifest.model, text: query });
      } catch (error) {
        log(`semantic side unavailable (${error.message.slice(0, 120)}); lexical only`);
      }
    }
    const hits = hybridSearch({ lexicon, index, queryVector, query, topK: Number(option("--top")) || 8 });
    if (flag("--json")) {
      // Structured output for agents (the Hermes brain skill consumes this).
      console.log(
        JSON.stringify(
          {
            query,
            mode: queryVector ? "hybrid" : "lexical",
            results: hits.map((hit) => ({
              path: hit.rel,
              title: hit.title,
              folder: hit.folder,
              snippet: hit.snippet,
              sources: hit.sources,
              confident: hit.cosScore >= COSINE_CONFIDENT || hit.coverage >= COVERAGE_CONFIDENT,
            })),
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    for (const hit of hits) {
      console.log(`${hit.score.toFixed(4)}  [${hit.sources.join("+")}]  ${hit.title}  (${hit.rel})`);
      if (hit.snippet) console.log(`        ${hit.snippet}`);
    }
    if (hits.length === 0) console.log("(no results)");
    process.exit(0);
  }

  if (flag("--stats")) {
    const index = loadIndexFromDisk(vaultRoot);
    if (!index) {
      console.log("No index yet. Run a sync first.");
    } else {
      const { manifest } = index;
      console.log(
        `index: ${manifest.notes.length} notes · model ${manifest.model} · dims ${manifest.dims} · updated ${manifest.updatedAt}`,
      );
      console.log(`location: ${indexDirFor(vaultRoot)}`);
    }
    process.exit(0);
  }

  // Default command: sync.
  try {
    const result = await syncBrainIndex({
      vaultRoot,
      apiKey,
      log,
      force: flag("--full"),
      dryRun: flag("--dry-run"),
    });
    const mode = result.dryRun ? "dry-run" : "synced";
    console.log(
      `${mode}: ${result.total} notes · ${result.embedded} embedded · ${result.reused} reused · ` +
        `${result.renamed} renamed · ${result.pruned} pruned · ${result.ms}ms · model ${result.model ?? "n/a"}`,
    );
    process.exit(0);
  } catch (error) {
    console.error(`sync failed: ${error.message}`);
    process.exit(1);
  }
}
