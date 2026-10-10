// Builds each theme source web/src/NAME.ts into src/lotuspod/_theme/js/NAME.js:
// its types stripped by Bun's transpiler (no bundling, so each file stands
// alone), after one marker line naming the source. The order the scripts are
// served in stays in THEME_SOURCES in src/lotuspod/cli.py, which joins them.
//
//   bun build.ts [WEB_DIR]           build
//   bun build.ts --check [WEB_DIR]   build, then fail on a file that does not
//                                    parse alone or a difference from git
//
// WEB_DIR defaults to this directory; the output is its ../src/lotuspod/_theme/js.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const MARKER_PREFIX = "// Built from web/src/";
const USE_STRICT = "use strict";
// Not a directive JavaScript knows, so Bun keeps it where it stands.
const USE_STRICT_PROBE = "use strict, probed by web/build.ts";

class BuildError extends Error {}

export function marker(name: string): string {
  return `${MARKER_PREFIX}${name}.ts by web/build.ts. Edit that file, not this one.\n`;
}

export function outDir(webDir: string): string {
  return join(webDir, "..", "src", "lotuspod", "_theme", "js");
}

// The one Bun pin is package.json's "packageManager": "bun@X.Y.Z". Bun's
// transpiler output is byte-stable only within one release, so any other Bun
// would make the committed JS look stale.
function checkBun(webDir: string): void {
  const manifest = JSON.parse(readFileSync(join(webDir, "package.json"), "utf8"));
  const pinned = /^bun@(\S+)$/.exec(manifest.packageManager ?? "")?.[1];
  if (!pinned) {
    throw new BuildError(`${join(webDir, "package.json")}: "packageManager" does not name bun@VERSION`);
  }
  if (Bun.version !== pinned) {
    throw new BuildError(`this is Bun ${Bun.version}, but web/package.json pins bun@${pinned}: install Bun ${pinned} to build`);
  }
}

// The JS of one source, refused when it would not run as the source does in
// the classic script render joins it into: Bun's transpiler reads every input
// as a module, so it drops each "use strict" directive and keeps import and
// export. A directive shows as the one difference between the source's JS and
// the JS of the source with each "use strict" renamed to the probe, which the
// transpiler keeps, renamed back; comments and strings strip alike in both.
function strip(transpiler: Bun.Transpiler, name: string, source: string): string {
  const stripped = transpiler.transformSync(source);
  const probed = transpiler.transformSync(source.replaceAll(USE_STRICT, USE_STRICT_PROBE));
  if (probed.replaceAll(USE_STRICT_PROBE, USE_STRICT) !== stripped) {
    throw new BuildError(`web/src/${name}.ts: Bun's transpiler drops its "use strict", so the built script would not be strict`);
  }
  try {
    new Function(stripped);
  } catch (error) {
    throw new BuildError(`web/src/${name}.ts: its JS is not a classic script, as render joins it (${(error as Error).message}); a source has no import or export`);
  }
  return marker(name) + stripped;
}

type BuildResult = { written: string[]; removed: string[] };

export function build(webDir: string): BuildResult {
  checkBun(webDir);
  const srcDir = join(webDir, "src");
  const out = outDir(webDir);
  const names = readdirSync(srcDir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => basename(file, ".ts"))
    .sort();
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const result: BuildResult = { written: [], removed: [] };
  const builds = names.map((name) => strip(transpiler, name, readFileSync(join(srcDir, `${name}.ts`), "utf8")));
  if (names.length) {
    mkdirSync(out, { recursive: true });
  }
  for (const [index, name] of names.entries()) {
    const built = builds[index]!;
    const target = join(out, `${name}.js`);
    if (!existsSync(target) || readFileSync(target, "utf8") !== built) {
      writeFileSync(target, built);
      result.written.push(target);
    }
  }
  if (existsSync(out)) {
    for (const file of readdirSync(out).sort()) {
      const target = join(out, file);
      if (!file.endsWith(".js") || names.includes(basename(file, ".js"))) {
        continue;
      }
      if (readFileSync(target, "utf8").startsWith(MARKER_PREFIX)) {
        rmSync(target);
        result.removed.push(target);
      }
    }
  }
  return result;
}

// Each JS file under the output directory, at any depth, built or written by
// hand, that does not parse on its own, with Bun's parse error: a source is a
// complete script, and render adds the closure some served scripts share
// (THEME_CLOSURES in src/lotuspod/cli.py).
export function unparsed(dir: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: "js", target: "browser" });
  const problems: string[] = [];
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".js") && statSync(join(dir, file)).isFile())
    .sort();
  for (const file of files) {
    const target = join(dir, file);
    try {
      transpiler.transformSync(readFileSync(target, "utf8"));
    } catch (error) {
      problems.push(`${target}: does not parse on its own (${(error as Error).message})`);
    }
  }
  return problems;
}

function git(cwd: string, args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, stderr: "inherit" });
  if (run.exitCode !== 0) {
    throw new BuildError(`git ${args.join(" ")} exited ${run.exitCode}`);
  }
  return run.stdout.toString();
}

function main(args: string[]): number {
  const check = args.includes("--check");
  // Absolute, since git runs in it and is handed the output directory.
  const webDir = resolve(args.find((arg) => arg !== "--check") ?? import.meta.dir);
  try {
    const { written, removed } = build(webDir);
    for (const target of written) console.log(`built ${target}`);
    for (const target of removed) console.log(`removed ${target}, its source is gone`);
    if (!check) {
      return 0;
    }
    const problems = existsSync(outDir(webDir)) ? unparsed(outDir(webDir)) : [];
    if (problems.length) {
      for (const problem of problems) console.error(problem);
      return 1;
    }
    // What git sees differ under the output directory once built: modified,
    // deleted or new. Empty when the committed JS is fresh.
    const stale = git(webDir, ["status", "--porcelain", "--untracked-files=all", "--", outDir(webDir)]);
    if (!stale) {
      console.log("theme build is fresh");
      return 0;
    }
    console.error(`the committed theme JS differs from a rebuild (bun run --cwd web build, then commit):\n${stale}`);
    console.error(git(webDir, ["diff", "--", outDir(webDir)]));
    return 1;
  } catch (error) {
    if (error instanceof BuildError) {
      console.error(`build: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
