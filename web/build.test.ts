// Tests for build.ts, each in a scratch copy of the repository's layout:
// WEB/package.json and WEB/src beside src/lotuspod/_theme/js.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type CallExpression, type Identifier, type Node, type StringLiteral, SyntaxKind } from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";

import { build, ISLANDS_MARKER, marker, outDir, sliceMarker, unparsed } from "./build";

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

test("a source is written as its JS after the marker line, with no types or comments", async () => {
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  await build(web);
  const built = readFileSync(join(out, "pod-count.js"), "utf8");
  const [first, ...rest] = built.split("\n");
  expect(first + "\n").toBe(marker("pod-count"));
  expect(first).toContain("web/src/pod-count.ts");
  expect(rest.join("\n")).toBe(STRIPPED);
});

test("building twice gives identical bytes and rewrites nothing", async () => {
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  await build(web);
  expect(await build(web)).toEqual({ written: [], removed: [] });
});

test("a hand edit to a built file is overwritten", async () => {
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  await build(web);
  writeFileSync(join(out, "pod-count.js"), marker("pod-count") + "edited();\n");
  expect((await build(web)).written).toEqual([join(out, "pod-count.js")]);
  expect(readFileSync(join(out, "pod-count.js"), "utf8")).toBe(marker("pod-count") + STRIPPED);
});

test("a declaration file is not built", async () => {
  writeFileSync(join(web, "src", "globals.d.ts"), "declare const lotuspod: string;\n");
  await build(web);
  expect(readdirSync(out)).toEqual([]);
});

test("a marked file whose source is gone is deleted, and a hand-written one is untouched", async () => {
  writeFileSync(join(out, "gone.js"), marker("gone") + STRIPPED);
  writeFileSync(join(out, "shared.js"), HAND_WRITTEN);
  expect(await build(web)).toEqual({ written: [], removed: [join(out, "gone.js")] });
  expect(existsSync(join(out, "gone.js"))).toBe(false);
  expect(readFileSync(join(out, "shared.js"), "utf8")).toBe(HAND_WRITTEN);
});

test("a slice's source is written beside it as its JS, after a marker naming it", async () => {
  const slice = join(root, "src", "lotuspod", "features", "pods", "ts");
  mkdirSync(slice, { recursive: true });
  writeFileSync(join(slice, "pod-count.ts"), SOURCE);
  expect(await build(web)).toEqual({ written: [join(slice, "pod-count.js")], removed: [] });
  expect(readFileSync(join(slice, "pod-count.js"), "utf8")).toBe(sliceMarker("pods", "pod-count") + STRIPPED);
  expect(sliceMarker("pods", "pod-count")).toContain("src/lotuspod/features/pods/ts/pod-count.ts");
  expect(readdirSync(out)).toEqual([]);
});

