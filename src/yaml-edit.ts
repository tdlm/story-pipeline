import { Document, isAlias, isCollection, isMap, isScalar, isSeq, parseDocument, type Node, type Scalar, type YAMLMap } from 'yaml';

export type YamlPath = (string | number)[];
export type YamlEdit = { path: YamlPath; value: unknown };

/** Widest line the editor writes, counting indentation. Matches how the story files are wrapped by hand. */
const LINE_WIDTH = 92;

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf('\n', offset - 1) + 1;
}

/**
 * Sets values in a YAML source by rewriting only the edited entries.
 * Everything else (comments, anchors, folded prompts, flow lists, blank lines) stays byte for byte.
 * Each path must end at a key of a mapping that already exists; a missing key is added at the end of it.
 */
export function editYaml(source: string, edits: YamlEdit[]): string {
  let text = source;
  for (const edit of edits) text = applyEdit(text, edit);
  return text;
}

/** Adds a key at the end of an existing block mapping, at the same indent as its other keys. */
function addKey(source: string, parent: YAMLMap, key: string, value: unknown, path: YamlPath): string {
  const first = parent.items[0]?.key as Node | undefined;
  const last = parent.items.at(-1);
  const lastEnd = (last?.value as Node | null)?.range?.[1] ?? (last?.key as Node | undefined)?.range?.[1];
  if (parent.flow === true || first?.range == null || lastEnd === undefined) {
    throw new Error(`editYaml: can't add ${JSON.stringify(path)} to this mapping`);
  }
  const indent = first.range[0] - lineStart(source, first.range[0]);
  const rendered = new Document({ [key]: value })
    .toString({ lineWidth: Math.max(40, LINE_WIDTH - indent), flowCollectionPadding: false })
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => (line === '' ? line : ' '.repeat(indent) + line))
    .join('\n');
  const end = source[lastEnd - 1] === '\n' ? lastEnd - 1 : lastEnd;
  return `${source.slice(0, end)}\n${rendered}${source.slice(end)}`;
}

function applyEdit(source: string, { path, value }: YamlEdit): string {
  const key = path.at(-1);
  if (typeof key !== 'string') throw new Error(`editYaml: path must end at a mapping key: ${JSON.stringify(path)}`);

  const doc = parseDocument(source, { keepSourceTokens: true });
  if (doc.errors.length > 0) throw new Error(`editYaml: can't parse: ${doc.errors[0]?.message}`);
  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true);
  if (!isMap(parent)) throw new Error(`editYaml: no mapping at ${JSON.stringify(path.slice(0, -1))}`);
  const pair = parent.items.find((item) => isScalar(item.key) && item.key.value === key);
  if (pair === undefined) return addKey(source, parent, key, value, path);

  const keyNode = pair.key as Scalar;
  const oldValue = pair.value as Node | null;
  const keyRange = keyNode.range;
  const valueRange = oldValue?.range;
  if (keyRange == null || valueRange == null) throw new Error(`editYaml: no source position for ${JSON.stringify(path)}`);

  // Writing a value back unchanged keeps the file as it is.
  const resolved = isAlias(oldValue) ? oldValue.resolve(doc) : oldValue;
  const current: unknown = resolved == null ? null : resolved.toJSON();
  if (JSON.stringify(current) === JSON.stringify(value)) return source;

  // Same shape as before: a folded prompt stays folded, a quoted line stays quoted, a flow list stays flow.
  const snippet = new Document({ [key]: value });
  const newValue = (snippet.contents as { items: { value: Node }[] }).items[0]?.value;
  if (isScalar(oldValue) && isScalar(newValue) && typeof newValue.value === 'string') newValue.type = oldValue.type;
  if (isCollection(oldValue) && isCollection(newValue)) newValue.flow = oldValue.flow;
  // An anchored value keeps its anchor, so aliases of it follow the edit.
  if (oldValue?.anchor !== undefined && newValue !== undefined) newValue.anchor = oldValue.anchor;

  const indent = keyRange[0] - lineStart(source, keyRange[0]);
  const rendered = snippet
    .toString({ lineWidth: Math.max(40, LINE_WIDTH - indent), flowCollectionPadding: false })
    .replace(/\n$/, '')
    .split('\n')
    .map((line, i) => (i === 0 || line === '' ? line : ' '.repeat(indent) + line))
    .join('\n');

  // valueRange[1] is the end of the value itself, before trailing comments or blank lines.
  let end = valueRange[1];
  if (source[end - 1] === '\n') end -= 1;
  return source.slice(0, keyRange[0]) + rendered + source.slice(end);
}
