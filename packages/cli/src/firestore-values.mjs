// Plain JSON <-> Firestore REST Values, shared by functions:invoke (Firestore
// event payloads) and the MCP tools (documents read and written over REST).
// Encoding follows the official functions shell's encodeFirestoreValue:
// strings, booleans, integers (integerValue as a number, as the shell emits
// it), doubles, null, arrays and plain objects (mapValue). Dates and the
// sentinel objects below add the types plain JSON cannot express:
//   {"$timestamp": "2026-01-01T00:00:00Z"}     timestampValue
//   {"$ref": "users/alice"}                     referenceValue (a relative
//                                               or full document name)
//   {"$geo": {"latitude": 1, "longitude": 2}}  geoPointValue
//   {"$bytes": "<base64>"}                      bytesValue
// Decoding returns the same sentinels, so a document read back can be written
// again without losing types.
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// A document name for the reference sentinel: relative paths are completed
// with the project and database; full names are kept.
export function documentName(path, project, database = '(default)') {
  const trimmed = String(path).replace(/(^\/+|\/+$)/g, '');
  if (trimmed.startsWith('projects/')) return trimmed;
  return `projects/${project}/databases/${database}/documents/${trimmed}`;
}
// The relative document path of a full name (`users/alice`), or the input
// when it is already relative.
export function relativePath(name) {
  const match = /^projects\/[^/]+\/databases\/[^/]+\/documents\/(.*)$/.exec(String(name));
  return match ? match[1] : String(name).replace(/(^\/+|\/+$)/g, '');
}

function sentinel(value) {
  const keys = Object.keys(value);
  if (keys.length !== 1 || !keys[0].startsWith('$')) return undefined;
  return keys[0];
}

// One value. `context` = {project, database} completes {"$ref"} names.
export function encodeValue(value, context = {}) {
  if (typeof value === 'string') return {stringValue:value};
  if (typeof value === 'boolean') return {booleanValue:value};
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) return {integerValue:value};
    if (!Number.isFinite(value)) throw new Error(`Cannot encode ${value} as a Firestore Value`);
    return {doubleValue:value};
  }
  if (typeof value === 'bigint') return {integerValue:value.toString()};
  if (value === null || value === undefined) return {nullValue:'NULL_VALUE'};
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Cannot encode an invalid Date as a Firestore timestamp');
    return {timestampValue:value.toISOString()};
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return {bytesValue:Buffer.from(value).toString('base64')};
  if (Array.isArray(value)) return {arrayValue:{values:value.map(item => encodeValue(item, context))}};
  if (isPlainObject(value)) {
    const key = sentinel(value);
    if (key === '$timestamp') {
      const date = new Date(value.$timestamp);
      if (typeof value.$timestamp !== 'string' || Number.isNaN(date.getTime())) throw new Error('$timestamp must be an RFC 3339 date string');
      return {timestampValue:date.toISOString()};
    }
    if (key === '$ref') {
      if (typeof value.$ref !== 'string' || !value.$ref) throw new Error('$ref must be a document path');
      if (!context.project && !value.$ref.startsWith('projects/')) throw new Error('$ref needs a project to complete a relative document path');
      return {referenceValue:documentName(value.$ref, context.project, context.database)};
    }
    if (key === '$geo') {
      const {latitude, longitude} = value.$geo ?? {};
      if (typeof latitude !== 'number' || typeof longitude !== 'number') throw new Error('$geo must be {latitude, longitude}');
      return {geoPointValue:{latitude, longitude}};
    }
    if (key === '$bytes') {
      if (typeof value.$bytes !== 'string') throw new Error('$bytes must be a base64 string');
      return {bytesValue:value.$bytes};
    }
    return {mapValue:{fields:encodeFields(value, context)}};
  }
  throw new Error(`Cannot encode ${typeof value} as a Firestore Value`);
}
// An object's entries as a `fields` map (undefined values are skipped, as
// JSON.stringify would skip them).
export function encodeFields(data, context = {}) {
  if (!isPlainObject(data)) throw new Error('Firestore data must be key-value pairs.');
  const fields = {};
  for (const [key, value] of Object.entries(data)) if (value !== undefined) fields[key] = encodeValue(value, context);
  return fields;
}

export function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if (Object.hasOwn(value, 'stringValue')) return value.stringValue;
  if (Object.hasOwn(value, 'booleanValue')) return value.booleanValue;
  if (Object.hasOwn(value, 'integerValue')) {
    const number = Number(value.integerValue);
    return Number.isSafeInteger(number) ? number : String(value.integerValue);
  }
  if (Object.hasOwn(value, 'doubleValue')) {
    const raw = value.doubleValue;
    return typeof raw === 'string' ? (raw === 'NaN' ? NaN : Number(raw)) : raw;
  }
  if (Object.hasOwn(value, 'nullValue')) return null;
  if (Object.hasOwn(value, 'timestampValue')) return {$timestamp:value.timestampValue};
  if (Object.hasOwn(value, 'referenceValue')) return {$ref:relativePath(value.referenceValue)};
  if (Object.hasOwn(value, 'geoPointValue')) return {$geo:{latitude:value.geoPointValue?.latitude ?? 0, longitude:value.geoPointValue?.longitude ?? 0}};
  if (Object.hasOwn(value, 'bytesValue')) return {$bytes:value.bytesValue};
  if (Object.hasOwn(value, 'arrayValue')) return (value.arrayValue?.values ?? []).map(decodeValue);
  if (Object.hasOwn(value, 'mapValue')) return decodeFields(value.mapValue?.fields ?? {});
  return null;
}
export function decodeFields(fields) {
  const data = {};
  for (const [key, value] of Object.entries(fields ?? {})) data[key] = decodeValue(value);
  return data;
}
// A REST document ({name, fields, createTime, updateTime}) as plain JSON.
export function decodeDocument(document) {
  return {path:relativePath(document.name), data:decodeFields(document.fields), createTime:document.createTime, updateTime:document.updateTime};
}
