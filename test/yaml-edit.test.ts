import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse, parseDocument, isMap, isSeq, isScalar, type Node } from 'yaml';
import { ROOT } from '../src/env.ts';
import { editYaml, type YamlPath } from '../src/yaml-edit.ts';

const STORIES = join(ROOT, 'stories');
const files = readdirSync(STORIES, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.yaml'))
  .map((file) => join(STORIES, file))
  .sort();

/** Every mapping key with a scalar or list value, as a path. */
function editablePaths(node: Node | null, path: YamlPath = []): YamlPath[] {
  if (isMap(node)) {
    return node.items.flatMap((pair) => {
      if (!isScalar(pair.key)) return [];
      const here = [...path, String(pair.key.value)];
      const value = pair.value as Node | null;
      return isScalar(value) || isSeq(value) && value.flow === true ? [here] : editablePaths(value, here);
    });
  }
  if (isSeq(node)) return node.items.flatMap((item, i) => editablePaths(item as Node, [...path, i]));
  return [];
}

/** What the data should be after the edit. Setting an anchored scalar in place keeps the anchor, so its aliases change too. */
function expected(source: string, path: YamlPath, value: unknown): unknown {
  const doc = parseDocument(source);
  const node = doc.getIn(path, true);
  if (isScalar(node)) node.value = value;
  else doc.setIn(path, value);
  return doc.toJS();
}

test('finds story files', () => assert.ok(files.length >= 15));

for (const file of files) {
  const name = file.slice(STORIES.length + 1);
  const source = readFileSync(file, 'utf8');
  const paths = editablePaths(parseDocument(source).contents as Node);

  test(`${name}: writing every value back unchanged leaves the file byte for byte`, () => {
    const data = parseDocument(source).toJS() as unknown;
    const valueAt = (path: YamlPath): unknown => path.reduce<unknown>((at, key) => (at as Record<string | number, unknown>)[key], data);
    const edits = paths.map((path) => ({ path, value: valueAt(path) }));
    assert.equal(editYaml(source, edits), source);
  });

  test(`${name}: each edit changes only its own value`, () => {
    assert.ok(paths.length > 0);
    for (const path of paths) {
      const before = parseDocument(source).getIn(path);
      const value = typeof before === 'string' ? `${before} Edited.`
        : typeof before === 'number' ? before + 1
        : Array.isArray(before) ? [...before, 'edited']
        : 'edited';
      const edited = editYaml(source, [{ path, value }]);
      assert.deepEqual(parse(edited), expected(source, path, value), `${JSON.stringify(path)} changed other data`);

      // Lines outside the edited entry are untouched.
      const a = source.split('\n');
      const b = edited.split('\n');
      let head = 0;
      while (head < a.length && a[head] === b[head]) head += 1;
      let tail = 0;
      while (tail < a.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
      const parent = parseDocument(source).getIn(path.slice(0, -1), true) as Node | undefined;
      const range = (path.length === 1 ? parseDocument(source).contents : parent)?.range ?? [0, source.length, source.length];
      const lineOf = (offset: number): number => source.slice(0, offset).split('\n').length - 1;
      assert.ok(head >= lineOf(range[0]), `${JSON.stringify(path)} rewrote lines before its mapping`);
      assert.ok(a.length - tail <= lineOf(range[2]) + 1, `${JSON.stringify(path)} rewrote lines after its mapping`);
    }
  });
}

test('a missing key is added at the end of its mapping, at the same indent', () => {
  const source = 'title: T\nshots:\n  - id: a\n    image: >\n      A door.\n  - id: b\n    image: B.\n';
  const edited = editYaml(source, [{ path: ['shots', 0, 'lines'], value: [{ narrator: 'Knock.' }] }]);
  assert.equal(edited, 'title: T\nshots:\n  - id: a\n    image: >\n      A door.\n    lines:\n      - narrator: Knock.\n  - id: b\n    image: B.\n');
  assert.deepEqual(parse(edited).shots[0].lines, [{ narrator: 'Knock.' }]);
});

test('editing lines on a real episode keeps every other shot as it was', () => {
  const file = files.find((f) => f.endsWith('ep11.yaml')) ?? files[0]!;
  const source = readFileSync(file, 'utf8');
  const data = parse(source) as { shots: { lines?: unknown[] }[] };
  const lines = [{ narrator: 'A new first line.' }, { narrator: 'And a "quoted" second, with a colon: here.' }];
  const edited = editYaml(source, [{ path: ['shots', 1, 'lines'], value: lines }]);
  const after = parse(edited) as typeof data;
  assert.deepEqual(after.shots[1]?.lines, lines);
  assert.deepEqual({ ...after, shots: after.shots.filter((_, i) => i !== 1) }, { ...data, shots: data.shots.filter((_, i) => i !== 1) });
});
