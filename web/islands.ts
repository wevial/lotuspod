// The islands' modules as the page runs them, for their tests: bundled with
// Preact and its signals from web/node_modules, as web/build.ts bundles the
// islands, into one ES module that is then imported, so each test drives
// the one copy of each the bundle holds.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FEATURES = join(import.meta.dir, "..", "src", "lotuspod", "features");

// What the tests reach: the comments store's state and its reads, and the
// decisions island, each by the module the islands import it from.
const ENTRY = `
export { storeState } from ${JSON.stringify(join(FEATURES, "comments/ts/islands/comments/state.ts"))};
export { readThreads } from ${JSON.stringify(join(FEATURES, "comments/ts/islands/comments/route.ts"))};
export { answerStore, store } from ${JSON.stringify(join(FEATURES, "comments/ts/index.ts"))};
export { decisions } from ${JSON.stringify(join(FEATURES, "decisions/ts/index.ts"))};
`;

export type Islands = typeof import("../src/lotuspod/features/comments/ts/islands/comments/state")
  & typeof import("../src/lotuspod/features/comments/ts/islands/comments/route")
  & typeof import("../src/lotuspod/features/comments/ts/index")
  & typeof import("../src/lotuspod/features/decisions/ts/index");

let loaded: Promise<Islands> | null = null;

export function islands(): Promise<Islands> {
  loaded ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "lotuspod-islands-"));
    try {
      const entry = join(dir, "entry.ts");
      writeFileSync(entry, ENTRY);
      const result = await Bun.build({
        entrypoints: [entry],
        // Apart from the entry, whose .ts a .js import would name instead.
        outdir: join(dir, "out"),
        target: "browser",
        format: "esm",
        jsx: { runtime: "automatic", importSource: "preact", development: false },
        plugins: [{
          name: "web packages",
          setup(builder) {
            builder.onResolve({ filter: /^(preact|@preact\/signals)(\/|$)/ },
              (args) => ({ path: Bun.resolveSync(args.path, import.meta.dir) }));
          },
        }],
        throw: false,
      });
      if (!result.success) throw new Error(result.logs.join("\n"));
      return (await import(join(dir, "out", "entry.js"))) as Islands;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  return loaded;
}
