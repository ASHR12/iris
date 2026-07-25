import test from "node:test";
import assert from "node:assert/strict";
import { isSleepIntent } from "../electron/sleepIntent.mjs";

test("detects standalone farewell and sleep commands with natural fillers", () => {
  for (const phrase of [
    "Okay, bye-bye",
    "Bye",
    "Thank you, see you later!",
    "Iris, go to sleep",
    "That's all for now",
    "Good night",
    "Alright, catch you later",
  ]) {
    assert.equal(isSleepIntent(phrase), true, phrase);
  }
});

test("does not trigger on discussion, quotation, negation, or filler alone", () => {
  for (const phrase of [
    "Don't go to sleep",
    "What happens when I say goodbye?",
    "Write a message that says bye-bye",
    "The song is called Goodnight",
    "Okay",
    "Thank you",
  ]) {
    assert.equal(isSleepIntent(phrase), false, phrase);
  }
});
