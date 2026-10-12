// What the rules language provides, as completion knows it: the request
// and resource variables, the global functions and namespaces, and the
// methods of each type, with their signatures and a line or two from the
// Security Rules reference. Two dialects share it: Cloud Firestore's
// (`service cloud.firestore`, documents) and Firebase Storage's
// (`service firebase.storage`, objects, `firestore.get()`); the entries that
// belong to one dialect only say so in their names.
//
// Plain data, so the completion source can be read as logic and this file
// checked against the reference on its own.

/** Which service's rules a text is: the `service` header decides, or the page says. */
export type RulesDialect = 'firestore' | 'storage'

/** A type as far as completion follows it. */
export type Kind =
  | 'request'
  | 'auth'
  | 'token'
  | 'firebase'
  | 'query'
  | 'resource'
  | 'data'
  | 'map'
  | 'mapDiff'
  | 'set'
  | 'list'
  | 'string'
  | 'timestamp'
  | 'duration'
  | 'latlng'
  | 'bytes'
  | 'path'
  | 'int'
  | 'float'
  | 'number'
  | 'bool'
  | 'null'
  | 'unknown'
  | 'ns:math'
  | 'ns:timestamp'
  | 'ns:duration'
  | 'ns:latlng'
  | 'ns:hashing'
  /** Storage: a file, as `resource` and `request.resource` are. */
  | 'object'
  /** Storage: a file's custom metadata. */
  | 'metadata'
  /** Storage: `firestore.get()` and `firestore.exists()`. */
  | 'ns:firestore'

export interface Entry {
  name: string
  /** What it takes, when it is called; null for a property. */
  params: readonly string[] | null
  returns: Kind
  info: string
}

function fn(name: string, params: readonly string[], returns: Kind, info: string): Entry {
  return { name, params, returns, info }
}

function prop(name: string, returns: Kind, info: string): Entry {
  return { name, params: null, returns, info }
}

const SHOWN: Partial<Record<Kind, string>> = {
  request: 'Request',
  auth: 'map',
  token: 'map',
  firebase: 'map',
  query: 'map',
  resource: 'Resource',
  data: 'map',
  object: 'Object',
  metadata: 'map',
  mapDiff: 'MapDiff',
  unknown: 'any',
}

/** How a type reads in a signature. */
export function showKind(kind: Kind): string {
  return SHOWN[kind] ?? kind
}

/** `(re) → bool` for something called, `string` for a property. */
export function signature(entry: Entry): string {
  const returns = showKind(entry.returns)
  return entry.params ? `(${entry.params.join(', ')}) → ${returns}` : returns
}

export const PROPERTIES: Partial<Record<Kind, readonly Entry[]>> = {
  request: [
    prop(
      'auth',
      'auth',
      'The signed-in user: their uid and token claims. null when the request is not authenticated.',
    ),
    prop('method', 'string', "The operation: 'get', 'list', 'create', 'update' or 'delete'."),
    prop('path', 'path', 'The path of the affected resource.'),
    prop(
      'query',
      'query',
      'Properties of the query, when there is one: limit, offset and orderBy.',
    ),
    prop(
      'resource',
      'resource',
      'The document as it would be after the write. Present on write requests only.',
    ),
    prop(
      'time',
      'timestamp',
      'When the service received the request. In a write that sets a server timestamp, equal to it.',
    ),
  ],
  auth: [
    prop('uid', 'string', 'The UID of the requesting user.'),
    prop('token', 'token', "A map of the user's ID token claims."),
  ],
  token: [
    prop('email', 'string', 'The email address associated with the account, if present.'),
    prop(
      'email_verified',
      'bool',
      'true if the user has verified they have access to the email address.',
    ),
    prop('phone_number', 'string', 'The phone number associated with the account, if present.'),
    prop('name', 'string', "The user's display name, if set."),
    prop('sub', 'string', "The user's Firebase UID, unique within the project."),
    prop(
      'firebase.sign_in_provider',
      'string',
      "The sign-in provider that issued the token, such as 'password', 'phone', 'anonymous', 'custom' or 'google.com'.",
    ),
    prop(
      'firebase.identities',
      'map',
      "The account's identities: a map from provider (email, phone, google.com, …) to a list of identifiers.",
    ),
    prop('firebase.tenant', 'string', 'The tenant ID associated with the account, if present.'),
    prop('iat', 'int', 'When the ID token was issued, in seconds since the Unix epoch.'),
    prop('exp', 'int', 'When the ID token expires, in seconds since the Unix epoch.'),
    prop('auth_time', 'int', 'When the user authenticated, in seconds since the Unix epoch.'),
  ],
  firebase: [
    prop(
      'sign_in_provider',
      'string',
      "The sign-in provider that issued the token, such as 'password', 'phone', 'anonymous', 'custom' or 'google.com'.",
    ),
    prop(
      'identities',
      'map',
      "The account's identities: a map from provider (email, phone, google.com, …) to a list of identifiers.",
    ),
    prop('tenant', 'string', 'The tenant ID associated with the account, if present.'),
  ],
  query: [
    prop('limit', 'int', 'The limit clause of the query.'),
    prop('offset', 'int', 'The offset clause of the query.'),
    prop('orderBy', 'unknown', 'The orderBy clause of the query.'),
  ],
  resource: [
    prop('data', 'data', "The document's fields, as a map."),
    prop('id', 'string', "The document's ID: the last segment of its path."),
    prop('__name__', 'path', 'The full document name, as a path.'),
  ],
}

