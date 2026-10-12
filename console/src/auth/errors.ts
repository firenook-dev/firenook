// What an Auth emulator error means for the developer who caused it: the
// code the emulator answered (`INVALID_PASSWORD`), what the Firebase JS SDK
// will call it in the app (`auth/wrong-password`, with the SDK's own
// sentence), what went wrong in plain words, and what to change.
//
// The SDK's names come from its own source (`sdk-errors.gen.ts`, generated
// from the pinned @firebase/auth); a code its map does not list follows the
// SDK's fallback rule, which lower-cases it and turns `_` into `-`
// (`WEAK_PASSWORD` → `auth/weak-password`). Every code the engine can answer
// that a developer can cause has an explanation here (`ENGINE_CODES`, held
// to `EXPLANATIONS` by the tests).

import { SDK_MESSAGES, SERVER_ERROR_MAP } from './sdk-errors.gen'

/** What the JS SDK calls an emulator code, `auth/` included. */
export function sdkCode(code: string): string {
  const mapped = SERVER_ERROR_MAP[code] ?? code.toLowerCase().replace(/[_\s]+/g, '-')
  return `auth/${mapped}`
}

/** The SDK's own sentence for that code, as `error.message` carries it in the app. */
export function sdkMessage(code: string): string | undefined {
  const message = SDK_MESSAGES[sdkCode(code).slice('auth/'.length)]
  return message === undefined || message === '' ? undefined : message
}

/** What went wrong, and what to change. */
export interface Explanation {
  what: string
  fix?: string | undefined
  /** The fix is a switch on the Settings page. */
  settings?: boolean | undefined
  /** The fix is on the account (its password, its state): the page offers to open the user. */
  user?: boolean | undefined
}

/**
 * Every error code the engine answers with that a developer's app, script or
 * console call can cause — copied from the engine's messages
 * (`crates/auth-front/src/ops/*.rs`, `token.rs`, `blocking.rs`, `lib.rs`),
 * plus the statuses it answers prose with. The tests hold `EXPLANATIONS` to
 * it.
 */
export const ENGINE_CODES = [
  'ADMIN_ONLY_OPERATION',
  'BLOCKING_FUNCTION_ERROR_RESPONSE',
  'CLAIMS_TOO_LARGE',
  'CREDENTIAL_ALREADY_IN_USE',
  'DUPLICATE_EMAIL',
  'DUPLICATE_LOCAL_ID',
  'DUPLICATE_MFA_ENROLLMENT_ID',
  'DUPLICATE_RAW_ID',
  'EMAIL_EXISTS',
  'EMAIL_NOT_FOUND',
  'FEDERATED_USER_ID_ALREADY_LINKED',
  'FORBIDDEN_CLAIM',
  'INSUFFICIENT_PERMISSION',
  'INTERNAL_ERROR',
  'INVALID_ARGUMENT',
  'INVALID_BLOCKING_FUNCTION',
  'INVALID_CLAIMS',
  'INVALID_CODE',
  'INVALID_CONTINUE_URI',
  'INVALID_CREDENTIAL_ID',
  'INVALID_CREDENTIAL_OR_PROVIDER_ID',
  'INVALID_CUSTOM_TOKEN',
  'INVALID_DURATION',
  'INVALID_EMAIL',
  'INVALID_GRANT_TYPE',
  'INVALID_IDENTIFIER',
  'INVALID_IDP_RESPONSE',
  'INVALID_ID_TOKEN',
  'INVALID_LOGIN_CREDENTIALS',
  'INVALID_MFA_ENROLLMENT_ID',
  'INVALID_MFA_PHONE_NUMBER',
  'INVALID_OOB_CODE',
  'INVALID_PASSWORD',
  'INVALID_PHONE_NUMBER',
  'INVALID_PROJECT_ID',
  'INVALID_REFRESH_TOKEN',
  'INVALID_REQUEST_URI',
  'INVALID_REQ_TYPE',
  'INVALID_SESSION_INFO',
  'INVALID_TEMPORARY_PROOF',
  'LOCAL_ID_LIST_EXCEEDS_LIMIT',
  'MFA_ENROLLMENT_NOT_FOUND',
  'MISSING_AUTHENTICATOR_RESPONSE',
  'MISSING_CODE',
  'MISSING_CONTINUE_URI',
  'MISSING_CREDENTIAL',
  'MISSING_CUSTOM_TOKEN',
  'MISSING_EMAIL',
  'MISSING_GRANT_TYPE',
  'MISSING_IDENTIFIER',
  'MISSING_ID_TOKEN',
  'MISSING_LOCAL_ID',
  'MISSING_MFA_ENROLLMENT_ID',
  'MISSING_MFA_PENDING_CREDENTIAL',
  'MISSING_NEW_EMAIL',
  'MISSING_OOB_CODE',
  'MISSING_PASSWORD',
  'MISSING_PHONE_NUMBER',
  'MISSING_PROVIDER_ID',
  'MISSING_RAW_ID',
  'MISSING_REFRESH_TOKEN',
  'MISSING_REQUEST_URI',
  'MISSING_REQ_TYPE',
  'MISSING_SESSION_INFO',
  'MISSING_USER_ACCOUNT',
  'NOT_FOUND',
  'NOT_IMPLEMENTED',
  'OOB_REQ_TYPE_UNSPECIFIED',
  'OPERATION_NOT_ALLOWED',
  'PASSKEY_CREDENTIAL_NOT_FOUND',
  'PASSWORD_LOGIN_DISABLED',
  'PERMISSION_DENIED',
  'PHONE_NUMBER_EXISTS',
  'PROJECT_DISABLED',
  'SECOND_FACTOR_EXISTS',
  'TENANT_ID_MISMATCH',
  'TOKEN_EXPIRED',
  'UNAUTHENTICATED',
  'UNEXPECTED_PARAMETER',
  'UNSUPPORTED_FIRST_FACTOR',
  'UNSUPPORTED_TENANT_OPERATION',
  'UNVERIFIED_EMAIL',
  'USER_DISABLED',
  'USER_NOT_FOUND',
  'WEAK_PASSWORD',
] as const

