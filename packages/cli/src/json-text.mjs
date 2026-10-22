// A JSON file edited as text: one member set, everything else left as it
// was written (its indentation, its line endings, the members kept on one
// line, the end of the file). `init --adopt` adds to firebase.json and
// .firebaserc this way, so a diff shows only what it added.

// The value that starts at `at`, as spans of `text`: an object keeps its
// members (each key with the span of its value), and every value its start
// and end. The text has already been parsed, so it is valid JSON.
function parseAt(text, at) {
  let i = at;
  const space = () => { while (/\s/.test(text[i] ?? '')) i += 1; };
  const string = () => {
    const start = i;
    for (i += 1; text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1;
    i += 1;
    return JSON.parse(text.slice(start, i));
  };
  const value = () => {
    space();
    const start = i;
    if (text[i] === '{' || text[i] === '[') {
      const object = text[i] === '{';
      const node = {kind: object ? 'object' : 'array', start, members: []};
      i += 1;
      space();
      if (text[i] === (object ? '}' : ']')) { i += 1; return {...node, end: i}; }
      for (;;) {
        space();
        if (object) {
          const keyStart = i;
          const key = string();
          const keyEnd = i;
          space();
          i += 1;
          const child = value();
          node.members.push({key, keyStart, colon: text.slice(keyEnd, child.start), value: child});
        } else value();
        space();
        if (text[i] === ',') { i += 1; continue; }
        i += 1;
        return {...node, end: i};
      }
    }
    if (text[i] === '"') { string(); return {kind: 'string', start, end: i}; }
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i += 1;
    return {kind: 'literal', start, end: i};
  };
  return value();
}

// The whitespace a line starts with, for the line `at` is on.
const indentOf = (text, at) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', at - 1) + 1))[0];

// A value on one line, as `{"port": 8080}` is written.
function inline(value, colon) {
  if (Array.isArray(value)) return `[${value.map(item => inline(item, colon)).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}${colon}${inline(item, colon)}`).join(', ')}}`;
  return JSON.stringify(value);
}

// `text` with `value` at `path` (a list of object keys): a member that is
// there gets the new value in its place, a missing one is added as the
// last member of its object, in that object's layout. Objects on the way
// that are missing are added whole.
export function setMember(text, path, value) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  // One level of indentation: what the file's first indented line uses.
  const unit = /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';
  let node = parseAt(text, 0);
  for (let depth = 0; depth < path.length; depth += 1) {
    const key = path[depth];
    const wanted = path.slice(depth + 1).reduceRight((inner, name) => ({[name]: inner}), value);
    const member = node.members.findLast(item => item.key === key);
    const oneLine = !text.slice(node.start, node.end).includes('\n') && (node.members.length > 0 || !text.trim().includes('\n'));
    if (member && (depth === path.length - 1 || member.value.kind !== 'object')) {
      // The new value is written on one line where the old one was.
      const written = oneLine || !text.slice(member.value.start, member.value.end).includes('\n')
        ? inline(wanted, member.colon) : JSON.stringify(wanted, null, unit).split('\n').join(`${newline}${indentOf(text, member.keyStart)}`);
      return `${text.slice(0, member.value.start)}${written}${text.slice(member.value.end)}`;
    }
    if (member) { node = member.value; continue; }
    const last = node.members.at(-1);
    const colon = node.members[0]?.colon ?? ': ';
    if (oneLine) {
      const written = `${JSON.stringify(key)}${colon}${inline(wanted, colon)}`;
      return last ? `${text.slice(0, last.value.end)}, ${written}${text.slice(last.value.end)}` : `${text.slice(0, node.start + 1)}${written}${text.slice(node.end - 1)}`;
    }
    const indent = last ? indentOf(text, last.keyStart) : `${indentOf(text, node.start)}${unit}`;
    // An object or a list goes on one line where the member before it is.
    const inlined = last && (last.value.kind === 'object' || last.value.kind === 'array') && !text.slice(last.value.start, last.value.end).includes('\n');
    const written = `${JSON.stringify(key)}${colon}${inlined ? inline(wanted, colon) : JSON.stringify(wanted, null, unit).split('\n').join(`${newline}${indent}`)}`;
    if (last) return `${text.slice(0, last.value.end)},${newline}${indent}${written}${text.slice(last.value.end)}`;
    return `${text.slice(0, node.start + 1)}${newline}${indent}${written}${newline}${indentOf(text, node.start)}${text.slice(node.end - 1)}`;
  }
  return text;
}
