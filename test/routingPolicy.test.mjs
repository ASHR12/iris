import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyRoute, routingGuidance } from "../electron/routingPolicy.mjs";

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
