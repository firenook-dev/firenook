// What rules see of paths and document names, as seen by a signed-out caller of
// one document or query under rules that allow it only if an expression holds.
// Shared by the capture and the replay.
export const project = 'demo-firenook-rules-paths';
const documents = `projects/${project}/databases/(default)/documents`;

const here = "'/databases/' + database + '/documents/c/x'";
export const EXPRESSIONS = {
  'is-a-path': "path('a/b') is path",
  'is-not-a-string': "path('a/b') is string",
  'equals-the-same-path': "path('a/b') == path('a/b')",
  'differs-from-another-path': "path('a/b') != path('a/c')",
  'equals-a-literal-with-its-slash': "path('/a/b') == /a/b",
  'equals-a-literal-without-its-slash': "path('a/b') == /a/b",
  'not-equal-to-a-string': "path('a/b') == 'a/b'",
  'string-of-it-keeps-the-text': "string(path('a/b')) == 'a/b'",
  'string-of-it-keeps-the-slash': "string(path('/a/b')) == '/a/b'",
  'first-segment-without-a-slash': "path('a/b')[0] == 'a'",
  'first-segment-with-a-slash': "path('/a/b')[0] == 'a'",
  'last-segment': "path('/a/b')[1] == 'b'",
  'exists-with-it': `exists(path(${here}))`,
  'get-with-it': `get(path(${here})).data.v == 1`,
  'exists-with-a-string-is-an-error': `exists(${here})`,
  'exists-for-a-missing-document': "exists(path('/databases/' + database + '/documents/c/missing'))",
  'equals-the-document-name': `resource.__name__ == path(${here})`,
  'an-integer-is-an-error': 'path(1) is path',
  'a-null-is-an-error': 'path(null) is path',
  'no-argument-is-an-error': 'path() is path',
  'two-arguments-is-an-error': "path('a', 'b') is path",
  'empty-text': "path('') is path",
  'a-doubled-slash': "path('a//b') is path",
  'a-trailing-slash': "path('a/b/') == path('a/b')",
  'a-trailing-slash-alone': "path('a/b/') is path",
  'the-root-alone': "path('/') is path",
  'two-leading-slashes': "path('//a') is path",
  'a-space-in-a-segment': "path('a b/c') == /a%20b/c",
  'a-space-is-kept': "path('a b/c')[0] == 'a b'",
  'a-single-segment': "path('a') == /a",
  'an-odd-number-of-segments-reads-too': `path('/databases/' + database + '/documents/c')[4] == 'c'`,
  'a-leading-slash-is-kept': "path('/a/b') == path('a/b')",
  'an-interpolated-literal': "/a/$('b') == path('/a/b')",
  'interpolating-a-string-in-a-literal': "/a/$('b') == /a/b",
  'interpolating-a-string-function': "/a/$(string(1)) == /a/1",
  'interpolating-an-index': "/a/$(['b'][0]) == /a/b",
  'interpolating-a-map-key': "/a/$({'k': 'b'}['k']) == /a/b",
  'the-name-against-a-literal': '/databases/$(database)/documents/c/x == resource.__name__',
  'the-name-against-a-literal-reversed': 'resource.__name__ == /databases/$(database)/documents/c/x',
  'the-name-against-the-request-path': 'resource.__name__ == request.path',
  'the-name-is-a-path': 'resource.__name__ is path',
  'the-name-as-a-string': "string(resource.__name__) == '/databases/' + database + '/documents/c/x'",
  'the-name-with-a-project': "string(resource.__name__) == '/projects/demo-firenook-rules-paths/databases/' + database + '/documents/c/x'",
  'the-name-first-segment-databases': "resource.__name__[0] == 'databases'",
  'the-name-first-segment-projects': "resource.__name__[0] == 'projects'",
  'the-name-last-segment': "resource.__name__[4] == 'x'",
  'the-request-path-as-a-string': "string(request.path) == '/databases/' + database + '/documents/c/x'",
  'the-request-path-with-a-project': "string(request.path) == '/projects/demo-firenook-rules-paths/databases/' + database + '/documents/c/x'",
  'a-percent-escape-is-read-in-a-literal': "/a%20b/c[0] == 'a b'",
  'a-percent-escape-is-kept-as-text': "/a%20b/c[0] == 'a%20b'",
  'a-percent-escape-in-string-of-a-literal': "string(/a%20b/c) == '/a%20b/c'",
  'a-space-in-string-of-a-literal': "string(/a%20b/c) == '/a b/c'",
  'a-percent-escape-through-path': "path('a%20b/c')[0] == 'a%20b'",
  'a-percent-escape-through-path-is-read': "path('a%20b/c')[0] == 'a b'",
  'string-of-a-spaced-path': "string(path('a b/c')) == '/a b/c'",
  'string-of-a-spaced-path-encoded': "string(path('a b/c')) == '/a%20b/c'",
  'a-slash-escape-in-a-literal': "/a%2Fb/c[0] == 'a/b'",
  'the-name-by-index': "resource['__name__'] == /databases/$(database)/documents/c/x",
  'string-of-a-slash-escape-read': "string(/a%2Fb/c) == '/a/b/c'",
  'string-of-a-slash-escape-kept': "string(/a%2Fb/c) == '/a%2Fb/c'",
  'a-slash-escape-equals-two-segments': '/a%2Fb/c == /a/b/c',
  'a-slash-escape-through-path': "path('a%2Fb/c')[0] == 'a/b'",
  'interpolated-slash-one-segment': "/a/$('b/c')[1] == 'b/c'",
  'interpolated-slash-two-segments': "/a/$('b/c')[2] == 'c'",
  'interpolated-slash-equals': "/a/$('b/c') == /a/b/c",
  'interpolated-escape-kept': "/a/$('b%20c')[1] == 'b%20c'",
  'interpolated-escape-read': "/a/$('b%20c')[1] == 'b c'",
  'a-bad-escape-through-path': "path('a%zz') is path",
  'a-bad-escape-kept-through-path': "path('a%zz')[0] == 'a%zz'",
  'a-bad-escape-in-a-literal': '/a%zz/c is path',
  'a-literal-right-after-if': '/a/b is path',
  'a-dot-in-a-literal': "/a/b.c[1] == 'b.c'",
  'an-interpolation-then-index': "/a/$('b')[1] == 'b'",
  'a-literal-indexed': "/a/b[1] == 'b'",
  'a-literal-range': '/a/b/c[1:3] == /b/c',
  'a-path-range': "path('/a/b/c')[1:3] == /b/c",
  'bind-through-path': "path('/a/{x}/c').bind({'x': 'b'}) == /a/b/c",
  'bind-on-a-literal': "/a/{x}/c.bind({'x': 'b'}) == /a/b/c",
  'bind-an-integer': "path('/a/{x}/c').bind({'x': 1}) == /a/1/c",
  'bind-a-missing-key': "path('/a/{x}/c').bind({'y': 'b'}) is path",
  'bind-a-missing-key-keeps-it': "string(path('/a/{x}/c').bind({'y': 'b'})) == '/a/{x}/c'",
  'bind-an-extra-key': "path('/a/{x}/c').bind({'x': 'b', 'y': 'd'}) == /a/b/c",
  'bind-part-of-a-segment': "path('/a/p{x}q/c').bind({'x': 'b'}) == /a/pbq/c",
  'bind-part-of-a-segment-kept': "string(path('/a/p{x}q/c').bind({'x': 'b'})) == '/a/p{x}q/c'",
  'bind-two-keys': "path('/{x}/{y}').bind({'x': 'a', 'y': 'b'}) == /a/b",
  'bind-a-slash-value': "path('/a/{x}').bind({'x': 'b/c'})[1] == 'b/c'",
  'bind-a-path-value': "path('/a/{x}').bind({'x': path('b/c')}) == /a/b/c",
  'bind-nothing': "path('/a/b').bind({}) == /a/b",
  'bind-a-non-map': "path('/a/{x}').bind('b') is path",
  'bind-on-the-request-path': 'request.path.bind({}) == request.path',
  'a-size-of-a-path': "path('/a/b').size() == 2",
  'interpolating-a-path': "/a/$(path('b/c')) == /a/b/c",
  'interpolating-a-path-segment': "/a/$(path('b/c'))[2] == 'c'",
  'interpolating-a-literal': '/a/$(/b/c) == /a/b/c',
  'interpolating-an-integer': '/a/$(1) == /a/1',
  'interpolating-a-bool-is-an-error': '/a/$(true) is path',
  'interpolating-the-request-path': '/a/$(request.path)[1] == request.path[0]',
  'interpolating-inside-a-segment': "/a/p$('b')q == /a/pbq",
  'interpolating-an-empty-string': "/a/$('')/c is path",
  'interpolating-a-bool-reads-as-text': "/a/$(true)[1] == 'true'",
  'interpolating-a-float': '/a/$(1.5) is path',
  'interpolating-a-float-reads-as-text': "/a/$(1.5)[1] == '1.5'",
  'interpolating-a-null': '/a/$(null) is path',
  'interpolating-a-list': '/a/$([1]) is path',
  'interpolating-a-map': "/a/$({'k': 1}) is path",
  'bind-a-bool': "path('/a/{x}').bind({'x': true})[1] == 'true'",
  'bind-a-float': "path('/a/{x}').bind({'x': 1.5})[1] == '1.5'",
  'bind-a-null': "path('/a/{x}').bind({'x': null}) is path",
  'bind-a-list': "path('/a/{x}').bind({'x': [1]}) is path",
  'bind-a-recursive-template': "path('/a/{x=**}').bind({'x': 'b'}) is path",
  'bind-keeps-spaces': "path('/a/{x}').bind({'x': 'b c'})[1] == 'b c'",
  'bind-does-not-read-an-escape': "path('/a/{x}').bind({'x': 'b%20c'})[1] == 'b%20c'",
  'the-name-by-index-is-a-path': "resource['__name__'] is path",
  'the-id-by-index': "resource['id'] == 'x'",
  'the-data-by-index': "resource['data'].v == 1",
  'the-id': "resource.id == 'x'",
  'the-id-is-a-string': 'resource.id is string',
  'the-id-of-a-get': `get(path(${here})).id == 'x'`,
  'the-name-of-a-get': `get(path(${here})).__name__ == path(${here})`,
  'the-id-against-a-wildcard': 'resource.id == id',
  'a-literal-in-parentheses': '(/a/b) == /a/b',
  'a-literal-negated-equal': '/a/b != /a/c',
  'a-literal-in-a-list': '/a/b in [/a/b]',
};

