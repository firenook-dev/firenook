'use strict';
// emulators:exec loads this into every Node.js process its command starts
// (NODE_OPTIONS --require), while the command holds the demo credentials,
// and every Functions worker loads it before the Functions' code (the engine
// embeds this file and writes it beside support/functions-worker.mjs). Both
// hold an authorized_user file with the demo client and refresh token, and
// the Node.js SDKs send its refresh to Google's token endpoint whatever the
// file's token_uri says: firebase-admin 12 and earlier to
// www.googleapis.com/oauth2/v4/token, the Google auth library (firebase-admin
// 13 and later, @google-cloud/*) to oauth2.googleapis.com/token. That one
// request, the demo refresh grant, is answered here in the process with the
// emulators' owner token, so it never leaves the machine. Every other request,
// a credential of the developer's own included, goes on as it was sent.
//
// Written for every Node.js a command may start: no syntax newer than Node
// 14, and nothing here may fail the process it is loaded into.

try {
  install();
} catch (_) {
  // The process runs as it would without the preload.
}

function install() {
  const http = require('http');
  const https = require('https');
  const os = require('os');
  const path = require('path');

  // Google's token endpoints, by host: the path each Admin SDK posts to.
  const ENDPOINTS = { 'oauth2.googleapis.com': '/token', 'www.googleapis.com': '/oauth2/v4/token' };
  const ANSWER = JSON.stringify({ access_token: 'owner', expires_in: 3600, token_type: 'Bearer' });

  /** Whether a token request's body is the demo credentials' refresh grant. */
  function isDemoGrant(text, type) {
    let fields;
    try {
      fields = /json/i.test(type) || /^\s*\{/.test(text) ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
    } catch (_) {
      return false;
    }
    return (
      fields !== null &&
      typeof fields === 'object' &&
      fields.grant_type === 'refresh_token' &&
      fields.client_id === 'demo' &&
      fields.client_secret === 'demo' &&
      fields.refresh_token === 'demo'
    );
  }

  const isEndpoint = (host, requested) =>
    Object.prototype.hasOwnProperty.call(ENDPOINTS, host) && typeof requested === 'string' && requested.split('?')[0] === ENDPOINTS[host];

  /** The endpoint an `https.request(...)` call is for, or undefined. */
  function endpointOf(args) {
    const first = args[0];
    const fromUrl = typeof first === 'string' || first instanceof URL;
    let url;
    if (fromUrl) {
      try {
        url = new URL(String(first));
      } catch (_) {
        return undefined;
      }
    }
    const options = (fromUrl ? (args[1] && typeof args[1] === 'object' ? args[1] : undefined) : first) || {};
    if (typeof options !== 'object') return undefined;
    const host = options.hostname || (typeof options.host === 'string' ? options.host.replace(/:\d+$/, '') : undefined) || (url && url.hostname);
    const requested = options.path || (url ? url.pathname + url.search : '/');
    if (!isEndpoint(host, requested)) return undefined;
    return { host: host, requested: requested, options: fromUrl ? args[1] : first, callback: args.find((arg) => typeof arg === 'function') };
  }

  const originalRequest = https.request;
  const originalGet = https.get;

  // The answerer: a server on a local socket, started at the first token
  // request (a socket's name is known before it listens, unlike a port's).
  // It answers the demo grant and passes anything else on to Google.
  let socket;
  function answerer() {
    if (socket) return socket;
    const name = 'firenook-token-' + process.pid + '-' + Math.random().toString(36).slice(2, 10);
    if (process.platform === 'win32') socket = '\\\\.\\pipe\\' + name;
    else {
      // A Unix socket's path has room for about a hundred bytes.
      const directory = os.tmpdir().length < 60 ? os.tmpdir() : '/tmp';
      removeAbandoned(directory);
      socket = path.join(directory, name + '.sock');
      process.once('exit', () => {
        try {
          require('fs').unlinkSync(socket);
        } catch (_) {
          // Already gone.
        }
      });
    }
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        if (request.method === 'POST' && isDemoGrant(body.toString('utf8'), request.headers['content-type'] || '')) {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(ANSWER) });
          response.end(ANSWER);
          return;
        }
        // `/<host><path>`, as the request was routed here.
        const host = request.url.slice(1).split('/')[0];
        const upstream = originalRequest.call(
          https,
          { hostname: host, port: 443, path: request.url.slice(1 + host.length), method: request.method, headers: Object.assign({}, request.headers, { host: host }) },
          (answer) => {
            response.writeHead(answer.statusCode || 502, answer.headers);
            answer.pipe(response);
          },
        );
        upstream.on('error', (error) => {
          if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'unreachable', error_description: String((error && error.message) || error) }));
        });
        upstream.end(body);
      });
    });
    server.on('error', () => {
      // A socket that cannot listen fails the token request, never the process.
    });
    server.listen(socket);
    server.unref();
    return socket;
  }

  // A process that was killed (a Functions worker past its stop grace, a
  // crash) left its socket behind: removed here when that process is gone.
  function removeAbandoned(directory) {
    const fs = require('fs');
    let entries;
    try {
      entries = fs.readdirSync(directory);
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const match = /^firenook-token-(\d+)-[a-z0-9]+\.sock$/.exec(entry);
      if (!match || Number(match[1]) === process.pid) continue;
      try {
        process.kill(Number(match[1]), 0);
      } catch (error) {
        if (!error || error.code !== 'ESRCH') continue;
        try {
          fs.unlinkSync(path.join(directory, entry));
        } catch (_) {
          // Another process removed it first.
        }
      }
    }
  }

  function toAnswerer(found) {
    const options = Object.assign({}, found.options && typeof found.options === 'object' ? found.options : {});
    // TLS settings, an https agent and the address mean nothing on the local socket.
    for (const key of ['agent', 'hostname', 'host', 'port', 'protocol', 'path', 'socketPath', 'servername', 'href', 'origin', 'pathname', 'search', 'hash']) delete options[key];
    options.socketPath = answerer();
    options.path = '/' + found.host + found.requested;
    if (!options.method) options.method = 'GET';
    return http.request(options, found.callback);
  }

  https.request = function request() {
    const args = Array.prototype.slice.call(arguments);
    const found = endpointOf(args);
    return found ? toAnswerer(found) : originalRequest.apply(this, args);
  };
  https.get = function get() {
    const args = Array.prototype.slice.call(arguments);
    const found = endpointOf(args);
    if (!found) return originalGet.apply(this, args);
    const outgoing = toAnswerer(found);
    outgoing.end();
    return outgoing;
  };

  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== 'function') return;
  globalThis.fetch = function fetch(input, init) {
    try {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
      const url = new URL(href);
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method === 'POST' && isEndpoint(url.hostname, url.pathname)) {
        const body = init && init.body;
        const text =
          typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : undefined;
        const headers = new Headers((init && init.headers) || undefined);
        if (text !== undefined && isDemoGrant(text, headers.get('content-type') || '')) {
          return Promise.resolve(new Response(ANSWER, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }));
        }
      }
    } catch (_) {
      // Not a request this preload answers.
    }
    return nativeFetch.apply(this, arguments);
  };
}