/** A request field the SDK always sends: missing, it was a hand-written call. */
function missing(field: string, sentBy: string): Explanation {
  return {
    what: `The request has no ${field}. The SDKs always send one; a hand-written request or a script left it out.`,
    fix: `Send ${field}, as ${sentBy} does.`,
  }
}

export const EXPLANATIONS: Readonly<Record<(typeof ENGINE_CODES)[number], Explanation>> = {
  ADMIN_ONLY_OPERATION: {
    what: 'Anonymous sign-in is turned off for this tenant, so only the Admin SDK may create the account.',
    fix: 'Turn on Anonymous sign-in in the tenant’s settings, or create the account with the Admin SDK.',
    settings: true,
  },
  BLOCKING_FUNCTION_ERROR_RESPONSE: {
    what: 'A blocking function (beforeCreate or beforeSignIn) refused the sign-in or failed; its own message is under What it caused.',
    fix: 'Change the function, or the account it refused. The SDK reports it as auth/internal-error with the function’s message.',
  },
  CLAIMS_TOO_LARGE: {
    what: 'The custom claims are over 1,000 characters (JavaScript string length of the compact JSON).',
    fix: 'Keep claims small: an id or a role, never a profile. Large data belongs in Firestore.',
  },
  CREDENTIAL_ALREADY_IN_USE: {
    what: 'That provider account is already linked to another user.',
    fix: 'Unlink it from the other user first, or sign in as that user.',
  },
  DUPLICATE_EMAIL: {
    what: 'Two accounts in one import carry the same email while one account per email is on.',
    fix: 'Give each account its own email, or turn off One account per email address in Settings.',
    settings: true,
  },
  DUPLICATE_LOCAL_ID: {
    what: 'An account with this uid already exists.',
    fix: 'Choose another uid, leave it out for a generated one, or update the existing account.',
  },
  DUPLICATE_MFA_ENROLLMENT_ID: {
    what: 'Two second factors of one account carry the same enrollment id.',
    fix: 'Give each factor its own mfaEnrollmentId, or leave it out to have one generated.',
  },
  DUPLICATE_RAW_ID: {
    what: 'The same provider account is linked twice in one request.',
    fix: 'Link each provider account once.',
  },
  EMAIL_EXISTS: {
    what: 'Another account already has this email.',
    fix: 'Use another email, or sign in to that account: an email-and-password account never shares its email, whatever the settings. For Google and other providers, One account per email address in Settings decides whether a second account may.',
    settings: true,
  },
  EMAIL_NOT_FOUND: {
    what: 'No account has this email.',
    fix: 'Check the email, or create the account first. With email enumeration protection on, the answer would not say so.',
  },
  FEDERATED_USER_ID_ALREADY_LINKED: {
    what: 'That provider account is already linked to another user.',
    fix: 'Sign in with it to reach that user, or unlink it there first.',
  },
  FORBIDDEN_CLAIM: {
    what: 'The custom claims use a name Firebase reserves (iss, aud, sub, exp, firebase…).',
    fix: 'Remove the reserved key; Firebase refuses it too.',
  },
  INSUFFICIENT_PERMISSION: {
    what: 'This needs the Admin SDK’s credential: a client with an API key cannot name another project or do this.',
    fix: 'Call it from the Admin SDK, or as the app’s own project.',
  },
  INTERNAL_ERROR: {
    what: 'The emulator failed while handling the request.',
    fix: 'The engine’s log has the details; Replay to see whether it happens again.',
  },
  INVALID_ARGUMENT: {
    what: 'A field of the request has a value the emulator cannot use; the message says which.',
    fix: 'Correct the field the message names.',
  },
  INVALID_BLOCKING_FUNCTION: {
    what: 'The blocking function answered something the emulator could not read as a blocking response.',
    fix: 'Return the SDK’s shape from the function (beforeUserCreated / beforeUserSignedIn), or throw HttpsError to refuse.',
  },
  INVALID_CLAIMS: {
    what: 'The custom claims are not a JSON object.',
    fix: 'Send an object, such as {"role": "admin"}.',
  },
  INVALID_CODE: {
    what: 'The SMS code does not match the one sent for this verification.',
    fix: 'Use the code in the Inbox for this phone number, from the newest message.',
  },
  INVALID_CONTINUE_URI: {
    what: 'The continue URL is not an absolute URL.',
    fix: 'Send a full URL, such as https://your-app.example/finish.',
  },
  INVALID_CREDENTIAL_ID: {
    what: 'The passkey credential id is not one the emulator issued.',
    fix: 'Use the credential id from the passkey enrollment.',
  },
  INVALID_CREDENTIAL_OR_PROVIDER_ID: {
    what: 'The provider id or its credential is not one the emulator accepts.',
    fix: 'Use a provider id such as google.com and its id_token or access_token.',
  },
  INVALID_CUSTOM_TOKEN: {
    what: 'The custom token is not one the emulator can read.',
    fix: 'Mint it with the Admin SDK (createCustomToken), or send the emulator’s JSON form {"uid": "…"}.',
  },
  INVALID_DURATION: {
    what: 'The session cookie’s duration is outside 5 minutes to 2 weeks.',
    fix: 'Pass expiresIn between 300,000 and 1,209,600,000 ms.',
  },
  INVALID_EMAIL: {
    what: 'The email is not a valid email address.',
    fix: 'Check the address for a typo; the emulator wants local@domain.',
  },
  INVALID_GRANT_TYPE: {
    what: 'The token endpoint takes grant_type refresh_token only.',
    fix: 'Send grant_type=refresh_token with the refresh token.',
  },
  INVALID_IDENTIFIER: {
    what: 'The identifier is not a valid email address.',
    fix: 'Check the address for a typo.',
  },
  INVALID_IDP_RESPONSE: {
    what: 'The provider credential could not be read: the emulator expects a JSON id_token or an access token in postBody.',
    fix: 'In the emulator, a federated sign-in takes id_token as unsigned JSON, such as {"sub": "123", "email": "ada@example.test"}.',
  },
  INVALID_ID_TOKEN: {
    what: 'The ID token is not one the emulator can read.',
    fix: 'Sign in again through the emulator; a token from production Firebase is not accepted here.',
  },
  INVALID_LOGIN_CREDENTIALS: {
    what: 'Email enumeration protection is on, so a wrong password and an unknown email look the same.',
    fix: 'Turn it off in Settings to see which.',
    settings: true,
  },
  INVALID_MFA_ENROLLMENT_ID: {
    what: 'The second factor named is not enrolled on this account.',
    fix: 'Pick one of the account’s enrolled factors.',
  },
  INVALID_MFA_PHONE_NUMBER: {
    what: 'The second factor’s phone number is not a valid E.164 number.',
    fix: 'Write it with + and the country code, such as +15550100.',
  },
  INVALID_OOB_CODE: {
    what: 'The code in the link was already used, belongs to another kind of link, or is not one the emulator issued.',
    fix: 'Send a new link and use the newest one in the Inbox; a code works once.',
  },
  INVALID_PASSWORD: {
    what: 'The password does not match this account’s. The account’s password is kept in the emulator — see it on the user.',
    fix: 'Sign in with the password the user shows, or set a new one there.',
    user: true,
  },
  INVALID_PHONE_NUMBER: {
    what: 'The phone number is not a valid E.164 number.',
    fix: 'Write it with + and the country code, such as +15550100.',
  },
  INVALID_PROJECT_ID: {
    what: 'The project id in the request is not the emulator’s, and the call may not name another.',
    fix: 'Initialize the app with the emulator’s project id.',
  },
  INVALID_REFRESH_TOKEN: {
    what: 'The refresh token is not one the emulator issued.',
    fix: 'Sign in again through the emulator to get a new refresh token.',
  },
  INVALID_REQUEST_URI: {
    what: 'The requestUri is not a valid URL.',
    fix: 'Send the page the sign-in returned to, such as http://localhost.',
  },
  INVALID_REQ_TYPE: {
    what: 'The requestType is not one the emulator sends codes for.',
    fix: 'Use PASSWORD_RESET, VERIFY_EMAIL, EMAIL_SIGNIN or VERIFY_AND_CHANGE_EMAIL.',
  },
  INVALID_SESSION_INFO: {
    what: 'The sessionInfo does not name a phone verification the emulator started.',
    fix: 'Use the sessionInfo sendVerificationCode answered, and send the code again if it was used.',
  },
  INVALID_TEMPORARY_PROOF: {
    what: 'The temporary proof is not one the emulator issued.',
    fix: 'Verify the phone number again to get a new proof.',
  },
  LOCAL_ID_LIST_EXCEEDS_LIMIT: {
    what: 'The request names more accounts than the emulator takes at once.',
    fix: 'Send them in smaller batches.',
  },
  MFA_ENROLLMENT_NOT_FOUND: {
    what: 'The second factor named is not enrolled on this account.',
    fix: 'Pick one of the account’s enrolled factors; the user shows them.',
    user: true,
  },
  MISSING_AUTHENTICATOR_RESPONSE: missing('authenticator response', 'WebAuthn'),
  MISSING_CODE: missing('code', 'confirm()'),
  MISSING_CONTINUE_URI: missing('continue URL', 'sendSignInLinkToEmail'),
  MISSING_CREDENTIAL: missing('credential', 'signInWithCredential'),
  MISSING_CUSTOM_TOKEN: missing('custom token', 'signInWithCustomToken'),
  MISSING_EMAIL: missing('email', 'the SDK'),
  MISSING_GRANT_TYPE: missing('grant_type', 'the SDK’s token refresh'),
  MISSING_IDENTIFIER: missing('identifier', 'fetchSignInMethodsForEmail'),
  MISSING_ID_TOKEN: missing('ID token', 'the SDK for a signed-in user'),
  MISSING_LOCAL_ID: missing('localId', 'the Admin SDK'),
  MISSING_MFA_ENROLLMENT_ID: missing('mfaEnrollmentId', 'MultiFactorResolver'),
  MISSING_MFA_PENDING_CREDENTIAL: missing('mfaPendingCredential', 'MultiFactorResolver'),
  MISSING_NEW_EMAIL: missing('new email', 'verifyBeforeUpdateEmail'),
  MISSING_OOB_CODE: missing('oobCode', 'applyActionCode'),
  MISSING_PASSWORD: missing('password', 'signInWithEmailAndPassword'),
  MISSING_PHONE_NUMBER: missing('phone number', 'signInWithPhoneNumber'),
  MISSING_PROVIDER_ID: missing('provider id', 'the SDK'),
  MISSING_RAW_ID: missing('provider account id (rawId)', 'the Admin SDK'),
  MISSING_REFRESH_TOKEN: missing('refresh token', 'the SDK’s token refresh'),
  MISSING_REQUEST_URI: missing('requestUri', 'signInWithPopup'),
  MISSING_REQ_TYPE: missing('requestType', 'the SDK'),
  MISSING_SESSION_INFO: missing('sessionInfo', 'confirm()'),
  MISSING_USER_ACCOUNT: {
    what: 'The request names no account.',
    fix: 'Send a localId (Admin SDK) or an ID token (client).',
  },
  NOT_FOUND: {
    what: 'The emulator has no such route or resource.',
    fix: 'Check the path; the Auth emulator answers the Identity Toolkit, secure token and /emulator routes.',
  },
  NOT_IMPLEMENTED: {
    what: 'The Auth emulator does not implement this, as the official emulator does not.',
    fix: 'Leave it out of tests that run against the emulator.',
  },
  OOB_REQ_TYPE_UNSPECIFIED: missing('requestType', 'the SDK'),
  OPERATION_NOT_ALLOWED: {
    what: 'This sign-in method (password sign-up, email link, or SMS multi-factor) is turned off for this tenant.',
    fix: 'Turn it on in the tenant’s settings.',
    settings: true,
  },
  PASSKEY_CREDENTIAL_NOT_FOUND: {
    what: 'No account holds this passkey.',
    fix: 'Enroll the passkey first, or sign in with another method.',
  },
  PASSWORD_LOGIN_DISABLED: {
    what: 'Password sign-in is turned off for this tenant.',
    fix: 'Turn on Password sign-up in the tenant’s settings.',
    settings: true,
  },
  PERMISSION_DENIED: {
    what: 'The credential sent may not do this.',
    fix: 'Call it with the Admin SDK’s credential.',
  },
  PHONE_NUMBER_EXISTS: {
    what: 'Another user already has this phone number.',
    fix: 'Use another number, or remove it from the other user.',
  },
  PROJECT_DISABLED: {
    what: 'Authentication is turned off for this tenant (Disable auth).',
    fix: 'Turn Disable auth off in the tenant’s settings.',
    settings: true,
  },
  SECOND_FACTOR_EXISTS: {
    what: 'This phone number is already a second factor of this account.',
    fix: 'Enroll another number, or keep the one enrolled.',
  },
  TENANT_ID_MISMATCH: {
    what: 'The token or account belongs to another tenant than the request names.',
    fix: 'Send the tenant the user belongs to (auth.tenantId in the app).',
  },
  TOKEN_EXPIRED: {
    what: 'The ID token was issued before the account’s tokens were revoked (its password or email changed, or Revoke was pressed).',
    fix: 'Sign in again, or refresh the token: a refresh token still mints new ID tokens in the emulator.',
  },
  UNAUTHENTICATED: {
    what: 'The request carried no credential the emulator accepts for this route.',
    fix: 'Send the API key (?key=) as a client, or Authorization: Bearer owner as the Admin SDK.',
  },
  UNEXPECTED_PARAMETER: {
    what: 'The request carries a field this call does not take.',
    fix: 'Remove the field the message names.',
  },
  UNSUPPORTED_FIRST_FACTOR: {
    what: 'Multi-factor sign-in needs a verified email or phone as the first factor.',
    fix: 'Verify the account’s email before enrolling a second factor.',
  },
  UNSUPPORTED_TENANT_OPERATION: {
    what: 'This call cannot be made for a tenant.',
    fix: 'Make it for the project, or use the tenant’s own routes.',
  },
  UNVERIFIED_EMAIL: {
    what: 'A second factor can be enrolled from a client only after the email is verified.',
    fix: 'Verify the email first (the Inbox has the link), or add the factor with the Admin SDK.',
    user: true,
  },
  USER_DISABLED: {
    what: 'This account is disabled: it cannot sign in or refresh a token.',
    fix: 'Enable it on the user, if it should sign in.',
    user: true,
  },
  USER_NOT_FOUND: {
    what: 'The account the token or request names no longer exists.',
    fix: 'It may have been deleted; sign up again or pick an existing user.',
  },
  WEAK_PASSWORD: {
    what: 'The password is shorter than 6 characters.',
    fix: 'Use at least 6 characters.',
  },
}

/** The explanation for a code, when the engine can answer with it. */
export function explanationOf(code: string): Explanation | undefined {
  return Object.hasOwn(EXPLANATIONS, code)
    ? EXPLANATIONS[code as (typeof ENGINE_CODES)[number]]
    : undefined
}

/** Everything a page says about one error. */
export interface ExplainedError {
  code: string
  /** `auth/wrong-password`. */
  sdk: string
  /** The SDK's own sentence, when it has one. */
  sdkMessage: string | undefined
  explanation: Explanation | undefined
}

/**
 * An emulator error explained: its SDK name, the SDK's sentence, and what
 * went wrong with what to change. `code` is the part of the message before
 * " : " (`AuthCallError.code`, `AuthEmulatorError.code`).
 */
export function explainAuthError(code: string): ExplainedError {
  return {
    code,
    sdk: sdkCode(code),
    sdkMessage: sdkMessage(code),
    explanation: explanationOf(code),
  }
}
