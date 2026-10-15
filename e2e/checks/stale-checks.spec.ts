import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// Five checks went stale when an intended change landed without the suite
// being run (LOTUS-182). Each guard below reads a spec's source and fails
// while it still holds the assumption the product no longer meets.
function source(name: string) {
  return fs.readFileSync(path.join(__dirname, name), 'utf-8');
}

// The body of the check with this title, up to the next check.
function check(name: string, title: string) {
  const text = source(name);
  const start = text.indexOf(title);
  expect(start, `${name} has a check titled ${title}`).toBeGreaterThan(-1);
  const next = text.indexOf('\n  test(', start);
  return text.slice(start, next === -1 ? undefined : next);
}

test('answer-note-threads loads its pages on their own, since #57 moves a bare load to the tabs', () => {
  expect(source('answer-note-threads.spec.ts').match(/goto\(`[^`]*\.html`\)/g) ?? []).toEqual([]);
});

test('archive reads Recent activity from /#activity, since #58 opens / on Pages', () => {
  expect(source('archive.spec.ts').match(/\bpage\.goto\('\/'\)/g) ?? []).toEqual([]);
});

test('chain does not take the heater comment as the first thread, since #60 opens one for the note first', () => {
  expect(source('chain.spec.ts')).not.toContain('threads[0]');
});

test('table-expand measures blocks from the body, not the document, since #54 and #62 grow the header', () => {
  const text = source('table-expand.spec.ts');
  const start = text.indexOf('function blocks(');
  expect(start).toBeGreaterThan(-1);
  const body = text.slice(start, text.indexOf('\n}\n', start));
  expect(body).not.toContain('window.scrollY');
});

test('pod-finder allows for pods the second reader opened earlier in the run', () => {
  const body = check('pod-finder.spec.ts', 'the key opens the finder on the pods opened most recently');
  expect(body).toMatch(/request\.get\(SEEN\)/);
});
