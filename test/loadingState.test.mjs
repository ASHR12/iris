import test from "node:test";
import assert from "node:assert/strict";
import { LOADING_PLACEHOLDER } from "../src/lib/loadingState.ts";

// Gap ROT: ConnectionsStatus.tsx:44 and PersonalFocusPanel.tsx (lines 42, 56,
// 75, 89) each hard-code a bare "…" loading placeholder ad hoc, which is
// indistinguishable from empty/error state and can drift independently per
// file. The fix adds a single shared LOADING_PLACEHOLDER constant in
// src/lib/loadingState.ts that both components must import instead.
test("LOADING_PLACEHOLDER is the shared, unambiguous loading string", () => {
  assert.equal(LOADING_PLACEHOLDER, "Lädt…");
});