/** Storage's `request`: no query, and `resource` is the file being written. */
export const STORAGE_REQUEST: readonly Entry[] = [
  prop(
    'auth',
    'auth',
    'The signed-in user: their uid and token claims. null when the request is not authenticated.',
  ),
  prop(
    'method',
    'string',
    "The operation: 'get', 'list', 'create', 'update' or 'delete'. An upload is a create, even over an existing file.",
  ),
  prop('path', 'path', 'The path of the file or folder the request is about.'),
  prop(
    'resource',
    'object',
    'The file as it would be after the write: its size, contentType and metadata. Present on create and update only.',
  ),
  prop('time', 'timestamp', 'When the service received the request.'),
]

/** A Storage file as the rules see it: the fourteen keys `resource` and `request.resource` carry. */
export const STORAGE_OBJECT: readonly Entry[] = [
  prop('name', 'string', 'The full name of the file, its path in the bucket: users/u1/avatar.png.'),
  prop('bucket', 'string', 'The bucket the file is in.'),
  prop('size', 'int', 'The size of the file in bytes.'),
  prop(
    'contentType',
    'string',
    "The file's content type, such as 'image/png'. Check it with matches('image/.*').",
  ),
  prop('contentDisposition', 'string', "The file's Content-Disposition, if set."),
  prop('contentEncoding', 'string', "The file's Content-Encoding, if set, such as 'gzip'."),
  prop(
    'metadata',
    'metadata',
    "The file's custom metadata: a map of the string keys and values your app set.",
  ),
  prop('generation', 'int', "The file's generation: it changes each time the bytes are replaced."),
  prop(
    'metageneration',
    'int',
    "The file's metageneration: it changes each time the metadata changes.",
  ),
  prop('timeCreated', 'timestamp', 'When the file was created.'),
  prop('updated', 'timestamp', 'When the file was last changed.'),
  prop('md5Hash', 'string', 'The MD5 hash of the bytes, base64.'),
  prop('crc32c', 'string', 'The CRC32C checksum of the bytes.'),
  prop('etag', 'string', "The file's ETag."),
]

