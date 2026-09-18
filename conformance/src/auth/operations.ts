// Phase I1: maps a recorded request onto the official emulator's operation
// id (the OpenAPI `operationId`), for coverage tables and the replay report.

export interface OperationRef {
  readonly id: string;
  readonly official: "implemented" | "not-implemented" | "page";
}

const V1 = "/identitytoolkit.googleapis.com/v1";
const V2 = "/identitytoolkit.googleapis.com/v2";
/** A path segment that may be a `{{template}}` (templates contain a colon). */
const ID = String.raw`(?:\{\{[^}]+\}\}|[^/:]+)`;

const NOT_IMPLEMENTED_CLIENT = new Set([
  "accounts:issueSamlResponse",
  "accounts:signInWithGameCenter",
  "accounts:verifyIosClient",
  "sessionCookiePublicKeys",
  "accounts:revokeToken",
  "defaultSupportedIdps",
  "passwordPolicy",
  "recaptchaConfig",
]);

export function operationFor(method: string, rawPath: string): OperationRef {
  const path = rawPath.split("?")[0] ?? rawPath;
  if (path === "/") return { id: "readiness", official: "page" };
  if (path === "/nothing/here" || path.endsWith(":nope")) return { id: "unknown-route", official: "page" };
  if (path === "/emulator/openapi.json") return { id: "openapi", official: "page" };
  if (path === "/emulator/action") return { id: "emulator.action", official: "page" };
  if (path === "/emulator/auth/handler") return { id: "emulator.auth.handler", official: "page" };
  if (path === "/emulator/auth/iframe") return { id: "emulator.auth.iframe", official: "page" };
  if (path.startsWith("/www.googleapis.com/identitytoolkit/v3/relyingparty/")) {
    const name = path.slice("/www.googleapis.com/identitytoolkit/v3/relyingparty/".length);
    return { id: `legacy.relyingparty.${name}`, official: name === "signOutUser" ? "not-implemented" : "implemented" };
  }
  if (path.startsWith("/securetoken.googleapis.com/v1/token")) return { id: "securetoken.token", official: "implemented" };
  const emulator = new RegExp(String.raw`^/emulator/v1/projects/${ID}(/tenants/${ID})?/(accounts|config|oobCodes|verificationCodes)$`).exec(path);
  if (emulator) {
    const tenant = emulator[1] ? "tenants." : "";
    const resource = emulator[2] ?? "";
    const verb = resource === "accounts" ? "delete" : resource === "config" ? (method === "GET" ? "get" : "update") : "list";
    return { id: `emulator.projects.${tenant}${resource}.${verb}`, official: "implemented" };
  }
  if (path.startsWith(V1)) {
    const rest = path.slice(V1.length + 1);
    if (rest === "projects") return { id: "identitytoolkit.getProjects", official: "implemented" };
    if (rest === "recaptchaParams") return { id: "identitytoolkit.getRecaptchaParams", official: "implemented" };
    if (rest.startsWith("accounts:")) {
      const verb = rest.slice("accounts:".length);
      return { id: `identitytoolkit.accounts.${verb}`, official: NOT_IMPLEMENTED_CLIENT.has(rest) ? "not-implemented" : "implemented" };
    }
    if (rest === "sessionCookiePublicKeys") return { id: "identitytoolkit.getSessionCookiePublicKeys", official: "not-implemented" };
    const project = new RegExp(String.raw`^projects/${ID}(?::(\w+))?(?:/tenants/${ID}(?::(\w+))?)?(?:/accounts(?::(\w+))?)?$`).exec(rest);
    if (project) {
      const [, projectVerb, tenantVerb, accountVerb] = project;
      const tenant = rest.includes("/tenants/") ? "tenants." : "";
      if (accountVerb) return { id: `identitytoolkit.projects.${tenant}accounts.${accountVerb}`, official: "implemented" };
      if (rest.endsWith("/accounts")) return { id: `identitytoolkit.projects.${tenant}accounts (create)`, official: "implemented" };
      const verb = tenantVerb ?? projectVerb;
      if (verb) return { id: `identitytoolkit.projects.${tenant}${verb}`, official: "implemented" };
    }
    return { id: `unknown:${method} ${path}`, official: "not-implemented" };
  }
  if (path.startsWith(V2)) {
    const rest = path.slice(V2.length + 1);
    const mfa = /^accounts\/(mfaEnrollment|mfaSignIn|passkeyEnrollment|passkeySignIn):(\w+)$/.exec(rest);
    if (mfa) return { id: `identitytoolkit.accounts.${mfa[1]}.${mfa[2]}`, official: "implemented" };
    if (rest.startsWith("accounts:")) return { id: `identitytoolkit.accounts.${rest.slice("accounts:".length)}`, official: NOT_IMPLEMENTED_CLIENT.has(rest) ? "not-implemented" : "implemented" };
    if (["defaultSupportedIdps", "passwordPolicy", "recaptchaConfig"].includes(rest)) {
      const name = rest === "defaultSupportedIdps" ? "defaultSupportedIdps.list" : rest === "passwordPolicy" ? "getPasswordPolicy" : "getRecaptchaConfig";
      return { id: `identitytoolkit.${name}`, official: "not-implemented" };
    }
    const config = new RegExp(String.raw`^projects/${ID}(/tenants/${ID})?/config$`).exec(rest);
    if (config) {
      if (config[1]) return { id: "identitytoolkit.projects.tenants.config", official: "not-implemented" };
      return { id: method === "GET" ? "identitytoolkit.projects.getConfig" : "identitytoolkit.projects.updateConfig", official: "implemented" };
    }
    const tenants = new RegExp(String.raw`^projects/${ID}/tenants(?:/(${ID}))?(?::(\w+))?(?:/(defaultSupportedIdpConfigs|inboundSamlConfigs|oauthIdpConfigs)(?:/[^/]+)?)?$`).exec(rest);
    if (tenants) {
      const [, tenantId, verb, subresource] = tenants;
      if (subresource) return { id: `identitytoolkit.projects.tenants.${subresource}.${crudVerb(method, rest.endsWith(subresource))}`, official: "not-implemented" };
      if (verb) return { id: `identitytoolkit.projects.tenants.${verb}`, official: verb === "createSessionCookie" ? "implemented" : "not-implemented" };
      if (tenantId) return { id: `identitytoolkit.projects.tenants.${method === "GET" ? "get" : method === "PATCH" ? "patch" : "delete"}`, official: "implemented" };
      return { id: `identitytoolkit.projects.tenants.${method === "GET" ? "list" : "create"}`, official: "implemented" };
    }
    const initialize = new RegExp(String.raw`^projects/${ID}/identityPlatform:initializeAuth$`).exec(rest);
    if (initialize) return { id: "identitytoolkit.projects.identityPlatform.initializeAuth", official: "not-implemented" };
    const idp = new RegExp(String.raw`^projects/${ID}(?::(\w+))?(?:/(defaultSupportedIdpConfigs|inboundSamlConfigs|oauthIdpConfigs)(?:/[^/]+)?)?$`).exec(rest);
    if (idp) {
      const [, verb, subresource] = idp;
      if (subresource) return { id: `identitytoolkit.projects.${subresource}.${crudVerb(method, rest.endsWith(subresource))}`, official: "not-implemented" };
      if (verb) return { id: `identitytoolkit.projects.${verb}`, official: "not-implemented" };
    }
    return { id: `unknown:${method} ${path}`, official: "not-implemented" };
  }
  return { id: `unknown:${method} ${path}`, official: "not-implemented" };
}

function crudVerb(method: string, collection: boolean): string {
  if (collection) return method === "GET" ? "list" : "create";
  return method === "GET" ? "get" : method === "PATCH" ? "patch" : "delete";
}
