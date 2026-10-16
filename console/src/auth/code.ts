// A user as code that recreates them exactly: for a seed script, a fixture
// or a bug report. A model writes the SDK call; what it cannot write is
// this account — its uid, its providers, its second factors, its claims and
// the password the emulator keeps. So every snippet is typed from the
// stored record, and the import line lists only what the body uses.
//
// `createUser` cannot link a federated provider, so an account with one is
// written as `importUsers` (then the password set, since an import takes a
// hash, not a password). The REST call and the accounts.json entry are the
// record itself, which round-trips exactly (the emulator's password hash
// included).

import type { AuthUserDetail } from '@/api/generated/auth/AuthUserDetail'

/** What `userAsCode` writes: the console's `node`, `python` and `rest` dialects, and an accounts.json entry. */
export type CodeDialect = 'node' | 'python' | 'rest' | 'accounts'

export interface CodeContext {
  project: string
  /** The account's tenant; absent for the project's users. */
  tenant?: string | undefined
  /** `host:port` of the Auth emulator as an app reaches it. */
  authAddress: string
}

/** The sign-in providers `createUser` sets up by itself (the rest need `importUsers`). */
const OWN_PROVIDERS = new Set(['password', 'phone'])

function federated(detail: AuthUserDetail) {
  return detail.providerInfo.filter((provider) => !OWN_PROVIDERS.has(provider.providerId))
}

/** An object key as JavaScript writes it: bare when it can be. */
function jsKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
}

/** A JavaScript literal: strings, numbers, booleans, objects and arrays, two-space indented. */
function js(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map((item) => `${inner}${js(item, inner)}`).join(',\n')},\n${indent}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => item !== undefined,
  )
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([name, item]) => `${inner}${jsKey(name)}: ${js(item, inner)}`).join(',\n')},\n${indent}}`
}

/** A Python literal of a JSON value. */
function py(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return String(value)
  const inner = `${indent}    `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map((item) => `${inner}${py(item, inner)}`).join(',\n')},\n${indent}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([name, item]) => `${inner}${JSON.stringify(name)}: ${py(item, inner)}`).join(',\n')},\n${indent}}`
}

/** Single-quoted for a POSIX shell. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

/** The fields `createUser` takes, from the record, in the Admin SDK's names. */
function createFields(detail: AuthUserDetail): Record<string, unknown> {
  const row = detail.row
  const fields: Record<string, unknown> = { uid: row.uid }
  if (row.email) fields.email = row.email
  if (row.email) fields.emailVerified = row.emailVerified
  if (row.phoneNumber) fields.phoneNumber = row.phoneNumber
  if (detail.password) fields.password = detail.password
  if (row.displayName) fields.displayName = row.displayName
  if (row.photoUrl) fields.photoURL = row.photoUrl
  if (row.disabled) fields.disabled = true
  if (detail.mfa.length > 0)
    fields.multiFactor = {
      enrolledFactors: detail.mfa.map((factor) => {
        const enrolled: Record<string, unknown> = {
          factorId: 'phone',
          phoneNumber: factor.phoneNumber,
        }
        if (factor.displayName) enrolled.displayName = factor.displayName
        return enrolled
      }),
    }
  return fields
}

function nodeCode(detail: AuthUserDetail, context: CodeContext): string {
  const uid = detail.row.uid
  const claims = detail.claims && Object.keys(detail.claims).length > 0 ? detail.claims : undefined
  const linked = federated(detail)
  const auth = context.tenant
    ? `getAuth().tenantManager().authForTenant(${JSON.stringify(context.tenant)})`
    : 'getAuth()'
  const lines = [
    `// FIREBASE_AUTH_EMULATOR_HOST=${context.authAddress}`,
    "import { initializeApp } from 'firebase-admin/app'",
    "import { getAuth } from 'firebase-admin/auth'",
    '',
    `initializeApp({ projectId: ${JSON.stringify(context.project)} })`,
    `const auth = ${auth}`,
    '',
  ]
  if (linked.length > 0) {
    const { password, multiFactor: _created, ...rest } = createFields(detail)
    const record: Record<string, unknown> = {
      ...rest,
      providerData: linked.map((provider) => {
        const data: Record<string, string> = {
          uid: provider.rawId ?? provider.federatedId ?? uid,
          providerId: provider.providerId,
        }
        if (provider.email) data.email = provider.email
        if (provider.displayName) data.displayName = provider.displayName
        if (provider.photoUrl) data.photoURL = provider.photoUrl
        return data
      }),
      ...(claims ? { customClaims: claims } : {}),
      // An imported factor keeps its enrollment id.
      ...(detail.mfa.length > 0
        ? {
            multiFactor: {
              enrolledFactors: detail.mfa.map((factor) => {
                const enrolled: Record<string, unknown> = {
                  uid: factor.enrollmentId,
                  factorId: 'phone',
                  phoneNumber: factor.phoneNumber,
                }
                if (factor.displayName) enrolled.displayName = factor.displayName
                return enrolled
              }),
            },
          }
        : {}),
    }
    lines.push(
      '// createUser cannot link a federated provider, so the account is imported.',
      `await auth.importUsers([${js(record)}])`,
    )
    if (password)
      lines.push(
        `await auth.updateUser(${JSON.stringify(uid)}, { password: ${JSON.stringify(password)} })`,
      )
    return lines.join('\n')
  }
  lines.push(`await auth.createUser(${js(createFields(detail))})`)
  if (claims) lines.push(`await auth.setCustomUserClaims(${JSON.stringify(uid)}, ${js(claims)})`)
  return lines.join('\n')
}

