// The terminal UI's drawing: what a terminal can show, the ink, the grid
// every line sits on, and the live region that repaints at the bottom while
// everything above it stays in the scrollback.
//
// Nothing here knows about the engine. `session.mjs` turns its events into
// the pieces drawn here.

// ── What the terminal can show ───────────────────────────────────────────

// Whether the terminal UI draws, or the plain line protocol prints (pipes,
// CI, log files, `TERM=dumb`, `--plain`, and `emulators:exec`, whose test
// command shares the terminal).
export function interactive({stdout = process.stdout, stdin = process.stdin, env = process.env, mode = 'start', plain = false} = {}) {
  if (plain || mode !== 'start') return false;
  if (!stdout.isTTY || !stdin.isTTY) return false;
  if (env.TERM === 'dumb' || truthy(env.CI) || truthy(env.FIRENOOK_PLAIN)) return false;
  return true;
}
const truthy = value => value !== undefined && value !== '' && value !== '0' && value.toLowerCase?.() !== 'false';

// Colours, symbols and links, from the terminal's own variables. NO_COLOR
// keeps the layout and drops the colour. Terminals that cannot draw the
// symbols (the old Windows console outside Windows Terminal, the Linux text
// console, or FIRENOOK_ASCII=1) get plain characters and no links.
export function capabilities({env = process.env, platform = process.platform} = {}) {
  const colour = !('NO_COLOR' in env);
  const truecolour = colour && /truecolor|24bit/i.test(env.COLORTERM ?? '');
  const palette256 = colour && !truecolour && /256/.test(env.TERM ?? '');
  const ascii = truthy(env.FIRENOOK_ASCII) || env.TERM === 'linux' || (platform === 'win32' && !env.WT_SESSION);
  return {colour, truecolour, palette256, ascii, hyperlinks: colour && !ascii};
}

// ── Ink ──────────────────────────────────────────────────────────────────

