import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseHomegameId,
  readSelectedHomegame,
  rememberHomegame,
  SELECTED_HOMEGAME_KEY,
} from "../src/lib/homegames.js";
test("selection restores only valid memberships and falls back deterministically", () => {
  const groups = [{ id: "a" }, { id: "b" }];
  assert.equal(chooseHomegameId(groups, "b"), "b");
  assert.equal(chooseHomegameId(groups, "missing"), "a");
  assert.equal(chooseHomegameId(groups, null), "a");
  assert.equal(chooseHomegameId([], "b"), null);
});
test("only the selected ID is persisted; denied browser storage is harmless", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const saved = new Map();
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key) => saved.get(key) ?? null,
        setItem: (key, value) => saved.set(key, value),
        removeItem: (key) => saved.delete(key),
      },
    });
    rememberHomegame("b");
    assert.equal(readSelectedHomegame(), "b");
    assert.deepEqual([...saved.keys()], [SELECTED_HOMEGAME_KEY]);
    rememberHomegame(null);
    assert.equal(readSelectedHomegame(), null);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("Storage denied");
      },
    });
    assert.doesNotThrow(() => rememberHomegame("a"));
    assert.equal(readSelectedHomegame(), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});
