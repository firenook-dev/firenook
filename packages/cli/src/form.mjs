// A form on the terminal UI's grid (`terminal.mjs`): the keys a terminal
// sends, and three kinds of field, each a row with its label in the margin.
// A text field (the project id), one choice of several (the language) and
// several choices (the emulators). The row in focus has the pointer in the
// marker column and its hint under it; the rest of the form stays still.
import { width } from './terminal.mjs';

// ── Keys ─────────────────────────────────────────────────────────────────
// What a terminal sends in raw mode, as named keys. Typed and pasted text
// comes as `text`; a paste between the bracketed-paste markers, whole.
const SEQUENCES = [
  ['\x1b[A', 'up'], ['\x1bOA', 'up'], ['\x1b[B', 'down'], ['\x1bOB', 'down'],
  ['\x1b[C', 'right'], ['\x1bOC', 'right'], ['\x1b[D', 'left'], ['\x1bOD', 'left'],
  ['\x1b[H', 'home'], ['\x1bOH', 'home'], ['\x1b[1~', 'home'], ['\x1b[7~', 'home'],
  ['\x1b[F', 'end'], ['\x1bOF', 'end'], ['\x1b[4~', 'end'], ['\x1b[8~', 'end'],
  ['\x1b[3~', 'delete'], ['\x1b[Z', 'backtab'],
];
const CONTROLS = {'\r': 'enter', '\n': 'enter', '\t': 'tab', ' ': 'space', '\x7f': 'backspace', '\b': 'backspace',
  '\x03': 'ctrl-c', '\x04': 'ctrl-d', '\x01': 'home', '\x05': 'end', '\x15': 'ctrl-u', '\x17': 'ctrl-w'};
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export function keys(chunk) {
  const input = String(chunk);
  const found = [];
  let typed = '';
  const flush = () => { if (typed) found.push({name: 'text', text: typed}); typed = ''; };
  for (let i = 0; i < input.length;) {
    if (input.startsWith(PASTE_START, i)) {
      const end = input.indexOf(PASTE_END, i);
      flush();
      found.push({name: 'text', text: input.slice(i + PASTE_START.length, end === -1 ? undefined : end).replace(/\s+/g, ' ')});
      i = end === -1 ? input.length : end + PASTE_END.length;
      continue;
    }
    const sequence = SEQUENCES.find(([text]) => input.startsWith(text, i));
    if (sequence) { flush(); found.push({name: sequence[1]}); i += sequence[0].length; continue; }
    const char = input[i];
    if (char === '\x1b') {
      // A sequence this form has no use for is skipped whole; Esc on its
      // own is the key.
      flush();
      const rest = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/s.exec(input.slice(i))[0];
      if (rest.length === 1) found.push({name: 'escape'});
      i += rest.length;
      continue;
    }
    if (CONTROLS[char]) { flush(); found.push({name: CONTROLS[char]}); i += 1; continue; }
    const point = input.codePointAt(i);
    const whole = String.fromCodePoint(point);
    if (point >= 32) typed += whole;
    i += whole.length;
  }
  flush();
  return found;
}

// ── Fields ───────────────────────────────────────────────────────────────
// `hint(field, form)` says what the field does, as {text, tone}: tone is
// dim, warn or error. `check(field, form)` returns what is wrong with it.
export function textField({id, label, value = '', filter = text => text, check, hint}) {
  return {kind: 'text', id, label, value, cursor: value.length, filter, check, hint};
}
// `options`: [{id, label, detail, note}]; one choice keeps `value` (an id),
// several keep a Set of ids.
export function choiceField({id, label, options, value, many = false, check, hint}) {
  const at = many ? 0 : Math.max(0, options.findIndex(option => option.id === value));
  return {kind: many ? 'many' : 'one', id, label, options, value: many ? new Set(value) : value, cursor: at, check, hint};
}

export function createForm(fields, {check} = {}) {
  return {fields, focus: 0, problem: undefined, check};
}
const current = form => form.fields[form.focus];

// Applies one key: returns 'submit', 'cancel' or nothing.
export function press(form, key) {
  const field = current(form);
  const move = by => { form.focus = Math.max(0, Math.min(form.fields.length - 1, form.focus + by)); form.problem = undefined; };
  switch (key.name) {
    case 'ctrl-c': case 'ctrl-d': case 'escape': return 'cancel';
    case 'up': case 'backtab': return move(-1);
    case 'down': case 'tab': return move(1);
    case 'enter': {
      for (const [at, each] of form.fields.entries()) {
        const problem = each.check?.(each, form);
        if (problem) { form.focus = at; form.problem = problem; return undefined; }
      }
      const problem = form.check?.(form);
      if (problem) { form.focus = Math.max(0, form.fields.findIndex(each => each.id === problem.field)); form.problem = problem.text; return undefined; }
      return 'submit';
    }
    default:
  }
  form.problem = undefined;
  if (field.kind === 'text') return editText(field, key);
  const last = field.options.length - 1;
  if (key.name === 'left' || key.name === 'right' || key.name === 'home' || key.name === 'end') {
    const to = {left: field.cursor - 1, right: field.cursor + 1, home: 0, end: last}[key.name];
    field.cursor = Math.max(0, Math.min(last, to));
    // One choice of several follows the cursor, like a set of radio buttons.
    if (field.kind === 'one') field.value = field.options[field.cursor].id;
    return undefined;
  }
  if (key.name === 'space' && field.kind === 'many') {
    const id = field.options[field.cursor].id;
    if (field.value.has(id)) field.value.delete(id);
    else field.value.add(id);
  }
  return undefined;
}

