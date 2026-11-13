#!/usr/bin/env node
// Lists every recorded answer in conformance/fixtures, one entry per answer,
// so a website can show them one block each.
//
//   node conformance/src/report/cases.mjs <output.json>
//
// One case is one request (or one rules expression, one rules test case) that
// the reference answered, as recorded: a step of a program, an exchange of a
// wire recording, an observation, a case of an expression corpus, a key of an
// `answers` / `queries` / `uploads` object. Each recording is counted once:
// where the same cases were recorded on two emulator versions only the newest
// is read, and files that restate another (`decoded-contract.json`, raw wire
// bytes behind browser observations) are used for detail but never counted
// twice. Harness-only steps that no reference answers (timed waits, writing a
// source file, setting the push endpoint's status) are left out and reported
// against the fixture's declared counts.
//
// Request and answer strings are one line of at most 140 characters, with no
// host, no port, no `key=` value, no Authorization header and nothing that
// looks like a token. Node 24, no dependencies.

import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

// Two capture plans next to the fixtures name what a row asked (the rules
// expression, the list rule). They import only node: built-ins; without them
// the ids stand in.
const optional = async (rel) => import(new URL(rel, import.meta.url)).catch(() => ({}));
const PATHS_PLAN = await optional('../suite/rules-document-paths-observe.mjs');
const NATIVE_PLAN = await optional('../suite/storage-native-clients-observe.mjs');
const MAX = 140;

// ---------------------------------------------------------------- helpers

const readJson = (rel) => JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8'));
const exists = (rel) => existsSync(join(FIXTURES, rel));
const subdirs = (rel) =>
  readdirSync(join(FIXTURES, rel), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);
const latestDay = (...values) => values.map(day).filter(Boolean).sort().at(-1) ?? null;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// Session handles: the parameter stays (it tells a continuation from a start), the value does not.
const HANDLE_QUERY = new Set(['upload_id', 'uploadid', 'sid', 'gsessionid']);
const SECRET_QUERY = new Set([
  'key', 'apikey', 'api_key', 'token', 'oobcode', 'access_token', 'id_token', 'idtoken',
  'refresh_token', 'code', 'jwt', 'sig', 'signature', 'password', 'auth', 'x-goog-api-key',
]);

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Strips scheme, host and port, and drops query parameters that carry keys or tokens. */
function cleanPath(raw) {
  if (raw == null) return '';
  const text = String(raw).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i, '');
  const at = text.indexOf('?');
  if (at < 0) return text || '/';
  const base = text.slice(0, at) || '/';
  const kept = text
    .slice(at + 1)
    .split('&')
    .filter(Boolean)
    .filter((pair) => !SECRET_QUERY.has(decode(pair.split('=')[0]).toLowerCase()))
    .map((pair) => {
      const name = pair.split('=')[0];
      return HANDLE_QUERY.has(decode(name).toLowerCase()) && !/^<.*>$/.test(decode(pair.slice(name.length + 1))) ? `${name}=<id>` : pair;
    });
  return kept.length ? `${base}?${kept.join('&')}` : base;
}

/** Removes anything secret-looking. Applied to every request and answer string. */
// The recordings keep the project, bucket and collection names they were
// made with, some from before the rename; what a page shows names them as
// `{project}` (or `{name}` for a word on its own), never the old name.
const RECORDED_NAME = /[a-z0-9~_.-]*fireside[a-z0-9_.-]*/gi;
const recordedName = (token) => (/^fireside$/i.test(token) ? '{name}' : '{project}');

function scrub(text) {
  return String(text)
    .replace(RECORDED_NAME, recordedName)
    .replace(/eyJ[A-Za-z0-9_-]{2,}(?:\.[A-Za-z0-9_-]*){0,2}/g, '')
    .replace(/\bBearer\s+\S+/gi, '')
    // A Basic credential is base64 (a digit, + / or = in it), never words like "Basic credential".
    .replace(/\bBasic\s+(?=\S*[0-9+/=])[A-Za-z0-9+/=]{8,}/g, '')
    .replace(/([?&\s]|^)key=[^&\s]*/gi, '$1')
    .replace(/(\bpassword\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1')
    .replace(/\?&/g, '?')
    .replace(/[?&]$/g, '');
}

/** One line, scrubbed, at most 140 characters (ellipsis when cut). */
function oneLine(value) {
  const text = scrub(String(value ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > MAX ? `${text.slice(0, MAX - 1).trimEnd()}…` : text;
}

const GRPC = [
  'OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND',
  'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED',
  'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
];
const grpcName = (code) => (typeof code === 'number' ? (GRPC[code] ?? `code ${code}`) : String(code));
const SENSITIVE_KEY = /token|password|secret|jwt|credential|hash|cookie|authorization/i;

function textSummary(text) {
  const raw = String(text);
  const pre = raw.match(/<pre>([\s\S]*?)<\/pre>/i);
  if (pre) return pre[1].replace(/<br\s*\/?>/gi, ' ');
  const title = raw.match(/<title>([\s\S]*?)<\/title>/i);
  if (/^\s*</.test(raw)) return title ? `HTML page "${title[1].trim()}"` : 'HTML page';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^[A-Za-z0-9+/=]{40,}$/.test(trimmed)) return `binary body (${Buffer.from(trimmed, 'base64').length} bytes)`;
  try {
    return summarize(JSON.parse(trimmed));
  } catch {
    return trimmed.split('\n')[0];
  }
}

/** A short plain description of a response body: the error, the kind, or its fields. */
function summarize(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return textSummary(body);
  if (typeof body !== 'object') return String(body);
  if (Array.isArray(body)) {
    if (body.length === 1 && body[0] && typeof body[0] === 'object' && body[0].error) return summarize(body[0]);
    return `[${plural(body.length, 'item')}]`;
  }
  if (body.error !== undefined && body.error !== null) {
    const error = body.error;
    if (typeof error === 'string') return error;
    // A list of per-item failures in a successful answer (batchCreate's).
    if (Array.isArray(error)) return `{error: [${error.length ? plural(error.length, 'item') : ''}]}`;
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    const status = error.status ?? (typeof error.code === 'string' ? error.code : '');
    if (status && message && !message.includes(status)) return `${status}: ${message}`;
    return message || status || 'error';
  }
  if (body.authEmulator && typeof body.authEmulator.error === 'string') return body.authEmulator.error;
  if (typeof body.$sha256 === 'string') return `${body.length ?? '?'} characters (stored as a digest)`;
  if (typeof body.kind === 'string') return body.kind;
  const keys = Object.keys(body).filter((key) => !SENSITIVE_KEY.test(key));
  if (!keys.length) return Object.keys(body).length ? '{…}' : '{}';
  return `{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}}`;
}

function http(status, body) {
  if (status === null || status === undefined) return 'no answer (timed out)';
  const summary = summarize(body);
  if (summary) return `${status} ${summary}`;
  return status >= 400 ? `${status} (empty body)` : String(status);
}

function grpc(code, message) {
  const name = grpcName(code);
  const text = typeof message === 'string' ? message.trim() : '';
  return text ? `${name}: ${text}` : name;
}

const stripRulesLocation = (message) =>
  String(message).replace(/^Error: \S+ line \[\d+\], column \[\d+\]\.\s*/, '');

/** Verdict of a Rules API `projects.test` result probed with expectation ALLOW. */
function rulesVerdict(result) {
  if (!result) return 'no result';
  if (result.state === 'SUCCESS') return 'ALLOW';
  const message = result.debugMessages?.[0];
  if (message) return `DENY, error: ${stripRulesLocation(message)}`;
  const visited = result.visitedExpressions ?? [];
  const last = visited.at(-1);
  if (last && last.value === false) return 'DENY';
  return 'DENY (evaluation error)';
}

function firstIssue(issues) {
  if (!Array.isArray(issues) || !issues.length) return '';
  const issue = issues.find((item) => item.severity === 'ERROR') ?? issues[0];
  return `${issue.severity ?? 'ISSUE'}: ${issue.description}`;
}

/** Answer of a Rules API call: compile issues, the verdict, or the HTTP error. */
function rulesApiAnswer(httpStatus, response) {
  if (httpStatus !== 200) return http(httpStatus, response);
  const errors = (response?.issues ?? []).filter((issue) => issue.severity === 'ERROR');
  if (errors.length) return `compile ${firstIssue(errors)}`;
  const results = response?.testResults;
  if (Array.isArray(results) && results.length) return rulesVerdict(results[0]);
  const warnings = response?.issues ?? [];
  if (warnings.length) return `compiled, ${firstIssue(warnings)}`;
  return 'compiled with no issues';
}

/** Collapses repeated neighbours: a, b, b, b -> a, b ×3. */
function runs(items) {
  const out = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && last.item === item) last.n += 1;
    else out.push({ item, n: 1 });
  }
  return out.map(({ item, n }) => (n > 1 ? `${item} ×${n}` : item)).join(', ');
}

function base64Text(value) {
  return Buffer.from(String(value), 'base64').toString('utf8');
}

/** Describes one decoded WebChannel / Listen / Write message. */
function describeMessage(message) {
  if (message === null || typeof message !== 'object') return String(message);
  if (message.targetChange) return `targetChange ${message.targetChange.targetChangeType ?? 'NO_CHANGE'}`;
  if (message.documentChange) return 'documentChange';
  if (message.documentDelete) return 'documentDelete';
  if (message.documentRemove) return 'documentRemove';
  if (message.filter) return 'existenceFilter';
  if (message.writeResults) return `writeResults ×${message.writeResults.length}`;
  if (message.streamId !== undefined) return 'stream opened';
  if (message.error) return `error ${summarize(message)}`;
  if (message.status && typeof message.status === 'object') return `status ${summarize({ error: message.status })}`;
  return Object.keys(message)[0] ?? '{}';
}

function webChannelFrames(frames) {
  const parts = [];
  for (const frame of frames ?? []) {
    const json = frame.json;
    if (!Array.isArray(json)) {
      parts.push(frame.text ? textSummary(frame.text) : '?');
      continue;
    }
    if (json.every((item) => typeof item === 'number')) {
      parts.push('forward-channel ack');
      continue;
    }
    for (const item of json) {
      const payload = Array.isArray(item) ? item[1] : item;
      const head = Array.isArray(payload) ? payload[0] : payload;
      if (head === 'c') parts.push('session created');
      else if (typeof head === 'string') parts.push(head);
      else parts.push(describeMessage(head));
    }
  }
  return runs(parts);
}

function webChannelRequest(request) {
  const query = new Map(request.query ?? []);
  let label = '';
  if (query.get('TYPE') === 'terminate') label = ' (terminate)';
  else if (query.get('RID') === 'rpc') label = ' (backchannel)';
  else if (!query.has('SID')) label = ' (open)';
  else label = ' (send)';
  return `${request.method} ${request.path}${label}`;
}

function chunksText(response) {
  if (Array.isArray(response.chunks) && response.chunks.length) {
    return response.chunks.map((chunk) => base64Text(chunk.bodyBase64 ?? '')).join('');
  }
  if (typeof response.bodyBase64 === 'string') return base64Text(response.bodyBase64);
  if (typeof response.body === 'string') return response.body;
  return '';
}

// ------------------------------------------------------------- the model

const sets = [];
const cases = [];
const checks = [];
const skipped = [];

function declare(set, label, declared, counted, reason = '') {
  checks.push({ set, label, declared, counted, reason });
}

function skip(set, what, reason) {
  skipped.push({ set, what, reason });
}

/** Adds one set and its cases. `items` are {id, scenario, title, request, answer}. */
function addSet(meta, items) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`${meta.id}: duplicate case id ${item.id}`);
    seen.add(item.id);
  }
  const scenarios = new Set(items.map((item) => item.scenario)).size;
  sets.push({
    id: meta.id,
    service: meta.service,
    area: meta.area,
    reference: meta.reference,
    recordedAt: meta.recordedAt ?? null,
    scenarios: meta.scenarios ?? scenarios,
    answers: items.length,
  });
  for (const item of items) {
    cases.push({
      set: meta.id,
      id: String(item.id),
      scenario: scrub(item.scenario).replace(/\s+/g, ' ').trim(),
      title: scrub(item.title).replace(/\s+/g, ' ').trim(),
      request: oneLine(item.request),
      answer: oneLine(item.answer),
    });
  }
}

