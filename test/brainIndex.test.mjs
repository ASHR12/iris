import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VERSION,
  buildChunkRecords,
  buildLexicon,
  hybridSearch,
  lexicalFilter,
  readVaultRecords,
} from "../electron/brainIndex.mjs";

function makeVault(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-brain-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("brain index v2 chunks long notes while lexical records remain note-level", (t) => {
  const root = makeVault(t);
  const longBody = Array.from(
    { length: 80 },
    (_, index) => `Paragraph ${index}: Project Aurora decision and supporting detail ${"x".repeat(55)}.`,
  ).join("\n\n");
  fs.writeFileSync(
    path.join(root, "Aurora.md"),
    `---\ntags: project decision\naliases: Northern Lights\n---\n# Aurora\n\n${longBody}`,
  );

  const records = readVaultRecords(root);
  const chunks = buildChunkRecords(records);
  assert.equal(VERSION, 2);
  assert.equal(records.length, 1);
  assert.ok(chunks.length > 2);
  assert.equal(new Set(chunks.map((chunk) => chunk.id)).size, chunks.length);
  assert.ok(chunks.every((chunk) => chunk.embedText.includes("Title: Aurora")));

  const matches = lexicalFilter(buildLexicon(records), "aurora decision");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].rel, "Aurora.md");
});

test("semantic-only hits return the matching chunk snippet", (t) => {
  const root = makeVault(t);
  fs.writeFileSync(path.join(root, "Alpha.md"), "# Alpha\n\nThe launch checklist is stored here.");
  const records = readVaultRecords(root);
  const lexicon = buildLexicon(records);
  const index = {
    manifest: {
      version: 2,
      dims: 2,
      notes: [
        {
          path: "Alpha.md",
          title: "Alpha",
          folder: "root",
          snippet: "Semantic chunk containing the launch checklist.",
          mtimeMs: Date.now(),
        },
      ],
    },
    vectors: new Float32Array([1, 0]),
  };
  const [hit] = hybridSearch({
    lexicon,
    index,
    queryVector: new Float32Array([1, 0]),
    query: "orbital readiness phrase",
    topK: 1,
  });
  assert.equal(hit.rel, "Alpha.md");
  assert.equal(hit.cosScore, 1);
  assert.match(hit.snippet, /Semantic chunk/);
});
