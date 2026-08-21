import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyRoute, routingGuidance, decideTurnOwner } from "../electron/routingPolicy.mjs";

test("recorded utterance corpus maps to the intended capability", () => {
  const fixture = new URL("./fixtures/routing-cases.json", import.meta.url);
  const cases = JSON.parse(fs.readFileSync(fileURLToPath(fixture), "utf8"));
  for (const sample of cases) {
    assert.equal(
      classifyRoute(sample.utterance),
      sample.route,
      `route mismatch for: ${sample.utterance}`,
    );
    assert.ok(routingGuidance(sample.route));
  }
});

// Gap 1 ROT: turn ownership does not exist yet. A "memory" route turn must be
// owned by Jarvis (which will answer via the bridge), never by Gemini itself
// (which today double-answers alongside Jarvis's relay). Every other route is
// owned by Gemini as before.
test("decideTurnOwner: memory route is owned by jarvis, everything else by gemini", () => {
  assert.equal(decideTurnOwner("memory"), "jarvis");
  assert.equal(decideTurnOwner("direct"), "gemini");
  assert.equal(decideTurnOwner("web"), "gemini");
  assert.equal(decideTurnOwner("hermes"), "gemini");
  assert.equal(decideTurnOwner("ui"), "gemini");
});