function editText(field, key) {
  const {value, cursor} = field;
  const put = (text, at) => { field.value = text; field.cursor = at; };
  if (key.name === 'text' || key.name === 'space') {
    const typed = field.filter(key.name === 'space' ? ' ' : key.text);
    put(value.slice(0, cursor) + typed + value.slice(cursor), cursor + typed.length);
  } else if (key.name === 'backspace' && cursor > 0) put(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
  else if (key.name === 'delete') put(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
  else if (key.name === 'left') field.cursor = Math.max(0, cursor - 1);
  else if (key.name === 'right') field.cursor = Math.min(value.length, cursor + 1);
  else if (key.name === 'home') field.cursor = 0;
  else if (key.name === 'end') field.cursor = value.length;
  else if (key.name === 'ctrl-u') put(value.slice(cursor), 0);
  else if (key.name === 'ctrl-w') {
    const from = value.slice(0, cursor).replace(/[^-]*-?$/, '').length;
    put(value.slice(0, from) + value.slice(cursor), from);
  }
  return undefined;
}

// ── Drawing ──────────────────────────────────────────────────────────────

const MARKS = {
  unicode: {on: '◉', off: '○', picked: '●', unpicked: '○'},
  ascii: {on: '[x]', off: '[ ]', picked: '(*)', unpicked: '( )'},
};

// The rows of a form inside its card. `still` draws it as answered: the
// chosen values only, no pointer and no hints.
export function formRows(form, t, {still = false} = {}) {
  const {ink} = t;
  const {G, bold, dim, blue, red, yellow, underline} = ink;
  const marks = ink.caps.ascii ? MARKS.ascii : MARKS.unicode;
  const room = t.bodyRoom();
  const rows = [];
  for (const [at, field] of form.fields.entries()) {
    const focused = !still && at === form.focus;
    const label = focused ? bold(field.label) : dim(field.label);
    const marker = focused ? blue(G.point) : '';
    if (still) {
      rows.push(...flowItems(t, dim(field.label), '', answer(field, ink), room, ink.DOT));
      continue;
    }
    if (field.kind === 'text') {
      const shown = focused ? caretText(field.value, field.cursor) : field.value;
      rows.push(t.cells(label, marker, shown || (focused ? '' : dim('(empty)'))));
    } else {
      const items = field.options.map((option, index) => {
        const chosen = field.kind === 'many' ? field.value.has(option.id) : field.value === option.id;
        const glyph = field.kind === 'many' ? (chosen ? blue(marks.on) : dim(marks.off)) : (chosen ? blue(marks.picked) : dim(marks.unpicked));
        const name = focused && index === field.cursor ? underline(bold(option.label)) : chosen ? option.label : dim(option.label);
        const detail = option.detail ? ` ${option.note ? yellow(option.detail) : dim(option.detail)}` : '';
        return `${glyph} ${name}${detail}`;
      });
      rows.push(...flowItems(t, label, marker, items, room));
    }
    if (focused) {
      const said = form.problem ? {text: form.problem, tone: 'error'} : field.hint?.(field, form);
      if (said?.text) {
        const paint = said.tone === 'error' ? red : said.tone === 'warn' ? yellow : dim;
        rows.push(...t.field('', said.text, paint));
      }
    }
  }
  return rows;
}

// Items along the body, wrapping onto further lines as the width needs.
function flowItems(t, label, marker, items, room, between = '   ') {
  const lines = [];
  let line = '';
  for (const item of items) {
    const next = line ? `${line}${between}${item}` : item;
    if (line && width(next) > room) { lines.push(line); line = item; } else line = next;
  }
  lines.push(line);
  return lines.map((text, i) => t.cells(i === 0 ? label : '', i === 0 ? marker : '', text));
}

// The text with the cursor drawn on the character under it.
const caretText = (value, cursor) => `${value.slice(0, cursor)}\x1b[7m${value[cursor] ?? ' '}\x1b[27m${value.slice(cursor + 1)}`;

// What a field holds, one item a choice. An option's `port` is said in
// place of its detail, which in the form can carry a warning.
function answer(field, ink) {
  if (field.kind === 'text') return [field.value];
  const chosen = field.options.filter(option => (field.kind === 'many' ? field.value.has(option.id) : field.value === option.id));
  if (!chosen.length) return [ink.dim('none')];
  return chosen.map(option => `${option.said ?? option.label}${option.port ?? option.detail ? ` ${ink.dim(option.port ?? option.detail)}` : ''}`);
}

// The keys the form answers, under its card: as many lines as the width
// needs.
export function formKeys(ink, room, {submit = 'create'} = {}) {
  const {bold, dim, caps} = ink;
  const pairs = [[caps.ascii ? 'up/down' : '↑↓', 'field'], [caps.ascii ? 'left/right' : '←→', 'choice'], ['space', 'toggle'], ['enter', submit], ['esc', 'cancel']];
  return keyLines(pairs.map(([key, what]) => `${bold(key)} ${dim(what)}`), room);
}
export function keyLines(items, room) {
  const lines = [];
  for (const item of items) {
    const last = lines.length - 1;
    if (last >= 0 && width(`${lines[last]}   ${item}`) <= room) lines[last] = `${lines[last]}   ${item}`;
    else lines.push(item);
  }
  return lines;
}
