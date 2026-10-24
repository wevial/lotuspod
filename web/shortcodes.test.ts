// Tests for the comments' emoji shortcodes
// (src/lotuspod/features/comments/ts/islands/comments/shortcodes.ts) and the
// table the page fetches for them.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { closed, fragment, matches } from "../src/lotuspod/features/comments/ts/islands/comments/shortcodes";

const TABLE_PATH = join(import.meta.dir, "..", "src", "lotuspod", "features", "comments", "theme", "lotuspod-emoji.json");

// The fragment before a caret at the end of text.
function at(text: string) {
  return fragment(text, text.length);
}

describe("fragment", () => {
  test("a colon at the start, after a space, a newline or a bracket opens one", () => {
    expect(at(":ta")).toEqual({ start: 0, query: "ta" });
    expect(at("so :ta")).toEqual({ start: 3, query: "ta" });
    expect(at("so\n:ta")).toEqual({ start: 3, query: "ta" });
    expect(at("so (:ta")).toEqual({ start: 4, query: "ta" });
  });

  test("a colon after a letter or a digit opens none", () => {
    expect(at("10:30")).toBeNull();
    expect(at("http://x")).toBeNull();
    expect(at("a:b")).toBeNull();
  });

  test("a colon with nothing after it opens none, and the caret ends the fragment", () => {
    expect(at("so :")).toBeNull();
    expect(fragment("so :tada now", 6)).toEqual({ start: 3, query: "ta" });
  });
});

describe("matches", () => {
  test("those starting with the query come first, then those containing it", () => {
    expect(matches({ tada: "🎉", stadium: "🏟️", taco: "🌮" }, "tad")).toEqual(["tada", "stadium"]);
  });

  test("at most 8 are listed", () => {
    const table = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`cat${i}`, "🐈"]));
    expect(matches(table, "cat")).toHaveLength(8);
  });
});

describe("closed", () => {
  test("a known shortcode closed becomes its emoji, the caret after it", () => {
    const table = { tada: "🎉" };
    const text = "so :tada:";
    expect(closed(text, text.length, table)).toEqual({ text: "so 🎉", caret: "so 🎉".length });
    expect(closed("so :tada: now", 9, table)).toEqual({ text: "so 🎉 now", caret: "so 🎉".length });
  });

  test("an unknown one stays as typed", () => {
    expect(closed("so :nope:", 9, { tada: "🎉" })).toBeNull();
    expect(closed("10:30:", 6, { "30": "x" })).toBeNull();
  });
});

describe("the checked-in table", () => {
  const table: Record<string, string> = JSON.parse(readFileSync(TABLE_PATH, "utf8"));

  test("maps tada, +1 and -1", () => {
    expect(table.tada).toBe("🎉");
    expect(table["+1"]).toBe("👍");
    expect(table["-1"]).toBe("👎");
  });

  test("every key is a fragment the matcher accepts", () => {
    const refused = Object.keys(table).filter((name) => at(":" + name)?.query !== name);
    expect(refused).toEqual([]);
  });
});
