import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadStableUserProfile,
  readHermesMemory,
  searchHermesMemory,
} from "../electron/memoryService.mjs";

test("only stable USER profile is injected while episodic memory is on-demand", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "iris-hermes-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "memories"));
  fs.writeFileSync(path.join(home, "memories", "USER.md"), "Prefers concise answers.");
  fs.writeFileSync(
    path.join(home, "memories", "MEMORY.md"),
    "Project Aurora launch decision: use the July schedule.",
  );

  const profile = loadStableUserProfile({ hermesHome: home });
  assert.match(profile.text, /concise/);
  assert.doesNotMatch(profile.text, /Aurora/);

  const [result] = searchHermesMemory({ hermesHome: home, query: "Aurora July schedule" });
  assert.equal(result.path, "hermes:MEMORY.md");
  assert.equal(result.confident, true);

  const note = readHermesMemory({ hermesHome: home, sourcePath: result.path });
  assert.equal(note.ok, true);
  assert.match(note.content, /July schedule/);
  assert.equal(
    readHermesMemory({ hermesHome: home, sourcePath: "hermes:../../secret" }).ok,
    false,
  );
});
