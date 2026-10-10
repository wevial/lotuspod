// Builds each theme source web/src/NAME.ts into src/lotuspod/_theme/js/NAME.js:
// its types stripped by Bun's transpiler (no bundling, so each file stands
// alone), after one marker line naming the source. The order the scripts are
// served in stays in THEME_SOURCES in src/lotuspod/cli.py, which joins them.
//
//   bun build.ts [WEB_DIR]           build
//   bun build.ts --check [WEB_DIR]   build, then fail on a difference from git
//
// WEB_DIR defaults to this directory; the output is its ../src/lotuspod/_theme/js.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const MARKER_PREFIX = "// Built from web/src/";

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
  if (names.length) {
    mkdirSync(out, { recursive: true });
  }
  for (const name of names) {
    const built = marker(name) + transpiler.transformSync(readFileSync(join(srcDir, `${name}.ts`), "utf8"));
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

function git(cwd: string, args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, stderr: "inherit" });
  if (run.exitCode !== 0) {
    throw new BuildError(`git ${args.join(" ")} exited ${run.exitCode}`);
  }
  return run.stdout.toString();
}

function main(args: string[]): number {
  const check = args.includes("--check");
  const webDir = args.find((arg) => arg !== "--check") ?? import.meta.dir;
  try {
    const { written, removed } = build(webDir);
    for (const target of written) console.log(`built ${target}`);
    for (const target of removed) console.log(`removed ${target}, its source is gone`);
    if (!check) {
      return 0;
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