export const METHODS: Partial<Record<Kind, readonly Entry[]>> = {
  string: [
    fn('size', [], 'int', 'The number of characters in the string.'),
    fn('matches', ['re'], 'bool', 'Whether the whole string matches the RE2 regular expression.'),
    fn('lower', [], 'string', 'The string in lowercase.'),
    fn('upper', [], 'string', 'The string in uppercase.'),
    fn(
      'split',
      ['re'],
      'list',
      'Splits the string at each match of the RE2 regular expression, giving a list of strings.',
    ),
    fn('trim', [], 'string', 'The string with leading and trailing spaces removed.'),
    fn(
      'replace',
      ['re', 'sub'],
      'string',
      'Replaces every match of the RE2 regular expression with sub.',
    ),
    fn('toUtf8', [], 'bytes', 'The UTF-8 encoding of the string, as bytes.'),
  ],
  list: [
    fn(
      'concat',
      ['list'],
      'list',
      'A new list with the elements of the given list added at the end.',
    ),
    fn('hasAll', ['list'], 'bool', 'Whether the list contains every element of the given list.'),
    fn('hasAny', ['list'], 'bool', 'Whether the list contains any element of the given list.'),
    fn(
      'hasOnly',
      ['list'],
      'bool',
      'Whether every element of the list is present in the given list.',
    ),
    fn(
      'join',
      ['separator'],
      'string',
      'The elements joined into one string, with the separator between them.',
    ),
    fn('removeAll', ['list'], 'list', 'A new list without any of the elements of the given list.'),
    fn('size', [], 'int', 'The number of values in the list.'),
    fn('toSet', [], 'set', 'A set of the unique elements of the list.'),
  ],
  map: [
    fn(
      'diff',
      ['map'],
      'mapDiff',
      'Compares this map with the given one. The result lists the keys added, removed, changed or left unchanged.',
    ),
    fn(
      'get',
      ['key', 'default'],
      'unknown',
      "The value at key, or default when the map has no such key. A list key such as ['a', 'b'] looks inside nested maps.",
    ),
    fn('keys', [], 'list', 'The keys of the map, as a list.'),
    fn('size', [], 'int', 'The number of entries in the map.'),
    fn('values', [], 'list', 'The values of the map, as a list.'),
  ],
  mapDiff: [
    fn(
      'addedKeys',
      [],
      'set',
      'Keys in the map that called diff() that the map passed to it does not have.',
    ),
    fn(
      'affectedKeys',
      [],
      'set',
      'Keys added, removed or changed: the union of addedKeys(), removedKeys() and changedKeys().',
    ),
    fn('changedKeys', [], 'set', 'Keys in both maps whose values are not equal.'),
    fn(
      'removedKeys',
      [],
      'set',
      'Keys in the map passed to diff() that the map that called it does not have.',
    ),
    fn('unchangedKeys', [], 'set', 'Keys in both maps whose values are equal.'),
  ],
  set: [
    fn('difference', ['set'], 'set', 'The elements of this set that are not in the given set.'),
    fn(
      'hasAll',
      ['list'],
      'bool',
      'Whether this set contains every item of the given set or list.',
    ),
    fn('hasAny', ['list'], 'bool', 'Whether this set contains any item of the given set or list.'),
    fn(
      'hasOnly',
      ['list'],
      'bool',
      'Whether this set contains only items of the given set or list.',
    ),
    fn('intersection', ['set'], 'set', 'The elements this set and the given set have in common.'),
    fn('size', [], 'int', 'The number of values in the set.'),
    fn('union', ['set'], 'set', 'Every element of this set and of the given set.'),
  ],
  timestamp: [
    fn('date', [], 'timestamp', 'The timestamp with only its year, month and day.'),
    fn('day', [], 'int', 'The day of the month, in UTC.'),
    fn('dayOfWeek', [], 'int', 'The day of the week, from 1 to 7, in UTC.'),
    fn('dayOfYear', [], 'int', 'The day of the year, from 1 to 366, in UTC.'),
    fn('hours', [], 'int', 'The hours value of the timestamp, in UTC.'),
    fn('minutes', [], 'int', 'The minutes value of the timestamp.'),
    fn('month', [], 'int', 'The month value of the timestamp, in UTC.'),
    fn('nanos', [], 'int', 'The nanoseconds value of the timestamp.'),
    fn('seconds', [], 'int', 'The seconds value of the timestamp.'),
    fn('time', [], 'duration', 'The time-of-day portion of the timestamp, as a duration.'),
    fn('toMillis', [], 'int', 'Milliseconds since the Unix epoch.'),
    fn('year', [], 'int', 'The year value of the timestamp, in UTC.'),
  ],
  duration: [
    fn(
      'nanos',
      [],
      'int',
      'The signed nanoseconds portion of the duration, from -999,999,999 to +999,999,999.',
    ),
    fn(
      'seconds',
      [],
      'int',
      'The signed seconds portion of the duration, from -315,576,000,000 to +315,576,000,000.',
    ),
  ],
  latlng: [
    fn('distance', ['other'], 'float', 'The distance to the other point, in meters.'),
    fn('latitude', [], 'float', 'The latitude, from -90 to 90.'),
    fn('longitude', [], 'float', 'The longitude, from -180 to 180.'),
  ],
  bytes: [
    fn('size', [], 'int', 'The number of bytes.'),
    fn('toBase64', [], 'string', 'The bytes as a base64url-encoded string.'),
    fn('toHexString', [], 'string', 'The bytes as a hexadecimal string.'),
  ],
  path: [fn('bind', ['map'], 'path', "Binds the map's key-value pairs to the path's variables.")],
}

