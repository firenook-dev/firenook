// A ruleset of the kind people write, for the tests: nested matches, a
// recursive wildcard, functions with lets, get() on a path with
// interpolations, map diffs, strings with escapes, both kinds of comment.

export const RULES = `rules_version = '2';

/* Orders belong to users;
   admins can read everything. */
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() {
      return request.auth != null;
    }

    function isAdmin() {
      let profile = get(/databases/$(database)/documents/users/$(request.auth.uid));
      return profile.data.role == 'admin';
    }

    match /users/{uid} {
      function isOwner() {
        return signedIn() && request.auth.uid == uid;
      }

      allow read: if isOwner() || isAdmin();
      allow create: if isOwner()
        && request.resource.data.keys().hasOnly(['name', 'email', 'address'])
        && request.resource.data.name is string;
      allow update: if isOwner()
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['name']);

      match /orders/{orderId} {
        allow read, write: if isOwner() && resource.data.total < 1000.50;
        allow delete: if request.time < resource.data.createdAt + duration.value(1, 'd');
      }
    }

    // Public posts, any depth below.
    match /posts/{rest=**} {
      allow get: if exists(/databases/$(database)/documents/flags/public);
      allow list: if request.query.limit <= 50 && 'tag\\'s\\n' != "x";
    }
  }
}
`