const GLYPHS = {
  ascii: {ok: '+', fail: 'x', warn: '!', wait: '.', reload: '~', open: '>', help: '?', point: '>', thread: '|', dot: ' - ', more: '...',
    spin: ['|', '/', '-', '\\'], fill: '=', track: '-', h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+', vr: '+', vl: '+', live: '*'},
  unicode: {ok: '✓', fail: '✕', warn: '!', wait: '·', reload: '↻', open: '→', help: '?', point: '›', thread: '│', dot: ' · ', more: '…',
    spin: [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'], fill: '━', track: '─', h: '─', v: '│', tl: '╭', tr: '╮', bl: '╰', br: '╯', vr: '├', vl: '┤', live: '●'},
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;.*?\x1b\\/g;
const SEQUENCE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;.*?\x1b\\/y;
// Characters a terminal draws two columns wide (CJK, full-width forms and
// most emoji), so a line is measured as the terminal lays it out.
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;
const charWidth = char => (WIDE.test(char) ? 2 : 1);

// The columns a line takes on screen.
export function width(text) {
  let columns = 0;
  for (const char of String(text).replace(ANSI, '')) columns += charWidth(char);
  return columns;
}

// The brand's two colours, and the nearest a 256- or 16-colour terminal has.
const INKS = {r: {rgb: [242, 56, 24], of256: 196, of16: 31}, a: {rgb: [255, 152, 0], of256: 214, of16: 33}};

// The mark, traced from brand/mark/firenook-mark-flat.svg on a 10 × 10 grid:
// r is the red flame, a the amber one. Each character cell shows two pixels,
// one above the other, so the pixels come out square, and its five lines
// take the banner's three lines of text exactly in their middle.
const MARK = [
  '......r...',
  '.....rr...',
  '...rrrr...',
  '..rrrr..a.',
  '.rrrr.aaa.',
  'rrrr..aaaa',
  'rrrr.aaaa.',
  '.rr..aaa..',
  '....aaa...',
  '....a.....',
];
export const MARK_WIDTH = MARK[0].length;

export function createInk(caps) {
  const {colour, truecolour, palette256, ascii, hyperlinks} = caps;
  const G = ascii ? GLYPHS.ascii : GLYPHS.unicode;
  const sgr = (open, close) => text => (colour ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
  const ink = {
    caps, G,
    bold: sgr(1, 22), dim: sgr(2, 22), underline: sgr(4, 24),
    green: sgr(32, 39), yellow: sgr(33, 39), red: sgr(31, 39), blue: sgr(34, 39), magenta: sgr(35, 39),
  };
  // OSC 8: the address is clickable where the terminal supports it, and still
  // printed in full where it does not.
  ink.link = (url, text = url) => (hyperlinks ? `\x1b]8;;${url}\x1b\\${ink.underline(ink.blue(text))}\x1b]8;;\x1b\\`
    : colour ? ink.underline(ink.blue(text)) : text);
  ink.DOT = ink.dim(G.dot);
  ink.spinner = () => ink.blue(G.spin[Math.floor(Date.now() / 80) % G.spin.length]);
  // No line is ever wider than its space: a wrapped line would throw off the
  // count of lines the live region repaints. Firenook's own labels are cut
  // with an ellipsis; a developer's text is wrapped instead (see `wrap`).
  ink.fit = (line, room) => {
    if (width(line) <= room) return line;
    let kept = '';
    let seen = 0;
    const more = width(G.more);
    for (let i = 0; i < line.length;) {
      SEQUENCE.lastIndex = i;
      const sequence = SEQUENCE.exec(line);
      if (sequence) {
        kept += sequence[0];
        i += sequence[0].length;
        continue;
      }
      const char = String.fromCodePoint(line.codePointAt(i));
      const columns = charWidth(char);
      if (seen + columns > room - more) {
        kept += G.more;
        break;
      }
      kept += char;
      seen += columns;
      i += char.length;
    }
    return colour ? `${kept}\x1b[0m${hyperlinks ? '\x1b]8;;\x1b\\' : ''}` : kept;
  };
  ink.mark = () => {
    const tone = (key, ground = false) => {
      const {rgb, of256, of16} = INKS[key];
      if (truecolour) return `\x1b[${ground ? 48 : 38};2;${rgb.join(';')}m`;
      if (palette256) return `\x1b[${ground ? 48 : 38};5;${of256}m`;
      return `\x1b[${ground ? of16 + 10 : of16}m`;
    };
    const lines = [];
    for (let y = 0; y < MARK.length; y += 2) {
      let line = '';
      for (let x = 0; x < MARK[y].length; x += 1) {
        const upper = MARK[y][x];
        const lower = MARK[y + 1][x];
        if (upper === '.' && lower === '.') line += ' ';
        else if (!colour) line += upper === '.' ? '▄' : lower === '.' ? '▀' : '█';
        else if (lower === '.') line += `${tone(upper)}▀\x1b[0m`;
        else if (upper === '.') line += `${tone(lower)}▄\x1b[0m`;
        else if (upper === lower) line += `${tone(upper)}█\x1b[0m`;
        else line += `${tone(upper)}${tone(lower, true)}▀\x1b[0m`;
      }
      lines.push(line);
    }
    return lines;
  };
  return ink;
}

// ── Words and numbers ────────────────────────────────────────────────────

export const pad = (text, n) => text + ' '.repeat(Math.max(0, n - width(text)));
export const spread = (left, right, n) => left + ' '.repeat(Math.max(2, n - width(left) - width(right))) + right;
export const count = n => Number(n).toLocaleString('en-US');
export const took = ms => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
export const clock = (date = new Date()) => date.toTimeString().slice(0, 8);
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ${h === 1 ? 'hour' : 'hours'} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

// A developer's text, wrapped at spaces to `room` columns.
export function wrap(text, room) {
  const parts = [];
  for (const paragraph of String(text).replace(/\r/g, '').split('\n')) {
    let rest = paragraph;
    while (width(rest) > room) {
      let cut = cutAt(rest, room);
      const space = rest.lastIndexOf(' ', cut);
      if (space >= cut / 2) cut = space;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ /, '');
    }
    parts.push(rest);
  }
  return parts;
}
// The index at which `text` reaches `room` columns.
function cutAt(text, room) {
  let columns = 0;
  let i = 0;
  for (const char of text) {
    columns += charWidth(char);
    if (columns > room) break;
    i += char.length;
  }
  return Math.max(1, i);
}

// ── The grid ─────────────────────────────────────────────────────────────
// Every line of the page sits on the same columns, inside the card or not:
//
//   ╭────────────────────────────────────────────────╮
//   │  Console     http://127.0.0.1:4000/console     │
//   ╰────────────────────────────────────────────────╯
//   ── Logs ───────────────────────────────────────────
//      16:23:33  ✓ onOrderCreated  142 ms  firestore · orders/A1x9
//   │  │           │ │
//   │  margin      │ body: every line's own text starts here
//   │              marker: ✓ ✕ ! ↻, and the │ that ties output to its function
//   edge: borders and section rules
//
// The margin holds times, labels and the logo; in the card, a service's name
// is a label like Console or Ports, so the card has one left edge. Inside
// the body, a duration and what it measured each keep a column.
export const EDGE = 2;
export const INSET = 5;
export const MARKER = 17;
export const BODY = 19;
export const TOOK = 6;
// The card is never narrower than this, nor wider than the window.
export const CARD = 72;

export function createLayout(ink, size) {
  const {G, dim} = ink;
  const layout = {ink, size};
  // The usable width: two columns of gutter on each side of the window.
  layout.measure = () => Math.max(46, size.columns() - 2);
  // A tall window gets a line of air around each section; a short one gives
  // the air up first, so the logs keep their room.
  layout.roomy = () => size.rows() >= 36;
  layout.space = () => (layout.roomy() ? [''] : []);
  // A line's content from the margin onwards.
  layout.cells = (margin, marker, body) => `${pad(margin, MARKER - INSET)}${marker || ' '} ${body}`;
  // The same content as a line of its own, outside the card.
  layout.open = content => `${' '.repeat(INSET)}${content}`;
  layout.timed = (ms, about) => `${dim((ms == null ? '' : took(ms)).padStart(TOOK))}  ${about}`;
  layout.track = (share, length) => {
    const filled = Math.round(Math.max(0, Math.min(1, share)) * length);
    return `${ink.blue(G.fill.repeat(filled))}${dim(G.track.repeat(length - filled))}`;
  };
  // The card is an object, so it is as wide as what it holds: never less
  // than CARD, never more than the window. `natural` is the width its
  // content asks for.
  let natural = 0;
  let frozen = false;
  layout.claim = text => { if (!frozen) natural = Math.max(natural, width(text)); };
  // Once a card's top border is printed its width cannot change: what comes
  // later and is wider is cut to it.
  layout.freeze = () => { frozen = true; };
  layout.cardWidth = () => Math.min(layout.measure() - EDGE, Math.max(CARD, natural + 6));
  layout.inner = () => layout.cardWidth() - 6;
  layout.bodyRoom = () => layout.inner() - (BODY - INSET);
  layout.top = () => `  ${dim(`${G.tl}${G.h.repeat(layout.cardWidth() - 2)}${G.tr}`)}`;
  layout.bottom = () => `  ${dim(`${G.bl}${G.h.repeat(layout.cardWidth() - 2)}${G.br}`)}`;
  layout.inside = content => `  ${dim(G.v)}  ${pad(ink.fit(content, layout.inner()), layout.inner())}  ${dim(G.v)}`;
  layout.air = () => layout.space().map(layout.inside);
  layout.section = (heading, lines) => [heading, ...layout.air(), ...lines, ...layout.air()];
  layout.divider = (title, right = '') => {
    const tail = right ? width(right) + 4 : 1;
    const fill = Math.max(1, layout.cardWidth() - (width(title) + 4) - tail);
    return `  ${dim(`${G.vr}${G.h}`)} ${title} ${dim(G.h.repeat(fill))}${right ? ` ${right} ${dim(`${G.h}${G.vl}`)}` : dim(G.vl)}`;
  };
  layout.rule = title => `  ${dim(G.h.repeat(2))} ${title} ${dim(G.h.repeat(Math.max(1, layout.measure() - EDGE - width(title) - 4)))}`;
  // Items laid along the body, wrapping onto further lines as the width needs.
  layout.flow = (label, items, room) => {
    const lines = [];
    let line = '';
    for (const item of items) {
      const next = line ? `${line}   ${item}` : item;
      if (line && width(next) > room) {
        lines.push(line);
        line = item;
      } else line = next;
    }
    lines.push(line);
    return lines.map((text, i) => layout.cells(i === 0 ? label : '', '', text));
  };
  // A labelled row whose text wraps under the body column.
  layout.field = (label, text, paint = value => value) =>
    wrap(text, layout.bodyRoom()).map((part, i) => layout.cells(i === 0 ? label : '', '', paint(part)));
  // The log stream's columns: time, marker, name, duration, what it was.
  layout.streamRoom = () => layout.measure() - BODY;
  return layout;
}

// ── The live region ──────────────────────────────────────────────────────
// Lines printed with `emit` stay in the scrollback, so nothing scrolled past
// is ever redrawn; only the few lines of `live` at the bottom repaint. Each
// frame is one synchronized write, so the terminal never shows half of it.
//
// Firenook starts at the top of the window, the way an app does: the shell's
// earlier output scrolls up into the scrollback rather than being erased.
// While `pinned`, the footer sits on the window's last line, and blank lines
// hold the gap until the output reaches it; from then on the output scrolls
// above it.
export function createScreen(out, ink, size) {
  let live = () => [];
  let pinned = false;
  let drawn = 0;
  let shown = '';
  let used = 0;
  let closed = false;
  // Every printed entry keeps the function that drew it, so a resized window
  // can be laid out again at its new size; the newest are enough to fill it.
  const history = [];
  const KEEP = 2000;
  // Lines printed in one burst (a function logging thousands of lines a
  // second) go out together, at most every few milliseconds.
  let pending = [];
  let scheduled;
  const room = () => size.columns() - 2;
  const write = text => { if (!closed) out.write(text); };
  const pad = content => {
    const spare = pinned ? Math.max(0, size.rows() - used - content.length) : 0;
    return [...Array(spare).fill(''), ...content];
  };
  // The live region never takes the whole window: one that did could not
  // be moved back over.
  const current = () => {
    const lines = pad(live());
    const most = Math.max(1, size.rows() - 1);
    return lines.length > most ? lines.slice(lines.length - most) : lines;
  };
  function frame(permanent = []) {
    if (pending.length) {
      permanent = [...pending, ...permanent];
      pending = [];
    }
    clearTimeout(scheduled);
    scheduled = undefined;
    used += permanent.length;
    const lines = current();
    const next = lines.join('\n');
    if (!permanent.length && next === shown) return;
    let text = '\x1b[?2026h';
    // The cursor rests at the end of the live region's last line: a newline
    // after it would scroll a full window by one line on every frame.
    if (drawn) text += `\r${drawn > 1 ? `\x1b[${drawn - 1}A` : ''}\x1b[J`;
    for (const line of permanent) text += `${ink.fit(line, room())}\n`;
    text += lines.map(line => ink.fit(line, room())).join('\n');
    drawn = lines.length;
    shown = next;
    write(`${text}\x1b[?2026l`);
  }
  return {
    begin() {
      write('\x1b[?25l');
      write(`${'\n'.repeat(Math.max(0, size.rows() - 1))}\x1b[H`);
    },
    // Prints lines that stay; `render` is kept to lay them out again later.
    emit(render) {
      history.push(render);
      if (history.length > KEEP) history.splice(0, history.length - KEEP);
      pending.push(...render());
      scheduled ??= setTimeout(() => frame(), 8);
    },
    live(render) {
      live = render;
      frame();
    },
    pin(on = true) { pinned = on; frame(); },
    frame: () => frame(),
    // A resized window is drawn again from the entries: as much of the end as
    // fits, then the live region. Lines already in the scrollback keep the
    // width they were printed at; only a full-screen app avoids that.
    relayout() {
      pending = [];
      const lines = history.flatMap(render => render());
      const keep = Math.max(0, size.rows() - live().length);
      const tail = lines.slice(Math.max(0, lines.length - keep));
      write(`\x1b[?2026h\x1b[H\x1b[J${tail.map(line => `${ink.fit(line, room())}\n`).join('')}\x1b[?2026l`);
      used = tail.length;
      drawn = 0;
      shown = undefined;
      frame();
    },
    // Clears the live region and shows the cursor again, on the line after
    // the last one printed, where the shell's prompt goes.
    end() {
      live = () => [];
      pinned = false;
      frame();
      write('\x1b[?25h');
      closed = true;
    },
    get closed() { return closed; },
  };
}
