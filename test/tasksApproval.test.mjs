import test from "node:test";
import assert from "node:assert/strict";
import { shouldRenderInlineApproval } from "../src/lib/tasks.ts";

// Gap ROT: WorkCard.tsx has no logic to suppress its own inline "Approval
// required" box when the same task's approval is already shown as the
// full-screen ApprovalPrompt modal, so both render at once. The fix adds
// shouldRenderInlineApproval(taskId, pendingApprovalTaskId) to src/lib/tasks.ts:
// it must return false only when the inline card's task is the one already
// shown in the modal, and true otherwise (including when nothing is pending).
test("shouldRenderInlineApproval: suppresses inline box for the task shown in the modal", () => {
  assert.equal(shouldRenderInlineApproval("task-1", "task-1"), false);
});

test("shouldRenderInlineApproval: renders inline box for a different pending task", () => {
  assert.equal(shouldRenderInlineApproval("task-1", "task-2"), true);
});

test("shouldRenderInlineApproval: renders inline box when nothing is pending", () => {
  assert.equal(shouldRenderInlineApproval("task-1", null), true);
});
