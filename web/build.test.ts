// Tests for build.ts, each in a scratch copy of the repository's layout:
// WEB/package.json and WEB/src beside src/lotuspod/_theme/js.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build, marker, outDir } from "./build";

const SOURCE = `// Counts the pods a reader has open.
interface Pod {
  name: string;
  open: boolean;
}

const pods: Pod[] = [];

/** How many of the pods are open. */
function openCount(list: Pod[]): number {
  return list.filter((pod: Pod) => pod.open).length;
}

pods.push({ name: "plan", open: true } as Pod);
document.title = String(openCount(pods));
`;

const STRIPPED = `const pods = [];
function openCount(list) {
  return list.filter((pod) => pod.open).length;
}
pods.push({ name: "plan", open: true });
document.title = String(openCount(pods));
`;

const HAND_WRITTEN = "(function () {\n  // written by hand\n})();\n";

let root: string;
let web: string;
let out: string;

function writePackage(bun: string): void {
  writeFileSync(join(web, "package.json"), JSON.stringify({ private: true, packageManager: `bun@${bun}` }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lotuspod-web-"));
  web = join(root, "web");
  out = outDir(web);
  mkdirSync(join(web, "src"), { recursive: true });
  mkdirSync(out, { recursive: true });
  writePackage(Bun.version);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("the output directory is the theme's js directory beside web", () => {
  expect(out).toBe(join(root, "src", "lotuspod", "_theme", "js"));
});

test("a source is written as its JS after the marker line, with no types or comments", () => {
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  build(web);
  const built = readFileSync(join(out, "pod-count.js"), "utf8");
  const [first, ...rest] = built.split("\n");
  expect(first + "\n").toBe(marker("pod-count"));
  expect(first).toContain("web/src/pod-count.ts");
  expect(rest.join("\n")).toBe(STRIPPED);
});

test("building twice gives identical bytes and rewrites nothing", () => {
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  build(web);
  expect(build(web)).toEqual({ written: [], removed: [] });
});

test("a hand edit to a built file is overwritten", () => {
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  build(web);
  writeFileSync(join(out, "pod-count.js"), marker("pod-count") + "edited();\n");
  expect(build(web).written).toEqual([join(out, "pod-count.js")]);
  expect(readFileSync(join(out, "pod-count.js"), "utf8")).toBe(marker("pod-count") + STRIPPED);
});

test("a declaration file is not built", () => {
  writeFileSync(join(web, "src", "globals.d.ts"), "declare const lotuspod: string;\n");
  build(web);
  expect(readdirSync(out)).toEqual([]);
});

test("a marked file whose source is gone is deleted, and a hand-written one is untouched", () => {
  writeFileSync(join(out, "gone.js"), marker("gone") + STRIPPED);
  writeFileSync(join(out, "shared.js"), HAND_WRITTEN);
  expect(build(web)).toEqual({ written: [], removed: [join(out, "gone.js")] });
  expect(existsSync(join(out, "gone.js"))).toBe(false);
  expect(readFileSync(join(out, "shared.js"), "utf8")).toBe(HAND_WRITTEN);
});

test("another Bun exits non-zero before writing anything, naming both versions", () => {
  writePackage("0.0.1");
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  writeFileSync(join(out, "gone.js"), marker("gone") + STRIPPED);
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "build.ts"), web]);
  const stderr = run.stderr.toString();
  expect(run.exitCode).not.toBe(0);
  expect(stderr).toContain(`Bun ${Bun.version}`);
  expect(stderr).toContain("bun@0.0.1");
  expect(readdirSync(out)).toEqual(["gone.js"]);
});