// Each runs under `allow list` for a query with no filter.
export const LISTS = {
  'list-the-id': "resource.id == 'x'",
  'list-the-id-differs': "resource.id != 'nope'",
  'list-the-id-is-a-string': 'resource.id is string',
  'list-the-name-is-a-path': 'resource.__name__ is path',
  'list-the-name-equals': 'resource.__name__ == /databases/$(database)/documents/c/x',
  'list-the-name-by-index': "resource['__name__'] is path",
  'list-the-id-by-index': "resource['id'] is string",
};

// Each runs under `allow create` for the document c/new.
export const CREATES = {
  'create-the-id': "request.resource.id == 'new'",
  'create-the-id-is-a-string': 'request.resource.id is string',
  'create-the-name': 'request.resource.__name__ == /databases/$(database)/documents/c/new',
  'create-the-name-by-index': "request.resource['__name__'] == /databases/$(database)/documents/c/new",
  'create-the-name-against-the-request-path': 'request.resource.__name__ == request.path',
};

const rulesFor = (expression, allow = 'get') => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /c/{id} { allow ${allow}: if ${expression}; }
  }
}
`;

export const observe = async (host, log = () => {}) => {
  const owner = { authorization: 'Bearer owner', 'content-type': 'application/json' };
  const seeded = await fetch(`http://${host}/v1/${documents}/c/x`, {
    method: 'PATCH', headers: owner, body: JSON.stringify({ fields: { v: { integerValue: '1' } } }),
  });
  if (!seeded.ok) throw new Error(`seed failed: ${seeded.status} ${await seeded.text()}`);
  const answers = {};
  const install = (source) => fetch(`http://${host}/emulator/v1/projects/${project}:securityRules`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: source }] } }),
  });
  const row = async (id, source, act) => {
    const installed = await install(source);
    if (!installed.ok) {
      answers[id] = { rulesRefused: installed.status };
      log(`${id}: rules refused ${installed.status}`);
      return;
    }
    const answered = await act();
    answers[id] = { status: answered.status };
    log(`${id}: ${answered.status}`);
  };
  for (const [id, expression] of Object.entries(EXPRESSIONS)) {
    await row(id, rulesFor(expression), () => fetch(`http://${host}/v1/${documents}/c/x`));
  }
  for (const [id, expression] of Object.entries(LISTS)) {
    await row(id, rulesFor(expression, 'list'), () => fetch(`http://${host}/v1/${documents}/c`));
  }
  for (const [id, expression] of Object.entries(CREATES)) {
    await row(id, rulesFor(expression, 'create'), async () => {
      const created = await fetch(`http://${host}/v1/${documents}/c?documentId=new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fields: { v: { integerValue: '2' } } }),
      });
      await fetch(`http://${host}/v1/${documents}/c/new`, { method: 'DELETE', headers: owner });
      return created;
    });
  }
  return { answers };
};