/** A map's methods also apply to these, which are maps underneath. */
export const MAP_LIKE: ReadonlySet<Kind> = new Set(['map', 'data', 'token', 'firebase', 'metadata'])

/**
 * Methods of several types under one name, described for all of them, for
 * a receiver whose type is not known.
 */
const SHARED: readonly Entry[] = [
  fn(
    'size',
    [],
    'int',
    'The number of characters in a string, values in a list or set, entries in a map, or bytes.',
  ),
  fn(
    'hasAll',
    ['list'],
    'bool',
    'Whether a list or set contains every element of the given list or set.',
  ),
  fn(
    'hasAny',
    ['list'],
    'bool',
    'Whether a list or set contains any element of the given list or set.',
  ),
  fn(
    'hasOnly',
    ['list'],
    'bool',
    'Whether every element of a list or set is present in the given list or set.',
  ),
  fn(
    'nanos',
    [],
    'int',
    'The nanoseconds value of a timestamp, or the signed nanoseconds portion of a duration.',
  ),
  fn(
    'seconds',
    [],
    'int',
    'The seconds value of a timestamp, or the signed seconds portion of a duration.',
  ),
]

const GENERIC_ORDER: readonly Kind[] = [
  'string',
  'list',
  'map',
  'mapDiff',
  'set',
  'timestamp',
  'duration',
  'latlng',
  'bytes',
  'path',
]

export interface GenericMethod {
  entry: Entry
  /** The types that have it. */
  owners: Kind[]
}

/** Every method of every type once, for a receiver whose type is not known. */
export const GENERIC_METHODS: readonly GenericMethod[] = (() => {
  const byName = new Map<string, GenericMethod>()
  for (const kind of GENERIC_ORDER)
    for (const entry of METHODS[kind] ?? []) {
      const seen = byName.get(entry.name)
      if (seen) seen.owners.push(kind)
      else
        byName.set(entry.name, {
          entry: SHARED.find((shared) => shared.name === entry.name) ?? entry,
          owners: [kind],
        })
    }
  return [...byName.values()]
})()

export const NAMESPACE_FUNCTIONS: Partial<Record<Kind, readonly Entry[]>> = {
  'ns:math': [
    fn('abs', ['num'], 'number', 'The absolute value of a number.'),
    fn('ceil', ['num'], 'int', 'The number rounded up to an integer.'),
    fn('floor', ['num'], 'int', 'The number rounded down to an integer.'),
    fn('round', ['num'], 'int', 'The number rounded to the nearest integer.'),
    fn('sqrt', ['num'], 'float', 'The square root of a number.'),
    fn('pow', ['base', 'exponent'], 'float', 'base raised to the power of exponent.'),
    fn('isInfinite', ['num'], 'bool', 'Whether the number is positive or negative infinity.'),
    fn('isNaN', ['num'], 'bool', 'Whether the value is not a number (NaN).'),
  ],
  'ns:timestamp': [
    fn(
      'date',
      ['year', 'month', 'day'],
      'timestamp',
      'A timestamp at the start of the given day, in UTC.',
    ),
    fn(
      'value',
      ['epochMillis'],
      'timestamp',
      'A timestamp from milliseconds since the Unix epoch.',
    ),
  ],
  'ns:duration': [
    fn('abs', ['duration'], 'duration', 'The absolute value of a duration.'),
    fn(
      'time',
      ['hours', 'mins', 'secs', 'nanos'],
      'duration',
      'A duration from hours, minutes, seconds and nanoseconds.',
    ),
    fn(
      'value',
      ['magnitude', 'unit'],
      'duration',
      "A duration from a magnitude and a unit: 'w', 'd', 'h', 'm', 's', 'ms' or 'ns'.",
    ),
  ],
  'ns:latlng': [
    fn('value', ['lat', 'lng'], 'latlng', 'A geopoint from a latitude and a longitude.'),
  ],
  'ns:firestore': [
    fn(
      'get',
      ['path'],
      'resource',
      'The Firestore document at path, or null if it does not exist. Each call is a billed document read.',
    ),
    fn(
      'exists',
      ['path'],
      'bool',
      'Whether a Firestore document exists at path. Each call is a billed document read.',
    ),
  ],
  'ns:hashing': [
    fn(
      'crc32',
      ['bytes_or_string'],
      'bytes',
      'The CRC32 hash, as bytes. A string is hashed as UTF-8.',
    ),
    fn(
      'crc32c',
      ['bytes_or_string'],
      'bytes',
      'The CRC32C hash, as bytes. A string is hashed as UTF-8.',
    ),
    fn('md5', ['bytes_or_string'], 'bytes', 'The MD5 hash, as bytes. A string is hashed as UTF-8.'),
    fn(
      'sha256',
      ['bytes_or_string'],
      'bytes',
      'The SHA-256 hash, as bytes. A string is hashed as UTF-8.',
    ),
  ],
}

