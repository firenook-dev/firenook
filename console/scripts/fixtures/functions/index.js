// The synthetic project's one Functions codebase. The foundation's own
// functions are here: `ping` (HTTP) and `echo` (callable). Each stream adds
// its functions in its own file beside this one (`auth.js`, `storage.js`,
// `compute.js`, `messaging.js`, `observe.js`), and FIXTURE_STREAMS (from
// the profile, written to `.env`) says which of them this engine loads —
// every one when it is unset. Two files exporting one name is a mistake
// that would silently hide a function, so it throws, naming both.

const { onCall, onRequest } = require('firebase-functions/v2/https')

const STREAMS = ['auth', 'storage', 'compute', 'messaging', 'observe']

// The starting journey's slow codebase: a busy wait while the module loads,
// so discovery takes this long and the section stays "starting".
const slow = Number(process.env.SLOW_LOAD_MS ?? 0)
if (slow > 0) {
  const until = Date.now() + slow
  while (Date.now() < until) {
    // Busy on purpose: a timer would not hold the load.
  }
}

/** Where each export came from, for the duplicate message. */
const origins = {}

function add(file, functions) {
  for (const [name, value] of Object.entries(functions)) {
    if (Object.hasOwn(origins, name))
      throw new Error(
        `The fixture codebase exports ${name} twice: from ${origins[name]} and from ${file}. Rename one.`,
      )
    origins[name] = file
    exports[name] = value
  }
}

add('index.js', {
  ping: onRequest((request, response) => {
    response.json({ ok: true, method: request.method, path: request.path })
  }),
  echo: onCall((request) => ({ data: request.data, uid: request.auth?.uid ?? null })),
})

const wanted = (process.env.FIXTURE_STREAMS ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)
for (const stream of wanted.length > 0 ? wanted : STREAMS) {
  if (!STREAMS.includes(stream))
    throw new Error(
      `FIXTURE_STREAMS names ${stream}, which has no file; the streams are ${STREAMS.join(', ')}.`,
    )
  add(`${stream}.js`, require(`./${stream}.js`))
}
