// "View as": the identity the workbench reads Firestore with. The identity
// itself, its tokens and the Auth users a picker offers live in
// `lib/identity.ts`, where Storage and Functions read them too; this file
// keeps the names the Firestore section has always imported.

export {
  type ViewAs,
  OWNER_AUTHORIZATION,
  authorizationFor,
  describeViewAs,
  describeViewAsShort,
  identityKey,
  mintUnsignedToken,
  parseViewAs,
  resolveAuthorization,
  serializeViewAs,
} from '@/lib/identity'