const official = (name, version) => ({ kind: 'official', name, version: version ?? null });
const production = (name) => ({ kind: 'production', name, version: null });

const REF = {
  auth: official('Auth emulator (firebase-tools)', '15.22.0'),
  functions: official('Functions emulator (firebase-tools)', '15.22.0'),
  tasks: official('Functions and Cloud Tasks emulators (firebase-tools)', '15.22.0'),
  storage: official('Storage emulator (firebase-tools)', '15.22.0'),
  storage1534: official('Storage emulator (firebase-tools)', '15.34.0'),
  suite: official('Emulator suite and UI (firebase-tools)', '15.22.0'),
  pubsub: official('Pub/Sub emulator', '0.8.33'),
  java: official('Firestore emulator (Java)', '1.22.0'),
  cloudFirestore: production('Cloud Firestore (production)'),
  rulesApi: production('Firebase Rules API (production)'),
};

// ---------------------------------------------------- program-shaped sets

/** auth-v1, auth-claims-length-v1: programs of raw HTTP steps. */
function authPrograms(dir, area) {
  const fixture = readJson(`${dir}/emulator-programs.json`);
  const items = [];
  for (const program of fixture.programs) {
    for (const step of program.steps) {
      items.push({
        id: `${program.id}/${step.id}`,
        scenario: program.title,
        title: step.id,
        request: `${step.request.method} ${cleanPath(step.request.path)}`,
        answer: http(step.response?.status, step.response?.body),
      });
    }
  }
  declare(dir, 'programCount', fixture.programCount, fixture.programs.length);
  declare(dir, 'stepCount', fixture.stepCount, items.length);
  addSet(
    { id: dir, service: 'auth', area, reference: official('Auth emulator (firebase-tools)', fixture.targetVersion), recordedAt: day(fixture.capturedAt) },
    items,
  );
}