function pythonCode(detail: AuthUserDetail, context: CodeContext): string {
  const row = detail.row
  const uid = row.uid
  const claims = detail.claims && Object.keys(detail.claims).length > 0 ? detail.claims : undefined
  const linked = federated(detail)
  const imports = ['auth']
  if (context.tenant) imports.push('tenant_mgt')
  const client = context.tenant ? 'client' : 'auth'
  const lines = [
    `# FIREBASE_AUTH_EMULATOR_HOST=${context.authAddress}`,
    'import firebase_admin',
    `from firebase_admin import ${imports.join(', ')}`,
    '',
    `firebase_admin.initialize_app(options={"projectId": ${JSON.stringify(context.project)}})`,
  ]
  if (context.tenant)
    lines.push(`client = tenant_mgt.auth_for_tenant(${JSON.stringify(context.tenant)})`)
  lines.push('')
  const args: [string, unknown][] = [['uid', uid]]
  if (row.email) args.push(['email', row.email], ['email_verified', row.emailVerified])
  if (row.phoneNumber) args.push(['phone_number', row.phoneNumber])
  if (row.displayName) args.push(['display_name', row.displayName])
  if (row.photoUrl) args.push(['photo_url', row.photoUrl])
  if (row.disabled) args.push(['disabled', true])
  if (linked.length > 0) {
    const providers = linked.map((provider) => {
      const parts: [string, unknown][] = [
        ['uid', provider.rawId ?? provider.federatedId ?? uid],
        ['provider_id', provider.providerId],
      ]
      if (provider.email) parts.push(['email', provider.email])
      if (provider.displayName) parts.push(['display_name', provider.displayName])
      if (provider.photoUrl) parts.push(['photo_url', provider.photoUrl])
      return `auth.UserProvider(${parts.map(([name, value]) => `${name}=${py(value)}`).join(', ')})`
    })
    const record = [
      ...args.map(([name, value]) => `        ${name}=${py(value, '        ')},`),
      `        provider_data=[${providers.join(', ')}],`,
      ...(claims ? [`        custom_claims=${py(claims, '        ')},`] : []),
    ]
    lines.push(
      '# create_user cannot link a federated provider, so the account is imported.',
      `${client}.import_users([`,
      '    auth.ImportUserRecord(',
      ...record,
      '    ),',
      '])',
    )
    if (detail.password)
      lines.push(`${client}.update_user(${JSON.stringify(uid)}, password=${py(detail.password)})`)
  } else {
    if (detail.password) args.push(['password', detail.password])
    lines.push(
      `${client}.create_user(`,
      ...args.map(([name, value]) => `    ${name}=${py(value, '    ')},`),
      ')',
    )
    if (claims)
      lines.push(`${client}.set_custom_user_claims(${JSON.stringify(uid)}, ${py(claims)})`)
  }
  if (detail.mfa.length > 0)
    lines.push(
      '# The Python Admin SDK does not enrol second factors; the REST snippet carries them (mfaInfo).',
    )
  return lines.join('\n')
}

function restCode(detail: AuthUserDetail, context: CodeContext): string {
  const tenant = context.tenant ? `/tenants/${encodeURIComponent(context.tenant)}` : ''
  const url = `http://${context.authAddress}/identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(context.project)}${tenant}/accounts:batchCreate`
  const body = JSON.stringify({ users: [detail.record], allowOverwrite: true }, null, 2)
  return [
    `curl -X POST ${shellQuote(url)} \\`,
    "  -H 'Authorization: Bearer owner' \\",
    "  -H 'Content-Type: application/json' \\",
    `  -d ${shellQuote(body)}`,
  ].join('\n')
}

/** This user as code in one dialect, typed from the stored record. */
export function userAsCode(
  detail: AuthUserDetail,
  dialect: CodeDialect,
  context: CodeContext,
): string {
  switch (dialect) {
    case 'node':
      return nodeCode(detail, context)
    case 'python':
      return pythonCode(detail, context)
    case 'rest':
      return restCode(detail, context)
    case 'accounts':
      return JSON.stringify(detail.record, null, 2)
  }
}
