import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MEMORY_FILES = ["USER.md", "MEMORY.md"];

export function hermesMemoryDir(hermesHome) {
  const home = String(hermesHome || "").trim()
    ? String(hermesHome).replace(/^~(?=$|\/)/, os.homedir())
    : path.join(os.homedir(), ".hermes");
  return path.join(path.resolve(home), "memories");
}

function readFileIfPresent(file, maxChars) {
  try {
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8").trim().slice(0, maxChars);
  } catch {
    return "";
  }
}

/** Stable identity/preferences only; episodic MEMORY.md is retrieved on demand. */
export function loadStableUserProfile({ hermesHome, maxChars = 4000 } = {}) {
  const file = path.join(hermesMemoryDir(hermesHome), "USER.md");
  const text = readFileIfPresent(file, maxChars);
  return { text, files: text ? ["memories/USER.md"] : [] };
}

function tokens(value) {
  return [
    ...new Set(
      String(value || "")
        .toLowerCase()
        .match(/[\p{L}\p{N}]{2,}/gu) || [],
    ),
  ];
}

function matchingSnippet(text, query, width = 420) {
  const wanted = new Set(tokens(query));
  const paragraphs = text.split(/\n{2,}/).filter((part) => part.trim());
  let best = paragraphs[0] || "";
  let bestHits = -1;
  for (const paragraph of paragraphs) {
    const hits = tokens(paragraph).filter((token) => wanted.has(token)).length;
    if (hits > bestHits) {
      best = paragraph;
      bestHits = hits;
    }
  }
  return best.replace(/\s+/g, " ").trim().slice(0, width);
}

export function searchHermesMemory({ hermesHome, query, topK = 4 } = {}) {
  const queryTokens = tokens(query);
  if (!queryTokens.length) return [];
  const dir = hermesMemoryDir(hermesHome);
  const results = [];
  for (const name of MEMORY_FILES) {
    const file = path.join(dir, name);
    const text = readFileIfPresent(file, 100000);
    if (!text) continue;
    const haystack = new Set(tokens(text));
    const hits = queryTokens.filter((token) => haystack.has(token)).length;
    if (!hits) continue;
    const stat = fs.statSync(file);
    results.push({
      source: "hermes_memory",
      path: `hermes:${name}`,
      title: name.replace(/\.md$/i, ""),
      snippet: matchingSnippet(text, query),
      score: hits / queryTokens.length,
      confident: hits / queryTokens.length >= 0.5,
      updatedAt: stat.mtimeMs,
      stale: false,
    });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(8, topK)));
}

export function readHermesMemory({ hermesHome, sourcePath, maxChars = 6000 } = {}) {
  const match = /^hermes:(USER|MEMORY)\.md$/i.exec(String(sourcePath || ""));
  if (!match) return { ok: false, error: "Unknown Hermes memory source." };
  const canonical = `${match[1].toUpperCase()}.md`;
  const file = path.join(hermesMemoryDir(hermesHome), canonical);
  const text = readFileIfPresent(file, maxChars);
  if (!text) return { ok: false, error: "Memory source is empty or unavailable." };
  return {
    ok: true,
    source: "hermes_memory",
    path: `hermes:${canonical}`,
    title: canonical.replace(".md", ""),
    content: text,
    truncated: fs.statSync(file).size > Buffer.byteLength(text),
  };
}