function grpcResource(body) {
  if (!body || typeof body !== 'object') return '';
  for (const field of ['subscription', 'topic', 'snapshot', 'name', 'schema', 'resource', 'parent', 'project']) {
    if (typeof body[field] === 'string') return body[field].replace(/^projects\/[^/]+\//, '');
    if (typeof body[field]?.name === 'string') return body[field].name.replace(/^projects\/[^/]+\//, '');
  }
  return '';
}

/** pubsub-v1: gRPC calls, HTTP/JSON requests, streaming pulls and push deliveries. */
function pubsubPrograms() {
  const dir = 'pubsub-v1';
  const fixture = readJson(`${dir}/emulator-programs.json`);
  const items = [];
  const excluded = { sleep: 0, pushStatus: 0 };
  for (const program of fixture.programs) {
    for (const step of program.steps) {
      const request = step.request;
      const response = step.response ?? {};
      let req;
      let answer;
      switch (request.transport) {
        case 'sleep':
        case 'pushStatus':
          excluded[request.transport] += 1;
          continue;
        case 'grpc':
          req = `${request.service}.${request.method} ${grpcResource(request.body)}`;
          answer = response.error ? grpc(response.error.code, response.error.message) : `OK ${summarize(response.body)}`;
          break;
        case 'http':
          req = `${request.method} ${cleanPath(request.path)}`;
          answer = http(response.status, response.body ?? response.text);
          break;
        case 'stream': {
          const writes = (request.actions ?? []).filter((action) => action.write).length;
          req = `${request.service}.${request.method} (stream, ${plural(writes, 'write')})`;
          const received = response.received?.messages?.length ?? 0;
          answer = `${grpc(response.status?.code, response.status?.message)} · ${plural(received, 'message')} received`;
          break;
        }
        case 'pushes':
          req = `push endpoint: wait up to ${request.timeoutMs} ms for ${request.atLeast} or more pushes`;
          answer = `${plural(response.distinct?.length ?? response.count ?? 0, 'distinct push', 'distinct pushes')} received`;
          break;
        default:
          throw new Error(`${dir}: unknown transport ${request.transport}`);
      }
      items.push({ id: `${program.id}/${step.id}`, scenario: program.title, title: step.note ?? step.id, request: req, answer });
    }
  }
  const harness = excluded.sleep + excluded.pushStatus;
  declare(dir, 'programCount', fixture.programCount, fixture.programs.length);
  declare(
    dir,
    'stepCount',
    fixture.stepCount,
    items.length,
    `${harness} harness steps left out: ${excluded.sleep} timed waits, ${excluded.pushStatus} push-endpoint status settings (no reference answer)`,
  );
  addSet(
    {
      id: dir,
      service: 'pubsub',
      area: 'Every Pub/Sub RPC over gRPC and HTTP/JSON, streaming pull and push',
      reference: official('Pub/Sub emulator', fixture.targetVersion),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

function functionsAction(action, project) {
  const withProject = (path) => cleanPath(path).replaceAll('{{project}}', project);
  switch (action.kind) {
    case 'http':
      return `${action.method} ${withProject(action.path)}`;
    case 'hub':
      return `hub ${action.method} ${withProject(action.path)}`;
    case 'logs':
      return `emulator log lines matching "${action.pattern}"`;
    case 'firestore':
      return `Firestore ${action.op} ${action.path}`;
    case 'firestore-commit':
      return `Firestore commit (${plural(action.writes?.length ?? 0, 'write')})`;
    case 'storage':
      return `Storage ${action.op} ${action.bucket ?? ''}/${action.name ?? ''}`;
    case 'pubsub':
      return `Pub/Sub publish to ${action.topic} (${plural(action.messages?.length ?? 0, 'message')})`;
    case 'pubsub-list':
      return `Pub/Sub list ${action.what}`;
    case 'auth':
      return `Auth ${action.op}`;
    case 'http-parallel': {
      const first = action.requests?.[0] ?? {};
      const origin = action.origin ? `${action.origin} ` : '';
      return `${action.requests?.length ?? 0} parallel ${origin}${first.method} ${withProject(first.path)}`;
    }
    default:
      throw new Error(`unknown functions action ${action.kind}`);
  }
}

function functionsAnswer(response) {
  if (!response) return 'no answer';
  if (Array.isArray(response.parallel)) return `statuses ${response.parallel.map((item) => item.status ?? 'none').join(', ')}`;
  if (typeof response.matched === 'number') return plural(response.matched, 'log line') + ' matched';
  if (response.clientError) return `client error: ${response.clientError}`;
  return http(response.status, response.body);
}

/** functions-runtime-v1, tasks-v1: profiles of programs of steps. */
function functionsPrograms(dir, service, area, reference) {
  const fixture = readJson(`${dir}/emulator-programs.json`);
  const items = [];
  const excluded = { wait: 0, file: 0 };
  let programs = 0;
  let observations = 0;
  for (const profile of fixture.profiles) {
    for (const program of profile.programs) {
      programs += 1;
      for (const step of program.steps) {
        observations += step.observations?.length ?? 0;
        if (step.action.kind in excluded) {
          excluded[step.action.kind] += 1;
          continue;
        }
        const seen = step.observations?.length ?? 0;
        const answer = functionsAnswer(step.response) + (seen ? ` · handler saw ${plural(seen, 'event')}` : '');
        items.push({
          id: `${profile.id}/${program.id}/${step.id}`,
          scenario: program.description,
          title: step.id,
          request: functionsAction(step.action, fixture.projectId),
          answer,
        });
      }
    }
  }
  declare(dir, 'profileCount', fixture.profileCount, fixture.profiles.length);
  declare(dir, 'programCount', fixture.programCount, programs);
  declare(
    dir,
    'stepCount',
    fixture.stepCount,
    items.length,
    `${excluded.wait + excluded.file} harness steps left out: ${excluded.wait} timed waits, ${excluded.file} source-file writes (no reference answer)`,
  );
  declare(dir, 'observationCount (handler observations, carried inside steps, not counted)', fixture.observationCount, observations);
  addSet({ id: dir, service, area, reference: { ...reference, version: fixture.targetVersion }, recordedAt: day(fixture.recordedAt) }, items);
}

// ------------------------------------------------------------ rules sets

function storageRules() {
  const dir = 'storage-rules-v1';
  const programs = readJson(`${dir}/emulator-programs.json`);
  const items = [];
  for (const program of programs.programs) {
    for (const step of program.observations) {
      items.push({
        id: `${program.id}/${step.id}`,
        scenario: program.description,
        title: step.note ?? step.id,
        request: `${step.request.method} ${cleanPath(step.request.resolvedPath ?? step.request.path)}`,
        answer: http(step.response?.status, step.response?.body),
      });
    }
  }
  declare(`${dir}/official-emulator`, 'programCount', programs.programCount, programs.programs.length);
  declare(`${dir}/official-emulator`, 'stepCount', programs.stepCount, items.length);
  skip(
    `${dir}/official-emulator`,
    `startupCompileError (${programs.startupCompileError.observations.length} observations) and oracleCrashNotRecordedLive`,
    'a separate bad-ruleset startup that Firenook deliberately refuses (replayed as a startup failure, not step by step), and a crash with no recorded answer',
  );
  addSet(
    {
      id: `${dir}/official-emulator`,
      service: 'storage-rules',
      area: 'Storage Security Rules request model, step by step on the Storage emulator',
      reference: official('Storage emulator (firebase-tools)', programs.targetVersion),
      recordedAt: day(programs.capturedAt),
    },
    items,
  );

  const corpus = readJson(`${dir}/production-expression-corpus.json`);
  const corpusItems = [];
  for (const batch of corpus.batches) {
    batch.cases.forEach((entry, index) => {
      corpusItems.push({
        id: entry.id,
        scenario: entry.category,
        title: entry.id,
        request: `${entry.method}: ${entry.expression}`,
        answer: rulesVerdict(batch.response.testResults[index]),
      });
    });
  }
  const categories = Object.values(corpus.categories).reduce((sum, n) => sum + n, 0);
  declare(`${dir}/production-rules-api`, 'caseCount', corpus.caseCount, corpusItems.length);
  declare(`${dir}/production-rules-api`, 'batchCount', corpus.batchCount, corpus.batches.length);
  declare(`${dir}/production-rules-api`, 'sum of categories', categories, corpusItems.length);
  declare(
    `${dir}/production-rules-api`,
    'verdictSummary.allow',
    corpus.verdictSummary.allow,
    corpusItems.filter((item) => item.answer === 'ALLOW').length,
  );
  addSet(
    {
      id: `${dir}/production-rules-api`,
      service: 'storage-rules',
      area: 'Storage Security Rules expressions over the Storage value surface',
      reference: REF.rulesApi,
      recordedAt: day(corpus.capturedAt),
    },
    corpusItems,
  );
}

function describeFilter(filter) {
  if (!filter) return '';
  if (Array.isArray(filter)) return filter.map(describeFilter).join(' and ');
  if (filter.field !== undefined) return `${filter.field} ${filter.op} ${JSON.stringify(filter.value)}`;
  if (Array.isArray(filter.filters)) return `(${filter.filters.map(describeFilter).join(` ${String(filter.op).toLowerCase()} `)})`;
  for (const op of ['and', 'or']) if (Array.isArray(filter[op])) return `(${filter[op].map(describeFilter).join(` ${op} `)})`;
  return JSON.stringify(filter);
}

function describeQuery(operation, entry) {
  if (!entry) return operation;
  const target = `${entry.group ? 'group ' : ''}${entry.parent ? `${entry.parent}/` : ''}${entry.collection}`;
  const parts = [`${operation} ${target}`];
  if (entry.filter) parts.push(`where ${describeFilter(entry.filter)}`);
  if (entry.orderBy) parts.push(`order by ${entry.orderBy.map((order) => order.join(' ')).join(', ')}`);
  if (entry.limit !== undefined) parts.push(`limit ${entry.limit}`);
  if (entry.offset !== undefined) parts.push(`offset ${entry.offset}`);
  return parts.join(' ');
}

function queryAnswer(result) {
  const ok = result.code === 0;
  if (!ok) return `${grpcName(result.code)}${result.error ? `: ${result.error.trim()}` : ''}`;
  if (result.count !== undefined) return `OK · count ${result.count}`;
  return `OK · ${plural(result.documents?.length ?? 0, 'document')}`;
}

/** rules-v2/query-*: gRPC and browser observations of query authorization. */
function queryOracle(caseSet, items) {
  const dir = `rules-v2/${caseSet}/java-1.22.0`;
  const metadata = readJson(`${dir}/metadata.json`);
  const grpcFile = readJson(`${dir}/grpc.json`);
  const byId = new Map(grpcFile.cases.map((entry) => [entry.id, entry]));
  declare('rules-v2/official-emulator', `${caseSet} metadata.cases`, metadata.cases, grpcFile.cases.length);
  const used = new Map();
  const unique = (id) => {
    const n = (used.get(id) ?? 0) + 1;
    used.set(id, n);
    return n === 1 ? id : `${id}#${n}`;
  };
  let observations = 0;
  for (const observation of grpcFile.observations) {
    observations += 1;
    items.push({
      id: unique(`${caseSet}/${observation.id}/grpc/${observation.operation}`),
      scenario: `${caseSet}: ${observation.id}`,
      title: `${observation.operation} over gRPC`,
      request: describeQuery(observation.operation, byId.get(observation.id)),
      answer: queryAnswer({ code: observation.code, error: observation.error, count: observation.count, documents: observation.documents }),
    });
  }
  for (const variant of ['long-poll', 'streaming']) {
    const browser = readJson(`${dir}/${variant}-browser.json`);
    for (const observation of browser.observations) {
      observations += 1;
      const result = observation.result;
      const code = result.code === 0 ? 0 : result.code;
      items.push({
        id: unique(`${caseSet}/${observation.id}/${variant}/${observation.operation}`),
        scenario: `${caseSet}: ${observation.id}`,
        title: `${observation.operation} from the browser SDK (${variant} WebChannel)`,
        request: describeQuery(observation.operation, byId.get(observation.id)),
        answer: queryAnswer({ ...result, code }),
      });
    }
  }
  skip(
    dir,
    '*-wire.json and *-aggregation-wire.json',
    'raw HTTP bytes of the same browser runs whose SDK-level observations are counted (would double count)',
  );
  skip(`rules-v2/${caseSet}/java-1.21.0`, 'every file', 'the same cases recorded on the older Java emulator; only 1.22.0 is counted');
  return observations;
}

/** rules-v2/contributed-rooms: a synthetic ruleset and its cases, contributed for #156. */
const CONTRIBUTED_FEATURES = {
  'function-outside-service': 'a function outside the service block',
  'conditional-operator': 'the conditional operator inside a function',
  'keys-hasOnly-hasAll': 'keys().hasOnly() and hasAll()',
  'keys-hasAny': 'keys().hasAny()',
  'type-and-value-checks': 'type, length and list-membership checks',
  'diff-affectedKeys': 'diff().affectedKeys() on update, and a delete never allowed',
  'exists-on-other-document': 'exists() on another document',
  'field-check-in-list-proof': 'a field check in the proof of a list query',
  'get-with-default': 'get() with a default on the payload, and is int',
  'get-on-parent-document': 'get() on the parent document',
  'null-values-on-write': 'a null value on write',
  'query-pinned-to-document-id': 'a query pinned to a missing document id',
  'regex-on-document-id': 'matches() on the document id',
};

function contributedRooms() {
  const fixture = readJson('rules-v2/contributed-rooms/cases.json');
  const items = fixture.cases.map((entry) => ({
    id: `contributed-rooms/${entry.id}`,
    scenario: `Contributed rooms ruleset: ${CONTRIBUTED_FEATURES[entry.feature] ?? entry.feature}`,
    title: entry.id,
    request: `${entry.request.method} ${entry.request.path} ${entry.auth ? `as ${entry.auth.uid}` : 'signed out'}`,
    answer: http(entry.observed.status, entry.observed.body),
  }));
  declare('rules-v2/contributed-rooms', 'allowCases + denyCases', fixture.allowCases + fixture.denyCases, items.length);
  addSet(
    {
      id: 'rules-v2/contributed-rooms',
      service: 'firestore-rules',
      area: 'Firestore Security Rules: a ruleset contributed by a user, with its allowed and denied requests',
      reference: REF.java,
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

function rulesV2() {
  const items = [];
  const javaFiles = [
    ['java-access-accounting', 'Document access limits (10 and 20) and cached repeated access'],
    ['java-get-after', 'getAfter sees the pending write of a commit'],
    ['java-runtime-errors', 'Runtime errors deny: missing fields, division by zero, list bounds, wrong types'],
  ];
  let latest = [];
  for (const [file, scenario] of javaFiles) {
    const fixture = readJson(`rules-v2/${file}.json`);
    latest.push(fixture.capturedAt);
    for (const observation of fixture.observations) {
      items.push({
        id: `${file}/${observation.id}`,
        scenario,
        title: observation.id,
        request: `${observation.method} ${cleanPath(observation.url)}`,
        answer: http(observation.status, observation.body?.error ? observation.body : observation.body?.code ? { error: observation.body } : observation.body),
      });
    }
  }
  const complex = readJson('rules-v2/complex-rules-cases.json');
  latest.push(complex.capturedAt);
  for (const observation of complex.observations) {
    items.push({
      id: `complex-rules/${observation.id}`,
      scenario: `complex-firestore.rules: ${observation.feature}`,
      title: observation.id,
      request: `${observation.method} ${cleanPath(observation.url)}`,
      answer: http(observation.status, observation.body?.error ? observation.body : observation.body?.code ? { error: observation.body } : observation.body),
    });
  }
  declare('rules-v2/official-emulator', 'complex allowCases + denyCases', complex.allowCases + complex.denyCases, complex.observations.length);
  for (const caseSet of ['query-authorization', 'query-paths']) {
    queryOracle(caseSet, items);
    latest.push(readJson(`rules-v2/${caseSet}/java-1.22.0/metadata.json`).capturedAt);
  }
  addSet(
    {
      id: 'rules-v2/official-emulator',
      service: 'firestore-rules',
      area: 'Firestore Security Rules: access limits, getAfter, runtime errors, a large ruleset and query authorization',
      reference: REF.java,
      recordedAt: latestDay(...latest),
    },
    items,
  );

  const prod = [];
  latest = [];
  const corpus = readJson('rules-v2/production-expression-corpus.json');
  latest.push(corpus.capturedAt);
  for (const batch of corpus.batches) {
    batch.cases.forEach((entry, index) => {
      prod.push({
        id: `expression-corpus/${entry.id}`,
        scenario: `Expression corpus: ${entry.category}`,
        title: entry.id,
        request: `${entry.request.method}: ${entry.expression}`,
        answer: rulesVerdict(batch.response.testResults[index]),
      });
    });
  }
  declare('rules-v2/production-rules-api', 'expression corpus caseCount', corpus.caseCount, prod.length);
  declare(
    'rules-v2/production-rules-api',
    'expression corpus batchCount',
    corpus.batchCount,
    corpus.batches.length,
  );
  const language = readJson('rules-v2/production-language-contract.json');
  latest.push(language.capturedAt);
  language.cases.forEach((entry, index) => {
    prod.push({
      id: `language-contract/${entry.id}`,
      scenario: `Language contract: ${entry.category}`,
      title: entry.id,
      request: `${language.testCases[index].request.method}: ${entry.expression}`,
      answer: rulesVerdict(language.response.testResults[index]),
    });
  });
  for (const [file, prefix, label] of [
    ['production-limit-probes', 'limit-probes', 'Limits'],
    ['expression-size/production-expression-size-probes', 'expression-size-probes', 'Limits'],
    ['production-parse-errors', 'parse-errors', 'Compiler and source size'],
  ]) {
    const fixture = readJson(`rules-v2/${file}.json`);
    latest.push(fixture.capturedAt);
    for (const observation of fixture.observations) {
      const family = observation.id.replace(/-\d+$/, '');
      prod.push({
        id: `${prefix}/${observation.id}`,
        scenario: `${label}: ${family}`,
        title: observation.id,
        request: `projects.test with the ${observation.id} source (${observation.sourceBytes} bytes)`,
        answer: rulesApiAnswer(observation.httpStatus, observation.response),
      });
    }
  }
  prod.push({
    id: 'complex-rules/production-compile',
    scenario: 'complex-firestore.rules: production compile',
    title: 'production compile',
    request: `compile complex-firestore.rules (${complex.nonBlankLines} non-blank lines)`,
    answer: rulesApiAnswer(complex.productionCompile.httpStatus, complex.productionCompile.response),
  });
  addSet(
    {
      id: 'rules-v2/production-rules-api',
      service: 'firestore-rules',
      area: 'Firestore Security Rules expressions, language surface, compiler and limits',
      reference: REF.rulesApi,
      recordedAt: latestDay(...latest),
    },
    prod,
  );
}

// -------------------------------------------------- wire recordings (proxy)

/** Reads a capture-proxy case: decoded-contract.json when present (same exchanges), else fixture.json. */
function wireCase(rel) {
  const raw = readJson(`${rel}/fixture.json`);
  const decoded = exists(`${rel}/decoded-contract.json`) ? readJson(`${rel}/decoded-contract.json`) : null;
  if (decoded && decoded.exchanges.length !== raw.exchanges.length) {
    throw new Error(`${rel}: decoded-contract and fixture disagree`);
  }
  return { raw, decoded };
}

function wireSets(dir, transport, area) {
  const groups = { official: [], production: [] };
  const dates = { official: [], production: [] };
  const versions = new Set();
  for (const sub of subdirs(dir)) {
    const kind = sub.startsWith('production') ? 'production' : 'official';
    for (const name of subdirs(`${dir}/${sub}`)) {
      const rel = `${dir}/${sub}/${name}`;
      const { raw, decoded } = wireCase(rel);
      dates[kind].push(raw.metadata.recordedAt);
      if (kind === 'official') versions.add(raw.metadata.targetVersion);
      const exchanges = decoded?.exchanges ?? raw.exchanges;
      exchanges.forEach((exchange, index) => {
        const request = exchange.request;
        const response = exchange.response;
        let req;
        let answer;
        const path = request.path ?? request.uri ?? '';
        if (transport === 'webchannel' || (decoded && /\/channel(\?|$)/.test(path))) {
          req = webChannelRequest(request);
          const frames = webChannelFrames(response.frames);
          const fallback = frames ? '' : textSummary(chunksText(response));
          answer = frames ? `${response.status} · ${frames}` : http(response.status, fallback);
        } else {
          req = `${request.method} ${cleanPath(path)}`;
          const text = decoded ? chunksText(response) : typeof response.body === 'string' ? response.body : chunksText(response);
          answer = http(response.status, text);
        }
        groups[kind].push({
          id: `${name}/${exchange.sequence ?? index + 1}`,
          scenario: raw.metadata.hypothesis,
          title: `${name} #${exchange.sequence ?? index + 1}`,
          request: req,
          answer,
        });
      });
    }
  }
  const officialSub = subdirs(dir).find((sub) => !sub.startsWith('production'));
  const productionSub = subdirs(dir).find((sub) => sub.startsWith('production'));
  if ([...versions].length !== 1) throw new Error(`${dir}: several official versions ${[...versions]}`);
  addSet(
    { id: `${dir}/${officialSub}`, service: 'firestore', area, reference: official('Firestore emulator (Java)', [...versions][0]), recordedAt: latestDay(...dates.official) },
    groups.official,
  );
  addSet(
    { id: `${dir}/${productionSub}`, service: 'firestore', area, reference: REF.cloudFirestore, recordedAt: latestDay(...dates.production) },
    groups.production,
  );
}

// --------------------------------------------------------- firestore sets

const DOC_MAP_OPERATIONS = {
  'sdk-get': 'Node SDK get() (BatchGetDocuments)',
  'grpc-get': 'gRPC GetDocument',
  'grpc-list': 'gRPC ListDocuments',
  'grpc-query': 'gRPC RunQuery',
  'rest-get': 'REST GET document',
  'browser-long-poll': 'browser SDK server read (long-poll)',
  'browser-streaming': 'browser SDK server read (streaming)',
};

function documentMap() {
  const dir = 'document-map-serialization';
  const metadata = readJson(`${dir}/java-1.22.0/metadata.json`);
  const fixture = readJson(`${dir}/java-1.22.0/observations.json`);
  const items = [];
  // One answer a document and operation: the recording reads it several
  // times to show the serialization is stable, and counting each read would
  // put the same answer on the wall that many times.
  for (const observation of fixture.observations) {
    const distinct = [...new Set(observation.reads)];
    const operation = DOC_MAP_OPERATIONS[observation.operation] ?? observation.operation;
    items.push({
      id: `${observation.id}/${observation.operation}`,
      scenario: `${operation} of the "${observation.id}" document`,
      title: `read ${observation.reads.length} times`,
      request: `${operation}: ${observation.id}`,
      answer:
        distinct.length === 1
          ? `${distinct[0]}, the same each time`
          : `${distinct.length} different answers in ${observation.reads.length} reads`,
    });
  }
  declare(dir, 'metadata.repeatedReads', metadata.repeatedReads, fixture.observations.reduce((sum, o) => sum + o.reads.length, 0));
  declare(dir, 'observations', fixture.observations.length, items.length);
  declare(dir, 'metadata.operations', metadata.operations, new Set(fixture.observations.map((o) => o.operation)).size);
  skip(`${dir}/java-1.21.0`, 'observations.json', 'byte-identical recording on the older Java emulator; only 1.22.0 is counted');
  addSet(
    {
      id: dir,
      service: 'firestore',
      area: 'Repeated reads return the same document-map serialization',
      reference: official('Firestore emulator (Java)', metadata.version),
      recordedAt: day(metadata.capturedAt),
    },
    items,
  );
}

function kindlessQuery() {
  const dir = 'kindless-query-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const items = [];
  for (const [id, query] of Object.entries(fixture.queries)) {
    const where = query.parent ? `under ${query.parent}` : 'at the root';
    items.push({
      id: `queries/${id}/grpc`,
      scenario: 'Kindless queries (all descendants, no collection id)',
      title: `${id} over gRPC`,
      request: `RunQuery ${where}: ${JSON.stringify(query.structuredQuery)}`,
      answer: queryAnswer({ code: query.grpc.code, error: query.grpc.message, documents: query.grpc.documents }),
    });
    items.push({
      id: `queries/${id}/rest`,
      scenario: 'Kindless queries (all descendants, no collection id)',
      title: `${id} over REST`,
      request: `POST :runQuery ${where}: ${JSON.stringify(query.structuredQuery)}`,
      answer:
        query.rest.status === 200
          ? `200 · ${plural(query.rest.documents?.length ?? 0, 'document')}`
          : http(query.rest.status, query.rest.message ? { error: { message: query.rest.message } } : query.rest.body),
    });
  }
  for (const [id, aggregation] of Object.entries(fixture.aggregations)) {
    const value = aggregation.aggregate ? Object.values(aggregation.aggregate)[0] : null;
    items.push({
      id: `aggregations/${id}`,
      scenario: 'Aggregations over a kindless query',
      title: id,
      request: `RunAggregationQuery ${id}`,
      answer: aggregation.code === 0 ? `OK · ${value ? `value ${value.integerValue ?? value.doubleValue}` : 'no value'}` : grpc(aggregation.code, aggregation.message),
    });
  }
  for (const [id, listen] of Object.entries(fixture.listens)) {
    items.push({
      id: `listens/${id}`,
      scenario: 'A kindless listener',
      title: id,
      request: `Listen ${id}`,
      answer: `${grpcName(listen.code)} · ${plural(listen.documents?.length ?? 0, 'document')}, ${plural(listen.changes?.length ?? 0, 'change')} after`,
    });
  }
  for (const [profile, callers] of Object.entries(fixture.rules)) {
    for (const [caller, result] of Object.entries(callers)) {
      for (const [query, label] of [
        ['root', 'RunQuery at the root'],
        ['underDocument', 'RunQuery under top/parent'],
        ['listen', 'Listen at the root'],
      ]) {
        const code = result[query];
        const documents = result[`${query}Documents`];
        items.push({
          id: `rules/${profile}/${caller}/${query}`,
          scenario: `Rules "${profile}" for a kindless query`,
          title: `${caller}: ${label}`,
          request: `${label} as ${caller} (rules ${profile})`,
          answer: code === 0 ? `OK${documents ? ` · first documents ${documents.join(', ')}` : ''}` : grpcName(code),
        });
      }
    }
  }
  const databases = fixture.databases;
  const dbItems = [
    ['named', 'kindless query on the named database', databases.named],
    ['default', 'kindless query on (default)', databases.default],
    ['after-recursive-delete/named', 'named database after recursiveDelete on (default)', databases.afterRecursiveDelete?.named],
    ['after-recursive-delete/default', '(default) after recursiveDelete on the named database', databases.afterRecursiveDelete?.default],
  ];
  for (const [id, label, value] of dbItems) {
    if (value === undefined) continue;
    const documents = Array.isArray(value) ? value : value.documents;
    items.push({
      id: `databases/${id}`,
      scenario: 'One database never sees another',
      title: label,
      request: label,
      answer: `${Array.isArray(value) ? 'OK' : grpcName(value.code)} · ${plural(documents?.length ?? 0, 'document')}`,
    });
  }
  for (const [id, run] of Object.entries(fixture.sdk)) {
    items.push({
      id: `sdk/${id}`,
      scenario: 'Admin SDK recursiveDelete',
      title: id,
      request: `recursiveDelete ${id}`,
      answer: `${run.ok ? 'completed' : `failed${run.error ? `: ${run.error}` : ''}`} · ${plural(run.left?.length ?? 0, 'document')} left`,
    });
  }
  addSet(
    {
      id: dir,
      service: 'firestore',
      area: 'Kindless (all-descendants) queries and recursiveDelete',
      reference: official('Firestore emulator (Java)', fixture.oracle.firestore),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

function listenResume() {
  const dir = 'listen-resume-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const items = Object.entries(fixture.answers).map(([id, answer]) => ({
    id,
    scenario: 'A listener resuming with a token or read time',
    title: id,
    request: `Listen with ${id.replace(/-/g, ' ')}`,
    answer: `${runs(answer.frames)} · ${plural(answer.documents.length, 'document')}`,
  }));
  addSet(
    {
      id: dir,
      service: 'firestore',
      area: 'A listener resuming with a resume token or read time',
      reference: official('Firestore emulator (Java)', fixture.oracle.firestore),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

function restReadOptions() {
  const dir = 'rest-read-options-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const items = fixture.exchanges.map((exchange) => ({
    id: exchange.id,
    scenario: 'REST read masks, transactions and read times',
    title: exchange.id,
    request: `${exchange.method} ${cleanPath(exchange.path)}${exchange.owner ? ' (owner)' : ''}`,
    answer: http(exchange.status, exchange.response),
  }));
  for (const call of fixture.grpc) {
    items.push({
      id: `grpc/${call.id}`,
      scenario: 'The same transaction over gRPC GetDocument',
      title: call.id,
      request: `GetDocument ${call.id}`,
      answer:
        call.status === 0
          ? `OK · ${call.response?.name?.split('/documents/')[1] ?? 'document'} with ${Object.keys(call.response?.fields ?? {}).join(', ') || 'no fields'}`
          : grpc(call.status, call.response?.message ?? call.message),
    });
  }
  addSet(
    {
      id: dir,
      service: 'firestore',
      area: 'REST read projection and consistency selectors',
      reference: official('Firestore emulator (Java)', fixture.oracle.firestore),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

function officialExport() {
  const dir = 'official-export-v1.22.0';
  const metadata = readJson(`${dir}/firebase-export-metadata.json`);
  addSet(
    {
      id: dir,
      service: 'firestore',
      area: 'An official Firestore export on disk',
      reference: official('Firestore emulator (Java)', metadata.firestore.version),
      recordedAt: '2026-08-27',
    },
    [
      {
        id: 'export',
        scenario: 'emulators:export of four synthetic documents',
        title: 'official export',
        request: `firebase emulators:export (firebase-tools ${metadata.version}) of 4 synthetic documents`,
        answer: 'export written: one all_namespaces/all_kinds LevelDB log (output-0) and its metadata files',
      },
    ],
  );
}

function bloom() {
  const dir = 'firestore-bloom-nonmember-false-positive';
  const fixture = readJson(`${dir}/fixture.json`);
  skip(
    dir,
    `${fixture.deterministicReproduction.membership.length} mightContain results`,
    'an offline evaluation of the Firebase JS SDK Bloom class: no request was sent to any emulator or production service',
  );
  addSet(
    {
      id: dir,
      service: 'firestore',
      area: 'Bloom filter false positives in the official client',
      reference: official('Firestore JS SDK (firebase)', fixture.oracle.firebaseVersion),
      recordedAt: day(fixture.capturedAt),
    },
    [],
  );
}

// ------------------------------------------------------ firestore-rules

/** Describes an identity without repeating its Authorization header. */
function identityLabel(header) {
  const match = header.match(/^(bearer|firebase)\s+(.*)$/i);
  if (!match) return header;
  const [, scheme, rest] = match;
  const value = rest.replace(/^<(.*)>$/, '$1');
  const what = /^owner\b/i.test(value)
    ? `the owner credential${value.replace(/^owner/i, '')}`
    : value === 'not-a-jwt'
      ? 'a credential that is not a JWT'
      : value;
  const note = { Bearer: '', bearer: ', lowercase scheme', BEARER: ', all uppercase' }[scheme] ?? `, ${scheme} scheme`;
  return `${what}${note}`;
}

function requestIdentity() {
  const dir = 'request-identity-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const header = new Map(fixture.identities.map((identity) => [identity.id, identityLabel(identity.header)]));
  const restAnswer = (rest) =>
    rest.status === 200 ? '200' : `${rest.status} ${rest.code}${rest.message?.trim() ? `: ${rest.message.trim()}` : ''}`;
  const items = [];
  fixture.reads.forEach((read) => {
    const base = `reads/${read.database}/${read.identity}/${read.path}`;
    const scenario = `Reads as: ${header.get(read.identity) ?? read.identity}`;
    items.push({ id: `${base}/grpc`, scenario, title: `${read.path} on ${read.database} over gRPC`, request: `GetDocument ${read.path} on ${read.database} as ${read.identity}`, answer: grpc(read.grpc.code, read.grpc.message) });
    items.push({ id: `${base}/rest`, scenario, title: `${read.path} on ${read.database} over REST`, request: `GET /v1/…/databases/${read.database}/documents/${read.path} as ${read.identity}`, answer: restAnswer(read.rest) });
  });
  fixture.claims.forEach((claim) => {
    items.push({
      id: `claims/${claim.identity}/${claim.path}`,
      scenario: `What request.auth holds for: ${header.get(claim.identity) ?? claim.identity}`,
      title: claim.path,
      request: `GET ${claim.path} as ${claim.identity}`,
      answer: restAnswer(claim.rest),
    });
  });
  for (const [id, denial] of Object.entries(fixture.denials)) {
    for (const transport of ['grpc', 'rest']) {
      if (!denial[transport]) continue;
      items.push({
        id: `denials/${id}/${transport}`,
        scenario: 'The message of a refused request',
        title: `${id} over ${transport === 'grpc' ? 'gRPC' : 'REST'}`,
        request: `${id === 'create' ? 'create' : 'read'} refused by rules (${id})`,
        answer: transport === 'grpc' ? grpc(denial.grpc.code, denial.grpc.message) : restAnswer(denial.rest),
      });
    }
  }
  fixture.metadata.forEach((entry) => {
    const base = `metadata/${entry.mode}/${entry.identity}`;
    const scenario = 'Metadata operations need the owner';
    items.push({ id: `${base}/grpc`, scenario, title: `ListCollectionIds over gRPC (${entry.mode}, ${entry.identity})`, request: `ListCollectionIds as ${entry.identity} (${entry.mode === 'open' ? 'no rules' : 'with rules'})`, answer: grpc(entry.grpc.code, entry.grpc.message) });
    items.push({ id: `${base}/rest`, scenario, title: `listCollectionIds over REST (${entry.mode}, ${entry.identity})`, request: `POST :listCollectionIds as ${entry.identity} (${entry.mode === 'open' ? 'no rules' : 'with rules'})`, answer: restAnswer(entry.rest) });
    items.push({ id: `${base}/partition`, scenario, title: `PartitionQuery over gRPC (${entry.mode}, ${entry.identity})`, request: `PartitionQuery as ${entry.identity} (${entry.mode === 'open' ? 'no rules' : 'with rules'})`, answer: grpc(entry.partition.code, entry.partition.message) });
  });
  fixture.pipelines.forEach((entry) => {
    for (const kind of ['pipeline', 'query']) {
      items.push({
        id: `pipelines/${entry.identity}/${kind}`,
        scenario: 'Enterprise pipelines are evaluated as a list',
        title: `${kind} as ${entry.identity}`,
        request: `Enterprise ${kind === 'pipeline' ? 'ExecutePipeline' : 'RunQuery'} as ${entry.identity}`,
        answer: grpc(entry[kind].code, entry[kind].message),
      });
    }
  });
  fixture.reload.forEach((entry) => {
    items.push({
      id: `reload/${entry.body}`,
      scenario: 'The rules reload route reads the body as JSON',
      title: entry.body,
      request: `PUT /emulator/v1/projects/…:securityRules (${entry.body} body)`,
      answer: `${entry.status} · the new rules then govern a read (${entry.governs})`,
    });
  });
  skip(dir, `sdkHeaders (${fixture.sdkHeaders.length})`, 'what each SDK sends, recorded by a listener that refuses every request; not an emulator answer');
  addSet(
    {
      id: dir,
      service: 'firestore-rules',
      area: 'Who a Firestore request is from: tokens, owner, claims and denials',
      reference: official('Firestore emulator (Java)', fixture.oracle.firestore),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

function ruleBindings() {
  const dir = 'rule-bindings-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const items = fixture.profiles.map((profile) => {
    const condition = profile.source.match(/allow [^;]*;/)?.[0] ?? '';
    const fn = profile.source.match(/function [^{]*\{[^}]*\}/)?.[0] ?? '';
    return {
      id: `${profile.name}/${profile.kind}`,
      scenario: `The identifier "${profile.name}" in each position`,
      title: `${profile.name} as a ${profile.kind}`,
      request: `install rules using "${profile.name}" as a ${profile.kind}: ${fn || condition}`,
      answer: profile.status === 200 ? '200 rules installed' : `${profile.status} ${summarize(profile.response).replace(/^INVALID_ARGUMENT: /, '')}`,
    };
  });
  addSet(
    {
      id: dir,
      service: 'firestore-rules',
      area: 'Which identifiers rules accept as parameters, variables and wildcards',
      reference: official('Firestore emulator (Java)', fixture.oracle.firestore),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

function rulesDocumentPaths() {
  const dir = 'rules-document-paths-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  // Each row allows one signed-out request only if an expression holds; the
  // capture's shared plan names the expression (get c/x, list c, create c/new).
  const planned = (id) => {
    if (PATHS_PLAN.EXPRESSIONS?.[id]) return ['get c/x', PATHS_PLAN.EXPRESSIONS[id]];
    if (PATHS_PLAN.LISTS?.[id]) return ['list c', PATHS_PLAN.LISTS[id]];
    if (PATHS_PLAN.CREATES?.[id]) return ['create c/new', PATHS_PLAN.CREATES[id]];
    return null;
  };
  const items = Object.entries(fixture.answers).map(([id, answer]) => ({
    id,
    scenario: PATHS_PLAN.LISTS?.[id]
      ? 'Document names under allow list'
      : PATHS_PLAN.CREATES?.[id]
        ? 'Document names under allow create'
        : 'Paths and document names under allow get',
    title: id,
    request: planned(id) ? `${planned(id)[0]}: ${planned(id)[1]}` : `signed-out request allowed only if: ${id.replace(/-/g, ' ')}`,
    answer:
      answer.rulesRefused !== undefined
        ? `rules refused (${answer.rulesRefused})`
        : answer.status === 200
          ? '200 (expression held)'
          : `${answer.status} (expression false or an error)`,
  }));
  addSet(
    {
      id: dir,
      service: 'firestore-rules',
      area: 'Paths and document names in Security Rules',
      reference: official('Firestore emulator (Java)', fixture.oracle.firestore),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

function rulesUnitTesting() {
  const dir = 'rules-unit-testing-v1';
  skip(dir, 'rules and exported test files', 'the 31 tests run live against both targets; no answer is recorded in the fixture');
  addSet(
    {
      id: dir,
      service: 'firestore-rules',
      area: '@firebase/rules-unit-testing against the emulators',
      reference: official('Firestore and Storage emulators (firebase-tools)', '15.34.0'),
      recordedAt: null,
    },
    [],
  );
}

// ------------------------------------------------------- developer tools

const allowLine = (source) => (source.match(/allow [^;]*;/g) ?? []).join(' ').trim();

function developerToolsCoverage() {
  const dir = 'developer-tools-coverage-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const reportSize = (report) => {
    let n = 0;
    const walk = (nodes) => {
      for (const node of nodes ?? []) {
        n += 1;
        walk(node.children);
      }
    };
    walk(report);
    return n;
  };
  const items = [
    {
      id: 'seed',
      scenario: 'Setup',
      title: 'owner seed',
      request: `${fixture.seed.method} ${cleanPath(fixture.seed.path)} (owner)`,
      answer: http(fixture.seed.status, fixture.seed.response),
    },
  ];
  for (const profile of fixture.profiles) {
    const after = profile.after?.report;
    items.push({
      id: `profiles/${profile.id}`,
      scenario: 'Coverage after a rules reload and two reads',
      title: profile.id,
      request: `reload rules, read twice, GET :ruleCoverage: ${allowLine(profile.source)}`,
      answer: `read ${profile.status} · ${after ? `coverage report with ${plural(reportSize(after), 'expression')}` : 'no report (constant rules)'}`,
    });
  }
  items.push({
    id: 'invalid-reload',
    scenario: 'A rejected reload keeps the last valid rules',
    title: fixture.invalidReload.id,
    request: `${fixture.invalidReload.method} ${cleanPath(fixture.invalidReload.path)} (source "broken")`,
    answer: http(fixture.invalidReload.status, fixture.invalidReload.response),
  });
  items.push({
    id: 'after-invalid-reload',
    scenario: 'A rejected reload keeps the last valid rules',
    title: 'coverage after the rejected reload',
    request: 'GET :ruleCoverage after the rejected reload',
    answer: `coverage of the last valid rules, ${plural(reportSize(fixture.afterInvalidReload.report), 'expression')}`,
  });
  fixture.compileRejections.forEach((rejection, index) => {
    items.push({
      id: `compile-rejections/${index + 1}`,
      scenario: 'A rejected reload keeps the last valid rules',
      title: 'namespace name as a function parameter',
      request: `PUT :securityRules with ${(rejection.source.match(/function [^{]*/)?.[0] ?? 'a function').trim()}`,
      answer: http(rejection.status, rejection.data),
    });
  });
  addSet(
    {
      id: dir,
      service: 'firestore-rules',
      area: 'Rules expression coverage reports',
      reference: official('Firestore emulator (Java)', fixture.oracle.firestore),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

function evaluationMessage(message) {
  if (Array.isArray(message)) return `history replay of ${plural(message.length, 'evaluation')}`;
  const context = message.rulesContext ?? {};
  return `${message.outcome} ${context.method ?? ''} ${context.path ?? ''}`.trim();
}

function developerToolsRequests(dir, area, expectedLive) {
  const fixture = readJson(`${dir}/fixture.json`);
  const items = fixture.operations.map((operation) => ({
    id: `operations/${operation.id}`,
    scenario: 'Firestore requests with live rules evaluations',
    title: operation.id,
    request: `${operation.method} ${cleanPath(operation.path)}${operation.authenticated ? ' (signed in)' : ''}`,
    answer: `${http(operation.status, operation.response)} · ${plural(operation.endMessage - operation.firstMessage, 'evaluation message')}`,
  }));
  fixture.messages.forEach((message, index) => {
    items.push({
      id: `messages/${index}`,
      scenario: 'Requests websocket messages',
      title: index === 0 ? 'initial history' : `evaluation ${message.requestId}`,
      request: index === 0 ? 'connect to the requests websocket' : `rules evaluation event ${index}`,
      answer: index === 0 ? (Array.isArray(message) && !message.length ? 'empty history' : evaluationMessage(message)) : evaluationMessage(message),
    });
  });
  if (expectedLive !== undefined) {
    declare(dir, 'README: HTTP operations', expectedLive.operations, fixture.operations.length);
    declare(dir, 'README: live evaluation messages + initial history', expectedLive.messages + 1, fixture.messages.length);
  }
  addSet(
    { id: dir, service: 'firestore-rules', area, reference: official('Firestore emulator (Java)', fixture.oracle.firestore), recordedAt: day(fixture.capturedAt) },
    items,
  );
}

function developerToolsListing() {
  const dir = 'developer-tools-listing-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const items = fixture.exchanges.map((exchange) => ({
    id: exchange.id,
    scenario: 'Collection ids, document listing, masks and page tokens',
    title: exchange.id,
    request: `${exchange.method} ${cleanPath(exchange.path)}${exchange.owner ? ' (owner)' : ''}`,
    answer:
      exchange.status === 200 && Array.isArray(exchange.response?.documents)
        ? `200 · ${plural(exchange.response.documents.length, 'document')}${exchange.response.nextPageToken ? ', next page token' : ''}`
        : exchange.status === 200 && Array.isArray(exchange.response?.collectionIds)
          ? `200 · ${plural(exchange.response.collectionIds.length, 'collection id')}${exchange.response.nextPageToken ? ', next page token' : ''}`
          : http(exchange.status, exchange.response),
  }));
  declare(dir, 'README: exchanges', 22, items.length);
  addSet(
    {
      id: dir,
      service: 'firestore',
      area: 'Firestore REST listing: collection ids, documents, masks, page tokens',
      reference: official('Firestore emulator (Java)', fixture.oracle.firestore),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

function developerToolsMain() {
  const dir = 'developer-tools-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const items = fixture.observations.map((observation) => ({
    id: `observations/${observation.id}`,
    scenario: 'Rules coverage and requests over HTTP',
    title: observation.id,
    request: `${observation.method} ${cleanPath(observation.path)}${observation.admin ? ' (owner)' : ''}`,
    answer: http(observation.status, observation.body),
  }));
  fixture.websocket.firstConnection.forEach((message, index) => {
    items.push({
      id: `websocket/first/${index}`,
      scenario: 'Requests websocket: history and live evaluations',
      title: index === 0 ? 'initial history' : `evaluation ${message.requestId}`,
      request: index === 0 ? 'connect to the requests websocket' : `rules evaluation event ${index}`,
      answer: index === 0 && Array.isArray(message) && !message.length ? 'empty history' : evaluationMessage(message),
    });
  });
  fixture.websocket.reconnected.forEach((message, index) => {
    items.push({
      id: `websocket/reconnected/${index}`,
      scenario: 'Requests websocket: history and live evaluations',
      title: 'after reconnecting',
      request: 'reconnect to the requests websocket',
      answer: evaluationMessage(message),
    });
  });
  fixture.browser.exchanges.forEach((exchange, index) => {
    items.push({
      id: `ui/${index + 1}`,
      scenario: 'Emulator UI pages driving each emulator',
      title: `${exchange.service} ${exchange.method}`,
      request: `${exchange.method} ${cleanPath(exchange.path)}${exchange.queryKeys?.length ? ` (query: ${exchange.queryKeys.filter((k) => !SECRET_QUERY.has(k.toLowerCase())).join(', ')})` : ''}`,
      answer: http(exchange.status, exchange.response),
    });
  });
  items.push({
    id: 'ui/config',
    scenario: 'Emulator UI pages driving each emulator',
    title: 'UI config',
    request: 'GET /api/config',
    answer: `200 · project ${fixture.config.projectId}, ${plural(Object.keys(fixture.config).filter((k) => fixture.config[k]?.listen || fixture.config[k]?.host).length, 'service')} listed`,
  });
  skip(dir, `browser.checks (${fixture.browser.checks.length})`, 'rendering checks of the official UI page, not answers to a request');
  addSet(
    {
      id: dir,
      service: 'suite',
      area: 'The Emulator UI: overview, requests, coverage, data, auth and storage pages',
      reference: official('Emulator suite and UI (firebase-tools)', fixture.oracle.firebaseTools),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
  return day(fixture.capturedAt);
}

function developerToolsBuckets(recordedAt) {
  const dir = 'developer-tools-buckets-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const items = fixture.exchanges.map((exchange, index) => ({
    id: `${index + 1}`,
    scenario: 'Default bucket discovery',
    title: `bucket list ${index + 1}`,
    request: `${exchange.method} ${cleanPath(exchange.path)}`,
    answer: `${exchange.status} · ${plural(exchange.response?.items?.length ?? 0, 'bucket')}: ${(exchange.response?.items ?? []).map((item) => item.name).join(', ')}`,
  }));
  addSet(
    {
      id: dir,
      service: 'storage',
      area: 'Default bucket discovery by the Emulator UI',
      reference: official('Storage emulator (firebase-tools)', fixture.oracle.firebaseTools),
      // No capture time of its own: extracted from the developer-tools-v1 UI recording.
      recordedAt,
    },
    items,
  );
}

function developerToolsFunctionsLifecycle() {
  const dir = 'developer-tools-functions-lifecycle-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const items = [
    {
      id: 'invoke',
      scenario: 'Functions emulator shutdown after one HTTP invocation',
      title: 'one HTTP invocation',
      request: `${fixture.exchange.method} ${cleanPath(fixture.exchange.path)}`,
      answer: http(fixture.exchange.status, fixture.exchange.body),
    },
    {
      id: 'shutdown',
      scenario: 'Functions emulator shutdown after one HTTP invocation',
      title: 'SIGINT',
      request: 'SIGINT to firebase emulators:start',
      answer: `stopped in ${Math.round(fixture.shutdownMilliseconds)} ms, exit code ${fixture.exit[0]}`,
    },
  ];
  addSet(
    {
      id: dir,
      service: 'suite',
      area: 'The CLI drains and exits after one Functions invocation',
      reference: official('Functions emulator (firebase-tools)', fixture.oracle.firebaseTools),
      // No capture time recorded in the fixture; first committed on this date.
      recordedAt: '2026-09-11',
    },
    items,
  );
}

// ------------------------------------------------------------ functions

function functionsReadiness() {
  const dir = 'functions-readiness-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const items = fixture.observations.map((observation) => {
    const backends = observation.inventory?.backends ?? [];
    const triggers = observation.triggerRecords ?? [];
    const ignored = triggers.filter((record) => record.ignored).length;
    return {
      id: `startup/${observation.mode}`,
      scenario: 'Functions startup: inventory and trigger records',
      title: observation.mode,
      request: `start Functions (${observation.mode.replace(/-/g, ' ')}), then GET /backends`,
      answer: `${observation.connectError ? `connect error: ${observation.connectError}` : observation.status} · ${plural(backends.length, 'backend')}, ${plural(triggers.length, 'trigger record')}${ignored ? ` (${ignored} ignored)` : ''}`,
    };
  });
  for (const auxiliary of fixture.auxiliary) {
    auxiliary.fixture.exchanges.forEach((exchange, index) => {
      items.push({
        id: `auxiliary/${auxiliary.name}/${index + 1}`,
        scenario: 'Registration with the auxiliary emulators at startup',
        title: `${auxiliary.name} registration`,
        request: `${exchange.request.method} ${cleanPath(exchange.request.uri ?? exchange.request.path)}`,
        answer: http(exchange.response.status, exchange.response.bodyBase64 ? base64Text(exchange.response.bodyBase64) : exchange.response.body),
      });
    });
  }
  addSet(
    {
      id: dir,
      service: 'functions',
      area: 'Functions startup: inventory, failed codebases and auxiliary registration',
      reference: official('Functions emulator (firebase-tools)', fixture.targetVersion),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

function functionsTopicReload() {
  const dir = 'functions-topic-reload-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const items = fixture.observations.map((observation) => ({
    id: observation.stage,
    scenario: 'Pub/Sub delivery across a Functions source reload',
    title: observation.stage,
    request: `publish to ${observation.topic} (${observation.stage.replace(/-/g, ' ')})`,
    answer: `delivered to ${observation.delivered.handler} v${observation.delivered.version} · ${plural(observation.registeredIds.length, 'registered function')}`,
  }));
  addSet(
    {
      id: dir,
      service: 'functions',
      area: 'Pub/Sub triggers follow a Functions source reload',
      reference: official('Functions and Pub/Sub emulators (firebase-tools)', fixture.firebaseTools),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

// -------------------------------------------------------------- storage

function storageDemoTargets() {
  const dir = 'storage-demo-targets-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const items = [];
  for (const entry of fixture.cases) {
    const scenario = `Storage targets: ${entry.id.replace(/-/g, ' ')}`;
    items.push({
      id: `${entry.id}/start`,
      scenario,
      title: 'start',
      request: `firebase emulators:start --only storage for ${entry.project} (targets ${entry.targets.join(', ')})`,
      answer: entry.started ? `started${entry.notices?.length ? ` · ${entry.notices[0]}` : ''}` : `did not start, exit ${entry.exitCode}: ${entry.error ?? ''}`,
    });
    for (const [bucket, status] of Object.entries(entry.uploads ?? {})) {
      items.push({
        id: `${entry.id}/upload/${bucket}`,
        scenario,
        title: `upload to ${bucket}`,
        request: `POST /v0/b/${bucket}/o (signed out)`,
        answer: String(status),
      });
    }
  }
  addSet(
    {
      id: dir,
      service: 'storage',
      area: 'Storage targets that map to no bucket',
      reference: official('Storage emulator (firebase-tools)', fixture.oracle.firebaseTools),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

function uploadAnswer(entry) {
  const parts = [String(entry.status)];
  if (entry.uploadStatus) parts.push(`upload ${entry.uploadStatus}`);
  if (entry.sizeReceived !== null && entry.sizeReceived !== undefined) parts.push(`${entry.sizeReceived} bytes received`);
  if (entry.chunkGranularity) parts.push(`chunk granularity ${entry.chunkGranularity}`);
  if (entry.body?.error) parts.push(summarize(entry.body));
  else if (entry.body?.name) parts.push(`object ${entry.body.name}`);
  return parts.join(' · ');
}

function storageNativeClients() {
  const dir = 'storage-native-clients-v1';
  const fixture = readJson(`${dir}/fixture.json`);
  const items = [];
  for (const [section, scenario] of [
    ['uploads', 'Resumable, multipart and media uploads as the native SDKs send them'],
    ['downloads', 'Downloads as the native SDKs send them'],
    ['tokens', 'Download token routes'],
  ]) {
    for (const [id, entry] of Object.entries(fixture[section])) {
      items.push({ id: `${section}/${id}`, scenario, title: id, request: `${section.replace(/s$/, '')} ${id.replace(/-/g, ' ')}`, answer: uploadAnswer(entry) });
    }
  }
  const cors = fixture.cors;
  items.push({ id: 'cors/preflight', scenario: 'CORS for native and web clients', title: 'preflight', request: 'OPTIONS preflight with every upload header', answer: `${cors.preflight.ok ? 'allowed' : 'refused'} · methods ${cors.preflight.allowMethods.join(', ')}` });
  items.push({ id: 'cors/privateNetwork', scenario: 'CORS for native and web clients', title: 'private network', request: 'OPTIONS preflight asking for private network access', answer: `access-control-allow-private-network: ${cors.privateNetwork}` });
  items.push({ id: 'cors/exposed', scenario: 'CORS for native and web clients', title: 'exposed headers', request: 'response headers a browser may read', answer: `exposes ${cors.exposed.join(', ')}` });
  for (const [profile, prefixes] of Object.entries(fixture.lists)) {
    for (const [prefix, result] of Object.entries(prefixes)) {
      items.push({
        id: `lists/${profile}/${prefix}`,
        scenario: `List rules: ${profile}`,
        title: `list ${prefix}`,
        request: `GET /v0/b/…/o?prefix=${prefix === '(root)' ? '' : encodeURIComponent(prefix)} under ${NATIVE_PLAN.listRules?.[profile] ?? `rules ${profile}`}`,
        answer: result.status === 200 ? `200 · ${plural(result.items?.length ?? 0, 'item')}, ${plural(result.prefixes?.length ?? 0, 'prefix', 'prefixes')}` : String(result.status),
      });
    }
  }
  addSet(
    {
      id: dir,
      service: 'storage',
      area: 'Storage as the iOS, Android and web SDKs call it',
      reference: official('Storage emulator (firebase-tools)', fixture.oracle.firebaseTools),
      recordedAt: day(fixture.capturedAt),
    },
    items,
  );
}

// ------------------------------------------------------ firebase-suite-v1

function suiteObservations(rel, scenario, observations) {
  return observations.map((observation) => ({
    id: `${rel}/${observation.id}`,
    scenario,
    title: observation.id,
    request: `${observation.method} ${cleanPath(observation.path)}`,
    answer: http(observation.status, observation.response),
  }));
}

// Subdirectories of firebase-suite-v1 whose fixture states no hypothesis.
const SUITE_SCENARIOS = {
  'functions-callable-http-and-error-contract': 'Callable and HTTP functions: envelopes, typed errors and unknown functions',
  'hub-locator-export-and-background-controls': 'Hub locator, emulator map, export and the origin guard',
  'pubsub-schedule-and-function-dispatch': 'Function topics, schedules and background-trigger controls',
  'ui-config-logging-and-websocket': 'UI config, index page and the logging websocket',
};

function firebaseSuite() {
  const root = 'firebase-suite-v1';
  const groups = new Map();
  const add = (key, meta, items, date) => {
    if (!groups.has(key)) groups.set(key, { meta, items: [], dates: [] });
    const group = groups.get(key);
    group.items.push(...items);
    group.dates.push(date);
  };
  const HTTP_OBSERVATIONS = new Set([
    'auth-browser-oauth-and-token-refresh',
    'auth-identity-toolkit-and-admin',
    'auth-import-export-and-trigger-dispatch',
    'functions-callable-http-and-error-contract',
    'hub-locator-export-and-background-controls',
    'pubsub-schedule-and-function-dispatch',
    'storage-firebase-v0-and-download-tokens',
    'storage-gcs-json-and-resumable-upload',
    'storage-multi-bucket-rules-and-import-export',
    'ui-config-logging-and-websocket',
  ]);
  const META = {
    auth: { id: `${root}/auth`, service: 'auth', area: 'Auth through the emulator suite: browser flows, popups, refresh and import/export', reference: REF.auth },
    storage: { id: `${root}/storage`, service: 'storage', area: 'Storage through the emulator suite: v0 and GCS routes, encodings, pagination', reference: REF.storage },
    functions: { id: `${root}/functions`, service: 'functions', area: 'Functions through the emulator suite: callable and HTTP contract, discovery', reference: REF.functions },
    triggers: { id: `${root}/firestore-triggers`, service: 'functions', area: 'Firestore trigger registration and v1/v2 dispatch to Functions', reference: REF.java },
    pubsub: { id: `${root}/pubsub`, service: 'pubsub', area: 'Pub/Sub topics, schedules and function dispatch in the suite', reference: official('Pub/Sub emulator with Functions (firebase-tools 15.22.0)', '0.8.33') },
    suite: { id: `${root}/suite`, service: 'suite', area: 'Hub, UI config, logging, startup, shutdown and restart', reference: REF.suite },
    export: { id: `${root}/firestore-export`, service: 'firestore', area: 'Importing a multi-shard export', reference: official('Firestore emulator (Java)', '1.22.0') },
  };
  const groupOf = (name) => {
    if (name.startsWith('auth-')) return 'auth';
    if (name.startsWith('storage-')) return 'storage';
    if (name.startsWith('functions-')) return 'functions';
    if (name.startsWith('firestore-trigger-')) return 'triggers';
    if (name.startsWith('pubsub-')) return 'pubsub';
    if (name.startsWith('firestore-multi-shard-export')) return 'export';
    if (/^(hub|suite|ui)-/.test(name)) return 'suite';
    throw new Error(`${root}: no service for ${name}`);
  };
  for (const name of subdirs(root)) {
    const rel = `${root}/${name}`;
    const fixture = readJson(`${rel}/fixture.json`);
    const key = groupOf(name);
    const date = fixture.capturedAt;
    const scenario = fixture.hypothesis ?? SUITE_SCENARIOS[name] ?? name.replace(/-/g, ' ');
    let items = [];
    if (HTTP_OBSERVATIONS.has(name)) {
      items = suiteObservations(name, scenario, fixture.observations);
      if (exists(`${rel}/decoded-contract.json`)) {
        declare(rel, 'decoded-contract operationCount', readJson(`${rel}/decoded-contract.json`).operationCount, items.length);
      }
      if (name === 'ui-config-logging-and-websocket') {
        fixture.websocketMessages.forEach((message, index) => {
          items.push({
            id: `${name}/logging-websocket/${index + 1}`,
            scenario,
            title: `logging websocket message ${index + 1}`,
            request: 'connect to the logging websocket',
            answer: `${message.level}: ${message.message}`,
          });
        });
      }
      for (const extra of ['dispatches', 'deliveredEvents', 'exportInventory']) {
        if (Array.isArray(fixture[extra])) {
          skip(rel, `${extra} (${fixture[extra].length})`, 'side effects of the counted requests (calls the emulator made, files it wrote), replayed with those requests');
        }
      }
    } else if (name === 'auth-popup' || name === 'auth-popup-insecure-origin') {
      const observation = fixture.observation;
      const where = name === 'auth-popup' ? 'loopback origin' : `insecure origin ${fixture.browserHost}`;
      const flowScenario = `Sign-in popup and redirect in a real browser (${where})`;
      // The three validation requests the capture sends (src/suite/auth-popup-browser.mjs).
      const queries = ['', '?apiKey=demo', '?providerId=google.com'];
      observation.validation.forEach((entry, index) => {
        items.push({
          id: `${name}/validation/${index + 1}`,
          scenario: flowScenario,
          title: `handler validation ${index + 1}`,
          request: `GET /emulator/auth/handler${queries[index] ?? ''}`,
          answer: http(entry.status, entry.body),
        });
      });
      observation.exchanges.forEach((exchange, index) => {
        items.push({
          id: `${name}/sign-in/${index + 1}`,
          scenario: flowScenario,
          title: `signInWithIdp ${index + 1}`,
          request: `POST /identitytoolkit.googleapis.com/v1/accounts:signInWithIdp (${exchange.providerId}, from ${exchange.requestUriPath})`,
          answer: `${exchange.status}${exchange.error ? ` ${exchange.error}` : ''} · ${exchange.isNewUser ? 'new user' : exchange.existingUidReused ? 'existing uid reused' : 'signed in'}`,
        });
      });
      observation.events.forEach((event, index) => {
        items.push({
          id: `${name}/event/${index + 1}`,
          scenario: flowScenario,
          title: `popup event ${index + 1}`,
          request: `${event.responsePath} page completes the ${event.provider} popup`,
          answer: `${event.type} event${event.error ? ` error ${event.error}` : ''} with ${event.responseKeys.join(', ')}`,
        });
      });
      if (name === 'auth-popup' && exists(`${rel}/account-safety.json`)) {
        const safety = readJson(`${rel}/account-safety.json`).observation;
        const safetyScenario = 'An IdP sign-in reuses a linked account and honours disabling';
        items.push({ id: `${name}/account-safety/sign-in`, scenario: safetyScenario, title: 'sign in to a linked account', request: 'POST /identitytoolkit.googleapis.com/v1/accounts:signInWithIdp (account linked to github.com and google.com)', answer: `${safety.signInStatus} · ${safety.existingUidReused ? 'existing uid reused' : 'new uid'}` });
        items.push({ id: `${name}/account-safety/disabled`, scenario: safetyScenario, title: 'sign in after disabling', request: 'POST /identitytoolkit.googleapis.com/v1/accounts:signInWithIdp (account disabled)', answer: `${safety.disabledStatus} ${safety.disabledError}` });
      }
      skip(rel, `observation.stages (${observation.stages.length})`, 'names of the browser stages that passed, not answers');
    } else if (name === 'auth-refresh-reuse') {
      const scenarioFor = (id) => `Refresh grants reused: ${id.split('-')[0]} sign-in`;
      const answer = (observation) =>
        observation.status === 200
          ? `200 · ${observation.sameRefreshToken ? 'same refresh grant returned' : 'new refresh grant'}, expires in ${observation.expiresIn}`
          : `${observation.status} ${observation.error ?? ''}`.trim();
      for (const observation of fixture.observations) {
        items.push({ id: `${name}/${observation.id}`, scenario: scenarioFor(observation.id), title: observation.id, request: `POST /securetoken.googleapis.com/v1/token (refresh grant, ${observation.id.replace(/-/g, ' ')})`, answer: answer(observation) });
      }
      for (const observation of fixture.browser.observations) {
        items.push({ id: `${name}/browser/${observation.id}`, scenario: 'Refresh from the browser SDK: forced, two tabs, reload', title: observation.id, request: `POST /securetoken.googleapis.com/v1/token from the browser SDK (${observation.id.replace(/-/g, ' ')})`, answer: answer(observation) });
      }
      declare(rel, 'README: 28 HTTP + 4 browser observations', 32, items.length);
    } else if (name === 'firestore-multi-shard-export-metadata') {
      items.push({
        id: `${name}/import`,
        scenario: 'Importing an export split across LevelDB shards',
        title: 'import',
        request: `import an export of ${plural(fixture.inputFiles.length, 'shard')}`,
        answer: `${fixture.observations.importAccepted ? 'import accepted' : 'import refused'} · ${plural(fixture.observations.verifiedDocuments, 'document')} verified`,
      });
    } else if (name === 'firestore-trigger-registration-and-v1-v2-dispatch') {
      for (const registration of fixture.registrations) {
        items.push({ id: `${name}/${registration.id}`, scenario, title: registration.id, request: `${registration.method} ${cleanPath(registration.path)}`, answer: http(registration.status, registration.response) });
      }
      items.push({ id: `${name}/write`, scenario, title: 'document write', request: `${fixture.write.method} ${cleanPath(fixture.write.path)}`, answer: http(fixture.write.status, fixture.write.responseShape) });
      fixture.dispatches.forEach((dispatch, index) => {
        items.push({ id: `${name}/dispatch/${index + 1}`, scenario, title: `dispatch ${index + 1}`, request: 'the document write, as dispatched to Functions', answer: `${dispatch.method} ${cleanPath(dispatch.path)} with ${summarize(dispatch.body)}` });
      });
    } else if (name === 'functions-startup-discovery') {
      for (const observation of fixture.observations) {
        items.push({
          id: `${name}/${observation.mode}`,
          scenario: 'Functions discovery at startup and after a source change',
          title: observation.mode,
          request: `start Functions and change the source (${observation.mode.replace(/-/g, ' ')})`,
          answer: `${plural(observation.startupCalls, 'startup discovery call')} · after reload ${observation.afterReloadIds.join(', ')}${observation.sourceWatcherRediscovered ? ' (rediscovered)' : ''}`,
        });
      }
    } else if (name === 'storage-content-encoding') {
      const probes = fixture.recordings.filter((recording) => recording.label.startsWith('probe:')).length;
      declare(rel, 'probe recordings = sum of objects[].observations', fixture.objects.reduce((sum, object) => sum + object.observations.length, 0), probes);
      fixture.recordings.forEach((recording, index) => {
        items.push({
          id: `${name}/${index + 1}`,
          scenario: `gzip content encoding: ${recording.label.replace(/^probe:/, '')}`,
          title: recording.label,
          request: `${recording.method} ${cleanPath(recording.path)}`,
          answer: `${recording.status}${recording.responseHeaders?.['content-encoding'] ? ` · content-encoding ${recording.responseHeaders['content-encoding']}` : ''}${recording.responseBody?.byteLength !== undefined ? ` · ${recording.responseBody.byteLength} bytes` : ''}`,
        });
      });
      skip(rel, `objects (${fixture.objects.length}) and exported (${fixture.exported.length})`, 'objects[] indexes the probe recordings already counted; exported[] are the files an export wrote');
    } else if (name === 'storage-list-pagination') {
      for (const observation of fixture.observations) {
        const route = observation.id.startsWith('gcs') ? 'GET /storage/v1/b/…/o' : 'GET /v0/b/…/o';
        items.push({
          id: `${name}/${observation.id}`,
          scenario: `List pagination over ${fixture.objectCorpus.count} objects`,
          title: observation.id,
          request: `${route} (${observation.id.replace(/^(gcs|firebase)-/, '').replace(/-/g, ' ')})`,
          answer: `${observation.status} · ${plural(observation.itemCount, 'item')}${observation.nextPageToken ? `, next page token ${observation.nextPageToken}` : ', no next page'}`,
        });
      }
      items.push({
        id: `${name}/sdk-autopagination`,
        scenario: `List pagination over ${fixture.objectCorpus.count} objects`,
        title: 'SDK autopagination',
        request: `@google-cloud/storage ${fixture.sdkAutopagination.packageVersion} getFiles() with autopagination`,
        answer: `${plural(fixture.sdkAutopagination.count, 'object')}, ${fixture.sdkAutopagination.first} to ${fixture.sdkAutopagination.last}`,
      });
    } else if (name === 'storage-missing-object') {
      for (const probe of fixture.probes) {
        items.push({
          id: `${name}/${probe.api}-${probe.kind}`,
          scenario: 'A missing object',
          title: `${probe.api} ${probe.kind}`,
          request: `GET ${cleanPath(probe.path)}`,
          answer: `${probe.status} · ${probe.headers?.['content-type'] ?? ''}${probe.body?.base64 ? ` "${textSummary(base64Text(probe.body.base64))}"` : ''}`,
        });
      }
      fixture.browser.events.forEach((event, index) => {
        items.push({
          id: `${name}/browser/${index + 1}`,
          scenario: 'A missing object',
          title: 'browser <img> load',
          request: 'a cross-origin <img> of the missing object',
          answer: `browser ${event.kind} ${event.status} ${event.statusText}, then the element's ${fixture.browser.domEvent} event`,
        });
      });
    } else if (name === 'suite-startup-readiness-shutdown-and-restart') {
      const ready = (readiness) => `ready after ${Math.round(readiness.readyAfterMilliseconds / 1000)} s · ${Object.entries(readiness.statuses).map(([service, status]) => `${service} ${status}`).join(', ')}`;
      const stop = (result) => `${result.clean ? 'clean' : 'not clean'}, exit ${result.exitCode} · locator ${result.locatorDeleted ? 'deleted' : 'kept'}, ports ${result.portsClosed ? 'closed' : 'open'}`;
      const lifecycle = 'Suite startup, shutdown and restart on the same ports';
      items.push({ id: `${name}/first-start`, scenario: lifecycle, title: 'first start', request: 'firebase emulators:start (auth, functions, pubsub)', answer: ready(fixture.firstReadiness) });
      items.push({ id: `${name}/first-stop`, scenario: lifecycle, title: 'first stop', request: 'stop the suite (origin-guarded run)', answer: stop(fixture.firstStop) });
      items.push({ id: `${name}/restart`, scenario: lifecycle, title: 'restart', request: 'start the suite again on the same ports', answer: ready(fixture.restartReadiness) });
      items.push({ id: `${name}/${fixture.restartHub.id}`, scenario: lifecycle, title: fixture.restartHub.id, request: `${fixture.restartHub.method} ${cleanPath(fixture.restartHub.path)} on the hub`, answer: http(fixture.restartHub.status, fixture.restartHub.response) });
      items.push({ id: `${name}/second-stop`, scenario: lifecycle, title: 'second stop', request: 'stop the suite (control run)', answer: stop(fixture.secondStop) });
    } else {
      throw new Error(`${rel}: no extractor`);
    }
    add(key, META[key], items, date);
  }
  for (const { meta, items, dates } of groups.values()) {
    addSet({ ...meta, recordedAt: latestDay(...dates) }, items);
  }
}

// ------------------------------------------------------------- the sets

/**
 * With --history, a set whose directory a past release did not have yet is
 * left out as not recorded then; any other failure still stops the run, so a
 * release is never counted short because a format changed.
 */
const HISTORY = process.argv.includes('--history');
const absent = [];
function attempt(run) {
  if (!HISTORY) return run();
  try {
    return run();
  } catch (error) {
    const missing = error?.code === 'ENOENT' && typeof error.path === 'string' ? error.path : null;
    const top = missing && missing.startsWith(FIXTURES) ? missing.slice(FIXTURES.length).split('/')[0] : null;
    if (top && !existsSync(join(FIXTURES, top))) {
      absent.push(top);
      return undefined;
    }
    throw error;
  }
}

function build() {
  attempt(() => authPrograms('auth-v1', 'Every Auth operation over raw HTTP'));
  attempt(() => authPrograms('auth-claims-length-v1', 'Custom claims length measured in UTF-16 code units'));
  attempt(() => pubsubPrograms());
  attempt(() => functionsPrograms('functions-runtime-v1', 'functions', 'Functions and Extensions runtime: routes, callables, events, environment', REF.functions));
  attempt(() => functionsPrograms('tasks-v1', 'tasks', 'Task queue functions: registration, dispatch, delete and the Admin SDK', REF.tasks));
  attempt(() => storageRules());
  attempt(() => rulesV2());
  attempt(() => contributedRooms());
  attempt(() => wireSets('rest-v1', 'rest', 'Browser REST calls: aggregation, transactions, CORS'));
  attempt(() => wireSets('webchannel-v8', 'webchannel', 'Browser WebChannel: Listen and Write streams, framing, errors'));
  skip('webchannel-v8', 'firebase-js-sdk-*.json', 'CI evidence about the JS SDK integration tests, not a recording');
  attempt(() => documentMap());
  attempt(() => kindlessQuery());
  attempt(() => listenResume());
  attempt(() => restReadOptions());
  attempt(() => officialExport());
  attempt(() => bloom());
  attempt(() => requestIdentity());
  attempt(() => ruleBindings());
  attempt(() => rulesDocumentPaths());
  attempt(() => rulesUnitTesting());
  attempt(() => developerToolsCoverage());
  attempt(() => developerToolsRequests('developer-tools-request-metadata-v1', 'Rules evaluation context of queries, writes and transactions', { operations: 23, messages: 25 }));
  attempt(() => developerToolsRequests('developer-tools-request-values-v1', 'Rules evaluation context of typed request values'));
  attempt(() => developerToolsListing());
  const uiDate = attempt(() => developerToolsMain());
  attempt(() => developerToolsBuckets(uiDate));
  attempt(() => developerToolsFunctionsLifecycle());
  attempt(() => functionsReadiness());
  attempt(() => functionsTopicReload());
  attempt(() => storageDemoTargets());
  attempt(() => storageNativeClients());
  attempt(() => firebaseSuite());
}

// -------------------------------------------------------------- checks

const SERVICES = ['firestore', 'firestore-rules', 'auth', 'storage', 'storage-rules', 'functions', 'pubsub', 'tasks', 'suite'];

function verify() {
  const problems = [];
  for (const set of sets) {
    if (!SERVICES.includes(set.service)) problems.push(`${set.id}: unknown service ${set.service}`);
    if (!['official', 'production'].includes(set.reference.kind)) problems.push(`${set.id}: unknown reference kind`);
  }
  const ids = new Map();
  for (const entry of cases) {
    const key = `${entry.set}\u0000${entry.id}`;
    if (ids.has(key)) problems.push(`${entry.set}: duplicate case id ${entry.id}`);
    ids.set(key, true);
    for (const field of ['request', 'answer']) {
      const value = entry[field];
      if (!value) problems.push(`${entry.set}/${entry.id}: empty ${field}`);
      if (value.length > MAX) problems.push(`${entry.set}/${entry.id}: ${field} longer than ${MAX}`);
    }
    for (const field of ['id', 'scenario', 'title', 'request', 'answer']) {
      const value = entry[field];
      if (/eyJ/.test(value)) problems.push(`${entry.set}/${entry.id}: ${field} contains eyJ`);
      if (/Bearer /.test(value)) problems.push(`${entry.set}/${entry.id}: ${field} contains "Bearer "`);
      if (/key=/.test(value)) problems.push(`${entry.set}/${entry.id}: ${field} contains key=`);
      if (/\bpassword\b["']?\s*[:=]\s*["']?[^\s"',}]/i.test(value)) problems.push(`${entry.set}/${entry.id}: ${field} contains a password value`);
    }
  }
  const counted = new Map();
  for (const entry of cases) counted.set(entry.set, (counted.get(entry.set) ?? 0) + 1);
  for (const set of sets) {
    if ((counted.get(set.id) ?? 0) !== set.answers) problems.push(`${set.id}: answers ${set.answers} but ${counted.get(set.id) ?? 0} cases`);
  }
  return problems;
}

function main() {
  const output = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
  if (!output) {
    console.error('usage: node conformance/src/report/cases.mjs <output.json> [--history]');
    process.exit(2);
  }
  build();
  const order = (a, b) => SERVICES.indexOf(a.service) - SERVICES.indexOf(b.service) || a.id.localeCompare(b.id);
  sets.sort(order);
  const rank = new Map(sets.map((set, index) => [set.id, index]));
  // Stable: cases keep fixture order inside their set.
  const sortedCases = cases
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank.get(a.entry.set) - rank.get(b.entry.set) || a.index - b.index)
    .map(({ entry }) => entry);

  const problems = verify();
  console.log('Declared counts:');
  let mismatches = 0;
  for (const check of checks) {
    const same = check.declared === check.counted;
    if (!same) mismatches += 1;
    const status = same ? 'ok      ' : 'MISMATCH';
    console.log(`  ${status} ${check.set} ${check.label}: declared ${check.declared}, counted ${check.counted}${!same && check.reason ? ` (${check.reason})` : ''}`);
    if (!same && !check.reason) problems.push(`${check.set}: ${check.label} declared ${check.declared}, counted ${check.counted}, no reason`);
  }
  console.log(`Not counted:`);
  for (const item of skipped) console.log(`  ${item.set}: ${item.what} (${item.reason})`);

  const totals = {};
  for (const set of sets) {
    totals[set.service] = (totals[set.service] ?? 0) + set.answers;
    totals[set.reference.kind] = (totals[set.reference.kind] ?? 0) + set.answers;
  }
  console.log(`Sets: ${sets.length}, answers: ${sortedCases.length}`);
  console.log(`By service: ${SERVICES.map((service) => `${service} ${totals[service] ?? 0}`).join(', ')}`);
  console.log(`By reference: official ${totals.official ?? 0}, production ${totals.production ?? 0}`);
  console.log(`Declared-count mismatches explained: ${mismatches}`);
  if (HISTORY) console.log(`Not recorded at this release: ${[...new Set(absent)].join(', ') || 'none'}`);

  if (problems.length) {
    console.error('Problems:');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const target = resolve(output);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, sets, cases: sortedCases }, null, 2)}\n`);
  console.log(`Wrote ${target}`);
}

main();
