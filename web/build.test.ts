// Tests for build.ts, each in a scratch copy of the repository's layout:
// WEB/package.json and WEB/src beside src/lotuspod/_theme/js.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build, marker, outDir, unparsed } from "./build";

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

test("a source whose \"use strict\" the transpiler drops is refused before anything is written", () => {
  writeFileSync(join(web, "src", "a.ts"), SOURCE);
  writeFileSync(join(web, "src", "strict.ts"), '(function () {\n  "use strict";\n  document.title = "x";\n})();\n');
  expect(() => build(web)).toThrow('web/src/strict.ts: Bun\'s transpiler drops its "use strict"');
  expect(readdirSync(out)).toEqual([]);
});

test("a \"use strict\" directive is refused wherever it stands: at the top, inline, in an arrow or a method", () => {
  for (const source of [
    "'use strict';\nvar count = 1;\n",
    '(function (this: void) { "use strict"; return this === undefined; })();\n',
    '(() => {\n  // the reader\'s pods\n  "use strict";\n})();\n',
    'class Pods {\n  count(): number {\n    "use strict";\n    return 1;\n  }\n}\n',
  ]) {
    writeFileSync(join(web, "src", "strict.ts"), source);
    expect(() => build(web)).toThrow('web/src/strict.ts: Bun\'s transpiler drops its "use strict"');
    expect(readdirSync(out)).toEqual([]);
  }
});

test("\"use strict\" in a comment or a string is not a directive, and builds", () => {
  const source = '/*\n"use strict"\n*/\nconst why: string = "use strict";\ndocument.title = `${why}, \'use strict\'`;\n';
  writeFileSync(join(web, "src", "quoted.ts"), source);
  build(web);
  expect(readFileSync(join(out, "quoted.js"), "utf8")).toBe(
    marker("quoted") + 'const why = "use strict";\ndocument.title = `${why}, \'use strict\'`;\n',
  );
});

test("a source with an import or export is refused, since render joins classic scripts", () => {
  writeFileSync(join(web, "src", "a.ts"), SOURCE);
  for (const source of ["export const count: number = 1;\n", "export {};\nconst count = 1;\n", 'import "./a";\n']) {
    writeFileSync(join(web, "src", "module.ts"), source);
    expect(() => build(web)).toThrow("web/src/module.ts: its JS is not a classic script");
    expect(readdirSync(out)).toEqual([]);
  }
});

// check, run as CI runs it but from the root of a scratch repository and
// given web/ as a relative path.
function git(...args: string[]): void {
  const run = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  expect(run.exitCode).toBe(0);
}

function check(): { exitCode: number; stderr: string } {
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "build.ts"), "--check", "web"], { cwd: root });
  return { exitCode: run.exitCode, stderr: run.stderr.toString() };
}

function commitAll(): void {
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "scratch");
}

test("check passes when the committed JS is fresh", () => {
  git("init", "-q");
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  build(web);
  commitAll();
  expect(check().exitCode).toBe(0);
});

test("check fails naming a built file missing after its source was added", () => {
  git("init", "-q");
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  commitAll();
  const { exitCode, stderr } = check();
  expect(exitCode).toBe(1);
  expect(stderr).toContain("?? src/lotuspod/_theme/js/pod-count.js");
});

test("check fails naming a hand-edited built file", () => {
  git("init", "-q");
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  build(web);
  writeFileSync(join(out, "pod-count.js"), marker("pod-count") + "edited();\n");
  commitAll();
  const { exitCode, stderr } = check();
  expect(exitCode).toBe(1);
  expect(stderr).toContain(" M src/lotuspod/_theme/js/pod-count.js");
});

test("check fails naming an orphaned built file it deleted", () => {
  git("init", "-q");
  writeFileSync(join(out, "gone.js"), marker("gone") + STRIPPED);
  commitAll();
  const { exitCode, stderr } = check();
  expect(exitCode).toBe(1);
  expect(stderr).toContain(" D src/lotuspod/_theme/js/gone.js");
});

test("check fails naming each hand-written file that does not parse on its own", () => {
  git("init", "-q");
  writeFileSync(join(out, "closure-open.js"), "// Opens the closure.\n(function () {\n  \"use strict\";\n");
  writeFileSync(join(out, "closure-close.js"), "})();\n");
  writeFileSync(join(out, "whole.js"), HAND_WRITTEN);
  commitAll();
  const { exitCode, stderr } = check();
  expect(exitCode).toBe(1);
  expect(stderr).toContain(`${join(out, "closure-close.js")}: does not parse on its own`);
  expect(stderr).toContain(`${join(out, "closure-open.js")}: does not parse on its own`);
  expect(stderr).not.toContain("whole.js");
});

test("a file of a closure's body parses on its own: top-level functions, var and return", () => {
  writeFileSync(join(out, "body.js"), "var seen = 0;\nfunction mark() {\n  seen += 1;\n}\nif (!document.body) {\n  return;\n}\nmark();\n");
  writeFileSync(join(out, "notes.txt"), "})();\n");
  expect(unparsed(out)).toEqual([]);
});

test("a file nested under the output directory that does not parse is named", () => {
  mkdirSync(join(out, "feature"));
  writeFileSync(join(out, "feature", "broken.js"), "(function () {\n");
  writeFileSync(join(out, "feature", "whole.js"), HAND_WRITTEN);
  const problems = unparsed(out);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toStartWith(`${join(out, "feature", "broken.js")}: does not parse on its own`);
});
