// Emoji shortcodes as GitHub and Slack write them, `:tada:` for 🎉, with no
// DOM: the fragment of one before a caret, the shortcodes a fragment
// matches, and the emoji a just-closed one becomes. The table, shortcode to
// emoji, is theme/lotuspod-emoji.json (comments/shortcode-list.tsx fetches
// it).

export type Table = Readonly<Record<string, string>>;

// The most shortcodes a fragment lists.
const LIMIT = 8;
// The characters of a shortcode's name.
const NAME = /[a-z0-9_+-]/;
// What may stand before a shortcode's opening colon, besides the start of
// the text: so 10:30, http://x and a:b open none.
const BEFORE = /[\s(\[{"']/;

// The shortcode being typed before caret: the index of its opening colon
// and the name typed after it, or null for none.
export function fragment(text: string, caret: number): { start: number; query: string } | null {
  let at = caret;
  while (at > 0 && NAME.test(text[at - 1]!)) at -= 1;
  if (at === caret || text[at - 1] !== ":") return null;
  const start = at - 1;
  if (start > 0 && !BEFORE.test(text[start - 1]!)) return null;
  return { start, query: text.slice(at, caret) };
}

// The shortcodes in table matching query: those starting with it, then those
// only containing it, each in alphabetical order, at most LIMIT.
export function matches(table: Table, query: string): string[] {
  const names = Object.keys(table).sort();
  const starting = names.filter(name => name.startsWith(query));
  const containing = names.filter(name => !name.startsWith(query) && name.includes(query));
  return [...starting, ...containing].slice(0, LIMIT);
}

// The shortcode a colon just typed before caret closes: the index of its
// opening colon and its emoji; null when the colon closes no shortcode in
// table.
export function closed(text: string, caret: number, table: Table): { start: number; emoji: string } | null {
  if (text[caret - 1] !== ":") return null;
  const open = fragment(text, caret - 1);
  if (!open || !Object.hasOwn(table, open.query)) return null;
  return { start: open.start, emoji: table[open.query]! };
}
