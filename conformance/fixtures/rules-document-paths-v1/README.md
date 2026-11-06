# Paths and document names in Security Rules

Independent live capture from the official Firestore emulator 1.22.0, using only
synthetic documents and local callers. The jar, Node, Java and SDK identities are
recorded in `fixture.json`. `passed` means the capture completed, not that every
request succeeded. No production project or consumer data is used.

Each row installs rules that allow one signed-out request only if an expression
holds, and makes it, so 200 means the expression held and 403 that it was false or
an error. `rulesRefused` means the rules did not install.

Observed contracts:

- A document's name is `/databases/{database}/documents/...`, with no project, and
  equal to `request.path`, a path literal, and `path()` of the same text.
  `resource.id` is its last segment. `resource['__name__']`, `resource['id']` and
  `resource['data']` read the same fields.
- A path literal may open an expression (`if /a/b == x`), and `[` ends it, so
  `/a/b[1]` indexes it.
- A path has real segments. `path('a/b')` is equal to `/a/b`: the leading slash is
  optional and always there afterwards. An empty segment is an error.
- Percent escapes are read in a literal and by `path()`, and a bad escape refuses
  the rules or fails the call. `%2F` is a slash inside one segment, so
  `/a%2Fb/c != /a/b/c`, yet `string()` shows it as a slash. An interpolated or bound
  value is not read for escapes.
- `$(value)` is a whole segment, and elsewhere refuses the rules. A string, number,
  bool or null is one segment, a slash included; a path adds its own segments; a
  list or map is an error.
- `path.bind(map)` fills a segment that is exactly `{key}`, with the same values
  except that a path is an error. Every key must be used, and every such segment
  bound.
- A `list` rule that reads `resource.id` or `resource.__name__` denies a query with
  no filter.

`conformance/test/rules-document-paths-replay.test.mjs` replays the capture, with
no differences accepted.

Re-record into a new directory with
`node conformance/src/suite/capture-rules-document-paths.mjs <fresh-directory>`.