export const GLOBAL_FUNCTION_ENTRIES: readonly Entry[] = [
  fn(
    'get',
    ['path'],
    'resource',
    'The document at path as it is before this request, or null if it does not exist.',
  ),
  fn('exists', ['path'], 'bool', 'Whether a document exists at path.'),
  fn(
    'getAfter',
    ['path'],
    'resource',
    'The document at path as it would be if this request succeeded. For checking batched writes and transactions.',
  ),
  fn(
    'existsAfter',
    ['path'],
    'bool',
    'Whether a document would exist at path if this request succeeded; the same as getAfter(path) != null.',
  ),
  fn(
    'debug',
    ['value'],
    'unknown',
    "Returns value unchanged, and writes it to the emulator's debug log. Has no effect in production.",
  ),
  fn('int', ['value'], 'int', 'Converts a string or a float to an integer.'),
  fn('float', ['value'], 'float', 'Converts a string or an integer to a float.'),
  fn('string', ['value'], 'string', 'Converts a boolean, integer, float or null to a string.'),
  fn('bool', ['value'], 'bool', "Converts the string 'true' or 'false' to a boolean."),
  fn('path', ['value'], 'path', 'Converts a string to a path.'),
]

/** Functions that take a document path, for which completion writes one out. */
export const DOCUMENT_FUNCTIONS: ReadonlySet<string> = new Set([
  'get',
  'exists',
  'getAfter',
  'existsAfter',
])

/** The two variables of Storage rules. */
export const STORAGE_VARIABLES: readonly Entry[] = [
  prop(
    'request',
    'request',
    'The incoming request: its auth, method, path, time and, for an upload or a metadata change, the file it proposes (resource).',
  ),
  prop(
    'resource',
    'object',
    'The file as it is before the request: absent on an upload of a new file.',
  ),
]

/** Storage rules reach Firestore through this namespace. */
export const FIRESTORE_NAMESPACE: Entry = prop(
  'firestore',
  'ns:firestore',
  "Reads from the project's Firestore: get and exists.",
)

export const GLOBAL_VARIABLES: readonly Entry[] = [
  prop(
    'request',
    'request',
    'The incoming request: its auth, method, path, query, resource (the data being written) and time.',
  ),
  prop('resource', 'resource', 'The document being read or written, as it is before the request.'),
]

export const NAMESPACE_ENTRIES: readonly Entry[] = [
  prop(
    'math',
    'ns:math',
    'Mathematical functions: abs, ceil, floor, round, sqrt, pow, isInfinite, isNaN.',
  ),
  prop('timestamp', 'ns:timestamp', 'Functions that make timestamps: date and value.'),
  prop('duration', 'ns:duration', 'Functions that make durations: abs, time and value.'),
  prop('latlng', 'ns:latlng', 'The value function, which makes a geopoint.'),
  prop('hashing', 'ns:hashing', 'Hash functions: crc32, crc32c, md5 and sha256.'),
]