test("a slice's marked file whose source is gone is deleted, and a hand-written one is untouched", async () => {
  const slice = join(root, "src", "lotuspod", "features", "pods", "ts");
  mkdirSync(slice, { recursive: true });
  writeFileSync(join(slice, "gone.js"), sliceMarker("pods", "gone") + STRIPPED);
  writeFileSync(join(slice, "tabs.js"), HAND_WRITTEN);
  expect(await build(web)).toEqual({ written: [], removed: [join(slice, "gone.js")] });
  expect(readFileSync(join(slice, "tabs.js"), "utf8")).toBe(HAND_WRITTEN);
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

test("a source whose \"use strict\" the transpiler drops is refused before anything is written", async () => {
  writeFileSync(join(web, "src", "a.ts"), SOURCE);
  writeFileSync(join(web, "src", "strict.ts"), '(function () {\n  "use strict";\n  document.title = "x";\n})();\n');
  await expect(build(web)).rejects.toThrow('web/src/strict.ts: Bun\'s transpiler drops its "use strict"');
  expect(readdirSync(out)).toEqual([]);
});

test("a \"use strict\" directive is refused wherever it stands: at the top, inline, in an arrow or a method", async () => {
  for (const source of [
    "'use strict';\nvar count = 1;\n",
    '(function (this: void) { "use strict"; return this === undefined; })();\n',
    '(() => {\n  // the reader\'s pods\n  "use strict";\n})();\n',
    'class Pods {\n  count(): number {\n    "use strict";\n    return 1;\n  }\n}\n',
  ]) {
    writeFileSync(join(web, "src", "strict.ts"), source);
    await expect(build(web)).rejects.toThrow('web/src/strict.ts: Bun\'s transpiler drops its "use strict"');
    expect(readdirSync(out)).toEqual([]);
  }
});

test("\"use strict\" in a comment or a string is not a directive, and builds", async () => {
  const source = '/*\n"use strict"\n*/\nconst why: string = "use strict";\ndocument.title = `${why}, \'use strict\'`;\n';
  writeFileSync(join(web, "src", "quoted.ts"), source);
  await build(web);
  expect(readFileSync(join(out, "quoted.js"), "utf8")).toBe(
    marker("quoted") + 'const why = "use strict";\ndocument.title = `${why}, \'use strict\'`;\n',
  );
});

test("a source with an import or export is refused, since render joins classic scripts", async () => {
  writeFileSync(join(web, "src", "a.ts"), SOURCE);
  for (const source of ["export const count: number = 1;\n", "export {};\nconst count = 1;\n", 'import "./a";\n']) {
    writeFileSync(join(web, "src", "module.ts"), source);
    await expect(build(web)).rejects.toThrow("web/src/module.ts: its JS is not a classic script");
    expect(readdirSync(out)).toEqual([]);
  }
});

// The islands entry: a module whose import names a free variable, as an
// island reaches the page script's closure through the bridge.
function writeIslands(files: Record<string, string>): void {
  mkdirSync(join(web, "src", "islands"), { recursive: true });
  for (const [file, source] of Object.entries(files)) {
    writeFileSync(join(web, "src", "islands", file), source);
  }
}

const BRIDGE = "declare const live: { seen(revision: string): void };\nexport const page = { live };\n";
const ENTRY = 'import { page } from "./bridge";\n\npage.live.seen("r2");\n';

test("the islands entry is bundled with its imports into islands.js, after its marker, as one script", async () => {
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  writeIslands({ "bridge.ts": BRIDGE, "main.tsx": ENTRY });
  await build(web);
  expect(readdirSync(out).sort()).toEqual(["islands.js", "pod-count.js"]);
  const built = readFileSync(join(out, "islands.js"), "utf8");
  expect(built).toStartWith(ISLANDS_MARKER);
  expect(ISLANDS_MARKER).toContain("web/src/islands/main.tsx");
  expect(built).not.toContain("import");
  expect(unparsed(out)).toEqual([]);
  // The free name keeps its own, so the closure's live is the one read.
  const seen: string[] = [];
  new Function("live", built)({ seen: (revision: string) => seen.push(revision) });
  expect(seen).toEqual(["r2"]);
  expect(await build(web)).toEqual({ written: [], removed: [] });
});

test("an island's JSX goes through Preact's automatic runtime, not its development one", async () => {
  symlinkSync(join(import.meta.dir, "node_modules"), join(web, "node_modules"));
  writeIslands({ "main.tsx": 'import { render } from "preact";\n\nrender(<p class="island">hi</p>, document.body);\n' });
  await build(web);
  const built = readFileSync(join(out, "islands.js"), "utf8");
  expect(built).toContain('{class:"island",children:"hi"}');
  expect(built).not.toContain("void 0,this)");
  expect(unparsed(out)).toEqual([]);
});

test("an islands.js whose entry is gone is deleted", async () => {
  writeFileSync(join(out, "islands.js"), ISLANDS_MARKER + "(()=>{})();\n");
  expect(await build(web)).toEqual({ written: [], removed: [join(out, "islands.js")] });
});

test("an islands entry that does not bundle is refused before anything is written", async () => {
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  writeIslands({ "main.tsx": 'import { page } from "./missing";\n\nconsole.log(page);\n' });
  await expect(build(web)).rejects.toThrow("web/src/islands/main.tsx: Bun could not bundle it");
  expect(readdirSync(out)).toEqual([]);
});

test("a source named as the islands bundle is refused", async () => {
  writeFileSync(join(web, "src", "islands.ts"), SOURCE);
  writeIslands({ "bridge.ts": BRIDGE, "main.tsx": ENTRY });
  await expect(build(web)).rejects.toThrow("web/src/islands.ts: its name is the islands bundle's");
  expect(readdirSync(out)).toEqual([]);
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

test("check passes when the committed JS is fresh", async () => {
  git("init", "-q");
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  await build(web);
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

test("check fails naming a hand-edited built file", async () => {
  git("init", "-q");
  writeFileSync(join(web, "src", "pod-count.ts"), SOURCE);
  await build(web);
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

test("check fails naming the scripts of a slice's ts/ deleted whole", () => {
  git("init", "-q");
  const slice = join(root, "src", "lotuspod", "features", "pods", "ts");
  mkdirSync(slice, { recursive: true });
  writeFileSync(join(slice, "tabs.js"), HAND_WRITTEN);
  commitAll();
  rmSync(slice, { recursive: true });
  const { exitCode, stderr } = check();
  expect(exitCode).toBe(1);
  expect(stderr).toContain(" D src/lotuspod/features/pods/ts/tabs.js");
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

// The slice rule for the scripts under src/lotuspod: a file under a slice's
// ts/ (features/SLICE/ts/) imports core/ts/, its own slice, another slice's
// public entry (its ts/index.ts), or another slice's other files only along
// an edge in TS_EDGES; the islands' bridge (a slice's ts/islands/bridge.ts)
// is the only file that reaches the classic scripts outside core and the
// slices. The imports are read with Bun's own parser, as Bun bundles them,
// and with TypeScript's for the type-only ones Bun erases.
//
// TS_EDGES is a ratchet, as EDGES in tests/test_import_graph.py is: one
// [from, to] slice pair an entry, which can only be removed.
const TS_EDGES: readonly (readonly [string, string])[] = [];

const SCRIPT_SUFFIXES = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// The module specifiers each file imports, re-exports or requires, as Bun's
// own parser lists them: `from "x"`, `import "x"`, `import x = require("x")`,
// `import("x")` and `require("x")`. A type-only import is erased first, as
// Bun erases it before it bundles.
function bundledImports(files: readonly string[]): Map<string, string[]> {
  return new Map(files.map((file) => {
    const transpiler = new Bun.Transpiler({ loader: /\.[jt]sx$/.test(file) ? "tsx" : "ts" });
    return [file, transpiler.scanImports(readFileSync(file, "utf8")).map((found) => found.path)];
  }));
}

// The module specifiers each file imports or re-exports, as TypeScript's
// own parser lists them (a source file's imports), the type-only ones Bun
// erases among them: `import type`, `import { type x }`, `export type`
// and `typeof import("x")`. null stands for an `import(...)` or
// `require(...)` whose specifier is not a literal, which the slice rule
// cannot read. The files are parsed as one project in a scratch directory,
// by the compiler the typecheck runs.
async function typedImports(files: readonly string[]): Promise<Map<string, (string | null)[]>> {
  const found = new Map<string, (string | null)[]>();
  if (files.length === 0) {
    return found;
  }
  const scratch = mkdtempSync(join(tmpdir(), "lotuspod-imports-"));
  const config = join(scratch, "tsconfig.json");
  writeFileSync(config, JSON.stringify({
    compilerOptions: { allowJs: true, jsx: "preserve", module: "esnext", target: "esnext", noEmit: true },
    files,
  }));
  const api = new API({ cwd: scratch });
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [config] });
    const program = snapshot.getProject(config)!.program;
    for (const file of files) {
      const source = (await program.getSourceFile(file))!;
      const specifiers: (string | null)[] = source.imports.map((node) => (node as StringLiteral).text);
      const unread = (node: Node): void => {
        if (node.kind === SyntaxKind.CallExpression) {
          const call = node as CallExpression;
          const loads = call.expression.kind === SyntaxKind.ImportKeyword
            || (call.expression.kind === SyntaxKind.Identifier
                && (call.expression as Identifier).text === "require");
          const argument = call.arguments[0];
          if (loads && argument !== undefined && argument.kind !== SyntaxKind.StringLiteral
              && argument.kind !== SyntaxKind.NoSubstitutionTemplateLiteral) {
            specifiers.push(null);
          }
        }
        node.forEachChild(unread);
      };
      source.forEachChild(unread);
      found.set(file, specifiers);
    }
  } finally {
    await api.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  return found;
}

// Each file's specifiers, once each: those Bun's parser reads, then those
// only TypeScript's does.
async function importedFiles(files: readonly string[]): Promise<Map<string, (string | null)[]>> {
  const bundled = bundledImports(files);
  const typed = await typedImports(files);
  return new Map(files.map((file) => {
    const specifiers = typed.get(file)!;
    return [file, [...new Set([...bundled.get(file)!, ...specifiers.filter((specifier) => specifier !== null)]),
      ...specifiers.filter((specifier) => specifier === null)]];
  }));
}

// The file a relative specifier names, as Bun resolves it: the file as
// written, else a `.js`, `.mjs` or `.cjs` specifier's TypeScript source, the
// path with a script suffix, or a directory's index; a symlink's target.
function resolveSpecifier(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  const emitted: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
  const suffix = Object.keys(emitted).find((js) => base.endsWith(js));
  const sources = suffix ? emitted[suffix]!.map((ts) => base.slice(0, -suffix.length) + ts) : [];
  const candidates = [base, ...sources, ...SCRIPT_SUFFIXES.map((suffix) => base + suffix),
    ...SCRIPT_SUFFIXES.map((suffix) => join(base, `index${suffix}`))];
  const found = candidates.find((path) => existsSync(path) && statSync(path).isFile());
  return found ? realpathSync(found) : base;
}

// Where a file under root sits: core's scripts, a slice's (and whether it is
// that slice's public entry), or neither.
function placeOf(root: string, path: string): { slice: string | null; core: boolean; entry: boolean } {
  const parts = relative(root, path).split(sep);
  if (parts[0] === "core" && parts[1] === "ts") {
    return { slice: null, core: true, entry: false };
  }
  if (parts[0] === "features" && parts.length > 2) {
    return { slice: parts[1]!, core: false, entry: parts.slice(2).join("/") === "ts/index.ts" };
  }
  return { slice: null, core: false, entry: false };
}

// One line per import a slice's script makes that the rule refuses, naming
// the file, the specifier and why. root is the package (src/lotuspod).
async function sliceImportProblems(root: string, edges: readonly (readonly [string, string])[]): Promise<string[]> {
  const features = join(root, "features");
  if (!existsSync(features)) {
    return [];
  }
  // A file the specifier names resolves to its real path, so it is placed
  // under root's; one that does not exist is placed under root as written.
  const real = realpathSync(root);
  const allowed = new Set(edges.map(([from, to]) => `${from} ${to}`));
  const problems: string[] = [];
  const files = readdirSync(features, { recursive: true, encoding: "utf8" })
    .map((file) => join(features, file))
    .filter((path) => relative(features, path).split(sep)[1] === "ts" && statSync(path).isFile()
      && SCRIPT_SUFFIXES.some((suffix) => path.endsWith(suffix)))
    .sort();
  const imported = await importedFiles(files);
  for (const file of files) {
    const own = placeOf(root, file).slice!;
    for (const specifier of imported.get(file)!) {
      if (specifier === null) {
        problems.push(`${relative(root, file)}: imports a specifier that is not a literal, `
          + "which the slice rule cannot read");
        continue;
      }
      // A package name is not a file of the repository's; a relative path,
      // an absolute one and a file: URL all are.
      const local = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
      if (!local.startsWith(".") && !isAbsolute(local)) {
        continue;
      }
      const target = resolveSpecifier(file, local);
      const place = placeOf(existsSync(target) ? real : root, target);
      if (place.core || place.slice === own || place.entry) {
        continue;
      }
      let why: string;
      if (place.slice === null) {
        if (relative(features, file).split(sep).slice(1).join("/") === "ts/islands/bridge.ts") continue;
        why = "only the islands' bridge.ts reaches the classic scripts outside core and the slices";
      } else if (allowed.has(`${own} ${place.slice}`)) {
        continue;
      } else {
        why = `slice ${own} reaches past slice ${place.slice}'s ts/index.ts along no listed edge`;
      }
      problems.push(`${relative(root, file)}: imports ${specifier} (${relative(root, target)}): ${why}`);
    }
  }
  return problems;
}

test("the scripts of the repository's slices keep the slice rule", async () => {
  expect(await sliceImportProblems(join(import.meta.dir, "..", "src", "lotuspod"), TS_EDGES)).toEqual([]);
});

test("the parsers read every import, type-only ones too, and nothing in strings, comments or patterns", async () => {
  const text = [
    'import type { A } from "./a";',
    'import { type B } from "./b";',
    'import "./c.js";',
    'export * from "./d";',
    'const late = await import("./e");',
    'import legacy = require("./f");',
    'const said = "from \\"./not-a\\"";',
    '// import "./not-b"',
    'const pattern = /from "\\.\\/not-c"/;',
    'const shown = `${late} from "./not-d" ${said}`;',
    'type G = typeof import("./g");',
    'const later = await import(`./h`);',
    'const named = await import(`./${late}`);',
    'const chosen = require(said);',
    'if (late) /"/.test(""); import { after } from "./i";',
    'const required = require("./j");',
  ].join("\n");
  const file = join(root, "imports.ts");
  writeFileSync(file, text);
  const found = (await importedFiles([file])).get(file)!;
  expect(found.filter((specifier) => specifier !== null).sort())
    .toEqual(["./a", "./b", "./c.js", "./d", "./e", "./f", "./g", "./h", "./i", "./j"]);
  expect(found.filter((specifier) => specifier === null)).toHaveLength(2);
});

describe("the slice rule over fixture slices a and b and core", () => {
  const PAST_B = "slice a reaches past slice b's ts/index.ts along no listed edge";
  let lotuspod: string;
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(lotuspod, file)), { recursive: true });
    writeFileSync(join(lotuspod, file), text);
  };

  beforeEach(() => {
    lotuspod = join(root, "src", "lotuspod");
    write("core/ts/shared.ts", "export const shared = 1;\n");
    write("_theme/js/page-open.js", "var opened = true;\n");
    write("features/b/ts/index.ts", 'export { inner } from "./inner";\n');
    write("features/b/ts/inner.ts", "export const inner = 2;\n");
    write("features/a/ts/own.ts", "export const own = 3;\n");
  });

  test("a file of a importing b's public entry, a core script or its own file passes", async () => {
    write("features/a/ts/use.ts", [
      'import { inner } from "../../b/ts/index";',
      'import { inner as again } from "../../b/ts";',
      'import { shared } from "../../../core/ts/shared";',
      'import { own } from "./own";',
      'import { render } from "preact";',
    ].join("\n"));
    expect(await sliceImportProblems(lotuspod, [])).toEqual([]);
  });

  test("a file of a importing a file of b other than its public entry, along no listed edge, fails", async () => {
    write("features/a/ts/use.ts", 'import { inner } from "../../b/ts/inner";\n');
    write("features/a/ts/required.ts", 'const { inner } = require("../../b/ts/inner");\n');
    write("features/a/ts/types.ts", 'import type { inner } from "../../b/ts/inner";\n');
    const problems = await sliceImportProblems(lotuspod, [["b", "a"]]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toStartWith(`${join("features", "a", "ts", "required.ts")}: imports ../../b/ts/inner (${join("features", "b", "ts", "inner.ts")})`);
    expect(problems[1]).toStartWith(`${join("features", "a", "ts", "types.ts")}: imports ../../b/ts/inner`);
    for (const problem of problems) {
      expect(problem).toContain(PAST_B);
    }
  });

  test("a module file of a, .mts or .mjs among them, reaching into b fails as a .ts file does", async () => {
    write("features/a/ts/use.ts", 'import { inner } from "./escape.mjs";\n');
    write("features/a/ts/escape.mts", 'export { inner } from "../../b/ts/inner";\n');
    write("features/a/ts/plain.mjs", 'export { inner } from "../../b/ts/inner.ts";\n');
    const problems = await sliceImportProblems(lotuspod, []);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toStartWith(`${join("features", "a", "ts", "escape.mts")}: imports`);
    expect(problems[1]).toStartWith(`${join("features", "a", "ts", "plain.mjs")}: imports`);
    for (const problem of problems) {
      expect(problem).toContain(PAST_B);
    }
  });

  test("a dynamic import of b's other file in a template literal fails, and one it cannot read fails too", async () => {
    write("features/a/ts/use.ts", "const inner = await import(`../../b/ts/inner`);\n");
    write("features/a/ts/pick.ts", "const name = \"inner\";\nconst inner = await import(`../../b/ts/${name}`);\n");
    const problems = await sliceImportProblems(lotuspod, []);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toStartWith(`${join("features", "a", "ts", "pick.ts")}: imports a specifier that is not a literal`);
    expect(problems[1]).toContain(PAST_B);
  });

  test("an absolute path or a file: URL to a file of b other than its public entry fails", async () => {
    const inner = join(lotuspod, "features", "b", "ts", "inner.ts");
    write("features/a/ts/use.ts", `import { inner } from ${JSON.stringify(inner)};\n`);
    write("features/a/ts/url.ts", `import { inner } from ${JSON.stringify(pathToFileURL(inner).href)};\n`);
    const problems = await sliceImportProblems(lotuspod, []);
    expect(problems).toHaveLength(2);
    for (const problem of problems) {
      expect(problem).toContain(PAST_B);
    }
    write("features/a/ts/use.ts", `import { inner } from ${JSON.stringify(join(lotuspod, "features", "b", "ts", "index.ts"))};\n`);
    write("features/a/ts/url.ts", "export {};\n");
    expect(await sliceImportProblems(lotuspod, [])).toEqual([]);
  });

  test("the same import along a listed edge passes", async () => {
    write("features/a/ts/use.ts", 'import { inner } from "../../b/ts/inner";\n');
    expect(await sliceImportProblems(lotuspod, [["a", "b"]])).toEqual([]);
  });

  test("a .js specifier names its .ts source, so b's public entry so named passes", async () => {
    write("features/a/ts/use.ts", 'import { inner } from "../../b/ts/index.js";\n');
    expect(await sliceImportProblems(lotuspod, [])).toEqual([]);
    write("features/a/ts/use.ts", 'import { inner } from "../../b/ts/inner.js";\n');
    expect(await sliceImportProblems(lotuspod, [])).toHaveLength(1);
  });

  test("a .js specifier naming a file that exists names that file, not the .ts beside it", async () => {
    write("features/b/ts/index.js", "export const hidden = 4;\n");
    write("features/a/ts/use.ts", 'import { hidden } from "../../b/ts/index.js";\n');
    const problems = await sliceImportProblems(lotuspod, []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(PAST_B);
  });

  test("a symlink in a to a file of b other than its public entry fails as b's file", async () => {
    symlinkSync(join("..", "..", "b", "ts", "inner.ts"), join(lotuspod, "features", "a", "ts", "linked.ts"));
    write("features/a/ts/use.ts", 'import { inner } from "./linked";\n');
    const problems = (await sliceImportProblems(lotuspod, [])).filter((line) => line.startsWith(join("features", "a", "ts", "use.ts")));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(PAST_B);
  });

  test("only the islands' bridge.ts reaches a classic script outside core and the slices", async () => {
    write("features/a/ts/islands/bridge.ts", 'import "../../../../_theme/js/page-open.js";\n');
    expect(await sliceImportProblems(lotuspod, [])).toEqual([]);
    write("features/a/ts/bridge.ts", 'import "../../../_theme/js/page-open.js";\n');
    write("features/a/ts/use.ts", 'import "../../../_theme/js/page-open.js";\n');
    const problems = await sliceImportProblems(lotuspod, []);
    expect(problems).toHaveLength(2);
    for (const problem of problems) {
      expect(problem).toContain("only the islands' bridge.ts reaches the classic scripts");
    }
  });
});
