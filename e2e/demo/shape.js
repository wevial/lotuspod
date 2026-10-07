// The shape of a JSON answer, as tests/demo_shapes.py records the real
// serve's in tests/fixtures/demo/api-shapes.json, for shapes.spec.ts to
// compare the shim's with. The same rule as the recorder's:
//
// - an object maps each key to the shape of its value;
// - a list holds the merged shape of its elements, [] when it is empty;
// - a scalar is its JSON type name: string, number, boolean or null;
// - a value seen as more than one type records each: scalar types as one
//   name, joined by "|" ("null|number"), and otherwise {"oneOf": [...]}.
//
// Merging two objects keeps every key of either.
'use strict';

const ONE_OF = 'oneOf';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnion(found) {
  return isObject(found) && Object.keys(found).length === 1 && Object.keys(found)[0] === ONE_OF;
}

function same(a, b) {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

// A shape with its object keys in order, so JSON.stringify compares it.
function sorted(found) {
  if (Array.isArray(found)) return found.map(sorted);
  if (!isObject(found)) return found;
  const result = {};
  for (const key of Object.keys(found).sort()) result[key] = sorted(found[key]);
  return result;
}

function shape(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) {
    let merged = [];
    for (const item of value) merged = merged.length ? [merge(merged[0], shape(item))] : [shape(item)];
    return merged;
  }
  if (isObject(value)) {
    const result = {};
    for (const key of Object.keys(value)) result[key] = shape(value[key]);
    return result;
  }
  throw new TypeError(`not a JSON value: ${String(value)}`);
}

function alternatives(found) {
  if (typeof found === 'string') return found.split('|');
  if (isUnion(found)) return found[ONE_OF].slice();
  return [found];
}

function kind(found) {
  if (Array.isArray(found)) return 'list';
  if (isObject(found)) return 'object';
  return String(found);
}

// Two shapes of one kind merged.
function mergeKind(a, b) {
  if (isObject(a) && isObject(b)) {
    const result = {};
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      result[key] = key in a && key in b ? merge(a[key], b[key]) : (key in a ? a[key] : b[key]);
    }
    return result;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length && b.length ? [merge(a[0], b[0])] : (a.length ? a : b);
  }
  return a;
}

// The shape of a value seen as a once and as b another time.
function merge(a, b) {
  if (same(a, b)) return a;
  const kinds = new Map();
  for (const found of [...alternatives(a), ...alternatives(b)]) {
    const name = kind(found);
    kinds.set(name, kinds.has(name) ? mergeKind(kinds.get(name), found) : found);
  }
  const merged = [...kinds.keys()].sort().map((name) => kinds.get(name));
  if (merged.length === 1) return merged[0];
  if (merged.every((found) => typeof found === 'string')) return merged.join('|');
  return { [ONE_OF]: merged };
}

// [key, what differs] for each place shape actual differs from expected.
function differences(expected, actual, key = '') {
  if (isObject(expected) && isObject(actual) && !isUnion(expected) && !isUnion(actual)) {
    const found = [];
    for (const name of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const at = key ? `${key}.${name}` : name;
      if (!(name in actual)) found.push([at, 'the fixture has it, the answer does not']);
      else if (!(name in expected)) found.push([at, 'the answer has it, the fixture does not']);
      else found.push(...differences(expected[name], actual[name], at));
    }
    return found;
  }
  if (Array.isArray(expected) && Array.isArray(actual) && expected.length && actual.length) {
    return differences(expected[0], actual[0], `${key}[]`);
  }
  if (!same(expected, actual)) {
    return [[key || '(body)', `the fixture has ${JSON.stringify(sorted(expected))}, `
      + `the answer ${JSON.stringify(sorted(actual))}`]];
  }
  return [];
}

// Each way the answered requests differ from the fixture's, naming the
// request and the key, but for the fixture's expected_differences.
function compare(fixture, answered) {
  const expected = fixture.requests;
  const allowed = new Set((fixture.expected_differences || [])
    .map((entry) => `${entry.request}\n${entry.key}`));
  const found = [];
  const names = (entries) => entries.map((entry) => entry.request);
  if (!same(names(expected), names(answered))) {
    found.push(`the requests differ: the fixture has ${JSON.stringify(names(expected))}, `
      + `the shim ${JSON.stringify(names(answered))}`);
  }
  expected.forEach((want, index) => {
    const got = answered[index];
    if (!got) return;
    const report = (key, what) => {
      if (!allowed.has(`${want.request}\n${key}`)) found.push(`${want.request}: key ${key}: ${what}`);
    };
    for (const field of ['method', 'path', 'status']) {
      if (want[field] !== got[field]) {
        report(field, `the fixture has ${JSON.stringify(want[field])}, the shim ${JSON.stringify(got[field])}`);
      }
    }
    for (const [key, what] of differences(want.shape, got.shape)) report(key, what);
  });
  return found;
}

module.exports = { shape, merge, differences, compare };