export const LITERALS: readonly Entry[] = [
  prop('true', 'bool', 'The boolean true.'),
  prop('false', 'bool', 'The boolean false.'),
  prop('null', 'null', 'The null value.'),
]

/** The types `is` can test for. */
export const TYPE_NAMES: readonly Entry[] = [
  prop('bool', 'bool', 'true or false.'),
  prop('int', 'int', 'A signed 64-bit integer.'),
  prop('float', 'float', 'A 64-bit IEEE floating point number.'),
  prop('number', 'number', 'An int or a float.'),
  prop('string', 'string', 'A string.'),
  prop('list', 'list', 'A list of values, not necessarily of one type.'),
  prop('map', 'map', 'A map from string keys to values.'),
  prop('timestamp', 'timestamp', 'A timestamp in UTC, with nanosecond accuracy.'),
  prop('duration', 'duration', 'A duration, with nanosecond accuracy.'),
  prop('path', 'path', 'A path to a resource.'),
  prop('latlng', 'latlng', 'A geopoint: a latitude and a longitude.'),
]

export const OPERATION_ENTRIES: readonly { name: string; detail: string; info: string }[] = [
  {
    name: 'read',
    detail: 'get + list',
    info: 'Any read: fetching one document or running a query.',
  },
  {
    name: 'write',
    detail: 'create + update + delete',
    info: 'Any write: creating, updating or deleting a document.',
  },
  { name: 'get', detail: 'read', info: 'Fetching a single document.' },
  { name: 'list', detail: 'read', info: 'Running a query, or listing a collection.' },
  { name: 'create', detail: 'write', info: 'Writing a document that does not exist yet.' },
  { name: 'update', detail: 'write', info: 'Writing to a document that already exists.' },
  { name: 'delete', detail: 'write', info: 'Deleting a document.' },
]

/** What each operation means for files. */
export const STORAGE_OPERATION_ENTRIES: readonly { name: string; detail: string; info: string }[] =
  [
    {
      name: 'read',
      detail: 'get + list',
      info: 'Any read: downloading a file, reading its metadata, or listing a folder.',
    },
    {
      name: 'write',
      detail: 'create + update + delete',
      info: 'Any write: uploading a file, changing its metadata, or deleting it.',
    },
    {
      name: 'get',
      detail: 'read',
      info: 'Downloading a file or reading its metadata: getBytes(), getDownloadURL(), getMetadata().',
    },
    {
      name: 'list',
      detail: 'read',
      info: "Listing a folder: list() and listAll(). Needs rules_version = '2'.",
    },
    {
      name: 'create',
      detail: 'write',
      info: 'Uploading a file, including an upload over a file that already exists.',
    },
    { name: 'update', detail: 'write', info: "Changing a file's metadata: updateMetadata()." },
    { name: 'delete', detail: 'write', info: 'Deleting a file.' },
  ]

/** Storage's own wording for the keywords whose meaning changes with the service. */
export const STORAGE_KEYWORD_INFO: Readonly<Record<string, string>> = {
  service: 'Declares the product these rules secure: firebase.storage for Cloud Storage.',
  match:
    'Declares a path pattern; its rules apply to the files it matches. {name} binds one segment, {name=**} the rest of the path.',
}

export const KEYWORD_INFO: Readonly<Record<string, string>> = {
  rules_version:
    "Selects the rules language version. Without it the version 1 engine applies; '2' is the current version.",
  service: 'Declares the product these rules secure: cloud.firestore for Firestore.',
  match:
    'Declares a path pattern; its rules apply to the documents it matches. {name} binds one segment, {name=**} the rest of the path.',
  allow: 'Grants the listed operations when the condition holds. One matching allow is enough.',
  function:
    'Declares a function, callable in its block and in the blocks inside it. Its body is optional lets and one return.',
  let: 'Binds a name to a value inside a function.',
  return: 'Ends a function with the value of an expression.',
  if: 'The condition under which the allow statement grants access.',
  in: 'Whether a value is in a list or set, or a key is in a map.',
  is: 'Tests the type of a value, as in `x is string`.',
}
