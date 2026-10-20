// Marks the requests a caller makes to the suite. Inside withClient(name, fn)
// every suiteFetch carries `x-firenook-client: <name>` (the MCP server names
// itself firenook-mcp/<version>), so the engine can tell an agent's calls
// from the developer's; outside it, suiteFetch is plain fetch.
import { AsyncLocalStorage } from 'node:async_hooks';

export const CLIENT_HEADER = 'x-firenook-client';
const scope = new AsyncLocalStorage();
export const withClient = (client, body) => scope.run(client, body);
export const currentClient = () => scope.getStore();

export function suiteFetch(url, init = {}) {
  const client = scope.getStore();
  if (!client) return fetch(url, init);
  const headers = new Headers(init.headers);
  headers.set(CLIENT_HEADER, client);
  return fetch(url, {...init, headers});
}
