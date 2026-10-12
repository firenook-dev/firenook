//! Where a ruleset reads the claims of the caller's ID token.
//!
//! Before a developer edits a user's custom claims, they want to know which
//! rules read each one. The answer has to find every spelling of a read: a
//! member (`request.auth.token.role`), an index (`request.auth.token['role']`),
//! a `get` with a default, an `in` test, and every name the token travels
//! under: a `let` binding, a function parameter, a function that returns it.
//! A key computed at run time (`request.auth.token[k]`) is reported without
//! one, so a client can say "a rule may read any claim here" instead of
//! wrongly saying "no rule reads this claim".
//!
//! The walk resolves calls the way the evaluator does: among the functions
//! visible where the allow condition sits, for calls made inside a function
//! too. A parameter takes the shape of the argument each call site passes,
//! so a helper that reads `.role` of its parameter is reported only when
//! some call passes it the token. Every function body is read on its own as
//! well, so a direct read in a function no condition calls is still found.
//!
//! Positions are UTF-16 code units, like the rest of the analysis: the
//! consumer is a browser editor.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::{BitOr, BitOrAssign, Range};

use crate::ast::{BinaryOperator, Expr, ExprKind, Function, MatchBlock, PathPart, Program};
use crate::{Ruleset, SourceRange};

/// One place a ruleset reads a claim of the caller's token.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimRead {
    /// The claim key: the top-level one for a nested claim (`org` in
    /// `request.auth.token.org.role`). `None` when the key is computed at
    /// run time (`request.auth.token[k]`), which may reach any claim.
    pub key: Option<String>,
    /// The reading expression as a whole: `request.auth.token.role`,
    /// `token.get('role', '')`, `'role' in request.auth.token`.
    pub range: SourceRange,
    /// How the expression spells the read.
    pub form: ClaimReadForm,
}

/// How a rule spells a claim read.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum ClaimReadForm {
    /// `request.auth.token.role`
    Member,
    /// `request.auth.token['role']`
    Index,
    /// `request.auth.token.get('role', default)`
    Get,
    /// `'role' in request.auth.token`, and the same presence test through
    /// the key list: `'role' in request.auth.token.keys()` and
    /// `request.auth.token.keys().hasAny(['role'])` (one read per listed key).
    In,
    /// `request.auth.token[expression]`
    Dynamic,
}

impl Ruleset {
    /// Every place the ruleset reads a claim of the caller's ID token, in
    /// source order and positioned in UTF-16, for Firestore and Storage
    /// rules alike. Nothing is evaluated.
    #[must_use]
    pub fn claim_reads(&self) -> Vec<ClaimRead> {
        claim_reads(&self.program, &self.source)
    }
}

/// See [`Ruleset::claim_reads`].
pub(crate) fn claim_reads(program: &Program, source: &str) -> Vec<ClaimRead> {
    let mut walk = Walk {
        scopes: Scopes::of(program),
        results: BTreeMap::new(),
        found: BTreeSet::new(),
    };
    let names = Names::from([("request", Shapes::REQUEST)]);
    for condition in 0..walk.scopes.conditions.len() {
        let (expression, scope) = walk.scopes.conditions[condition];
        walk.expression(expression, &names, scope);
    }
    // Each body once more where it is declared, with parameters that reach
    // nothing: a function no condition calls still has its direct reads.
    for function in 0..walk.scopes.functions.len() {
        let (definition, scope) = walk.scopes.functions[function];
        walk.call(
            function,
            scope,
            vec![Shapes::NONE; definition.parameters.len()],
        );
    }
    if walk.found.is_empty() {
        return Vec::new();
    }
    let lines = Lines::new(source);
    walk.found
        .into_iter()
        .map(|(start, end, form, key)| ClaimRead {
            key,
            range: lines.range(start..end),
            form,
        })
        .collect()
}

/// What an expression may evaluate to, as far as reaching the token goes.
/// A set, because a parameter holds whatever each call site passes.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd)]
struct Shapes(u8);

impl Shapes {
    const NONE: Self = Self(0);
    /// `request`
    const REQUEST: Self = Self(1);
    /// `request.auth`
    const AUTH: Self = Self(1 << 1);
    /// `request.auth.token`
    const TOKEN: Self = Self(1 << 2);
    /// `request.auth.token.keys()`
    const KEYS: Self = Self(1 << 3);

    const fn has(self, shape: Self) -> bool {
        self.0 & shape.0 != 0
    }

    /// The shapes of `self.name`, or of `self['name']`.
    fn member(self, name: &str) -> Self {
        let mut shapes = Self::NONE;
        if self.has(Self::REQUEST) && name == "auth" {
            shapes |= Self::AUTH;
        }
        if self.has(Self::AUTH) && name == "token" {
            shapes |= Self::TOKEN;
        }
        shapes
    }
}

impl BitOr for Shapes {
    type Output = Self;

    fn bitor(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}

impl BitOrAssign for Shapes {
    fn bitor_assign(&mut self, other: Self) {
        self.0 |= other.0;
    }
}

/// The names in scope that may reach the token, and how.
type Names<'p> = BTreeMap<&'p str, Shapes>;

/// The function definitions of a ruleset and how each allow condition
/// resolves a call.
struct Scopes<'p> {
    /// Every function definition with the scope it is declared in.
    functions: Vec<(&'p Function, usize)>,
    /// Name to definition as a condition in each scope sees it: the
    /// service's functions, then each enclosing block's, inner definitions
    /// shadowing outer ones. A block that declares nothing shares its
    /// parent's scope, so a function is walked once per distinct scope
    /// rather than once per block.
    visible: Vec<BTreeMap<&'p str, usize>>,
    /// Every allow condition with its scope, in source order.
    conditions: Vec<(&'p Expr, usize)>,
}

impl<'p> Scopes<'p> {
    fn of(program: &'p Program) -> Self {
        let mut scopes = Self {
            functions: Vec::new(),
            visible: Vec::new(),
            conditions: Vec::new(),
        };
        let root = scopes.declare(&program.functions, None);
        for block in &program.matches {
            scopes.block(block, root);
        }
        scopes
    }

    fn declare(
        &mut self,
        functions: &'p BTreeMap<String, Function>,
        parent: Option<usize>,
    ) -> usize {
        if let Some(parent) = parent.filter(|_| functions.is_empty()) {
            return parent;
        }
        let scope = self.visible.len();
        let mut visible = parent.map_or_else(BTreeMap::new, |parent| self.visible[parent].clone());
        for (name, function) in functions {
            visible.insert(name.as_str(), self.functions.len());
            self.functions.push((function, scope));
        }
        self.visible.push(visible);
        scope
    }

    fn block(&mut self, block: &'p MatchBlock, parent: usize) {
        let scope = self.declare(&block.functions, Some(parent));
        for allow in &block.allows {
            self.conditions.push((&allow.condition, scope));
        }
        for child in &block.children {
            self.block(child, scope);
        }
    }
}

/// One read as found: UTF-8 span, form and key. Ordered by position, so the
/// set yields source order, and a body walked for several call sites
/// reports each read once.
type Found = (usize, usize, ClaimReadForm, Option<String>);

struct Walk<'p> {
    scopes: Scopes<'p>,
    /// A function's result shapes per scope and argument shapes. Each entry
    /// walks the body once.
    results: BTreeMap<(usize, usize, Vec<Shapes>), Shapes>,
    found: BTreeSet<Found>,
}

impl<'p> Walk<'p> {
    /// Walks `function`'s body as called from a condition in `scope` with
    /// arguments of these shapes, and returns its result's shapes.
    fn call(&mut self, function: usize, scope: usize, arguments: Vec<Shapes>) -> Shapes {
        let key = (function, scope, arguments);
        if let Some(shapes) = self.results.get(&key) {
            return *shapes;
        }
        // Same-named functions in different blocks can call each other in a
        // cycle the compiler does not see (it fails at run time at the depth
        // limit). Entering one again yields nothing instead of looping.
        self.results.insert(key.clone(), Shapes::NONE);
        let (definition, _) = self.scopes.functions[function];
        let mut names = Names::from([("request", Shapes::REQUEST)]);
        for (parameter, shapes) in definition.parameters.iter().zip(&key.2) {
            names.insert(parameter.as_str(), *shapes);
        }
        for (name, value) in &definition.lets {
            let shapes = self.expression(value, &names, scope);
            names.insert(name.as_str(), shapes);
        }
        let shapes = self.expression(&definition.result, &names, scope);
        self.results.insert(key, shapes);
        shapes
    }

    /// Records a read spanning `start` to the end of `expression`. The
    /// start is the read's own first token: the parser starts a
    /// parenthesized expression at its opening parenthesis but ends it
    /// before the closing one, so `(request.auth.token.role)` would
    /// otherwise be highlighted with half its parentheses.
    fn read(&mut self, start: usize, expression: &Expr, form: ClaimReadForm, key: Option<&str>) {
        self.found
            .insert((start, expression.span.end, form, key.map(str::to_owned)));
    }

    /// Records the claim reads in `expression` and returns its shapes.
    fn expression(&mut self, expression: &'p Expr, names: &Names<'p>, scope: usize) -> Shapes {
        match &expression.kind {
            ExprKind::Variable(name) => names.get(name.as_str()).copied().unwrap_or_default(),
            ExprKind::Field { base, name } => {
                let reached = self.expression(base, names, scope);
                if reached.has(Shapes::TOKEN) {
                    let key = Some(name.as_str());
                    self.read(base.span.start, expression, ClaimReadForm::Member, key);
                }
                reached.member(name)
            }
            ExprKind::Index { base, index } => {
                let reached = self.expression(base, names, scope);
                self.expression(index, names, scope);
                let key = string(index);
                if reached.has(Shapes::TOKEN) {
                    let form = if key.is_some() {
                        ClaimReadForm::Index
                    } else {
                        ClaimReadForm::Dynamic
                    };
                    self.read(base.span.start, expression, form, key);
                }
                key.map_or(Shapes::NONE, |key| reached.member(key))
            }
            ExprKind::Call { callee, arguments } => {
                self.call_expression(expression, callee, arguments, names, scope)
            }
            ExprKind::Binary {
                operator,
                left,
                right,
            } => {
                self.expression(left, names, scope);
                let right = self.expression(right, names, scope);
                if *operator == BinaryOperator::In && right.has(Shapes::TOKEN | Shapes::KEYS) {
                    let key = string(left);
                    self.read(left.span.start, expression, ClaimReadForm::In, key);
                }
                Shapes::NONE
            }
            ExprKind::Slice { base, start, end } => {
                self.expression(base, names, scope);
                for bound in [start, end].into_iter().flatten() {
                    self.expression(bound, names, scope);
                }
                Shapes::NONE
            }
            ExprKind::Unary { operand: value, .. } | ExprKind::Is { value, .. } => {
                self.expression(value, names, scope);
                Shapes::NONE
            }
            ExprKind::List(values) => {
                for value in values {
                    self.expression(value, names, scope);
                }
                Shapes::NONE
            }
            ExprKind::Map(entries) => {
                for (_, value) in entries {
                    self.expression(value, names, scope);
                }
                Shapes::NONE
            }
            ExprKind::Path(parts) => {
                for part in parts {
                    if let PathPart::Interpolation(value) = part {
                        self.expression(value, names, scope);
                    }
                }
                Shapes::NONE
            }
            ExprKind::Null
            | ExprKind::Bool(_)
            | ExprKind::Integer(_)
            | ExprKind::Float(_)
            | ExprKind::String(_) => Shapes::NONE,
        }
    }

    fn call_expression(
        &mut self,
        call: &'p Expr,
        callee: &'p Expr,
        arguments: &'p [Expr],
        names: &Names<'p>,
        scope: usize,
    ) -> Shapes {
        match &callee.kind {
            ExprKind::Variable(name) => {
                let shapes = arguments
                    .iter()
                    .map(|argument| self.expression(argument, names, scope))
                    .collect::<Vec<_>>();
                match self.scopes.visible[scope].get(name.as_str()) {
                    Some(&function)
                        if self.scopes.functions[function].0.parameters.len() == shapes.len() =>
                    {
                        self.call(function, scope, shapes)
                    }
                    // A built-in, or a call with the wrong number of
                    // arguments, which fails when evaluated.
                    _ => Shapes::NONE,
                }
            }
            ExprKind::Field { base, name } => {
                let receiver = self.expression(base, names, scope);
                for argument in arguments {
                    self.expression(argument, names, scope);
                }
                self.method(callee.span.start, call, (receiver, name), arguments)
            }
            _ => {
                self.expression(callee, names, scope);
                for argument in arguments {
                    self.expression(argument, names, scope);
                }
                Shapes::NONE
            }
        }
    }

    /// A method called on `receiver`: `get` on the token reads a claim,
    /// `keys` lists them, and `hasAny`, `hasAll` and `hasOnly` on that list
    /// test the presence of each key they name.
    fn method(
        &mut self,
        start: usize,
        call: &Expr,
        (receiver, name): (Shapes, &str),
        arguments: &[Expr],
    ) -> Shapes {
        let mut shapes = Shapes::NONE;
        if receiver.has(Shapes::TOKEN) {
            match name {
                "get" => {
                    let key = arguments.first().and_then(string);
                    self.read(start, call, ClaimReadForm::Get, key);
                }
                "keys" => shapes |= Shapes::KEYS,
                _ => {}
            }
        }
        if receiver.has(Shapes::KEYS) && matches!(name, "hasAny" | "hasAll" | "hasOnly") {
            match arguments.first().map(|list| &list.kind) {
                Some(ExprKind::List(keys)) => {
                    for key in keys {
                        self.read(start, call, ClaimReadForm::In, string(key));
                    }
                }
                _ => self.read(start, call, ClaimReadForm::In, None),
            }
        }
        shapes
    }
}

/// The value of a string literal.
fn string(expression: &Expr) -> Option<&str> {
    match &expression.kind {
        ExprKind::String(value) => Some(value),
        _ => None,
    }
}

/// Byte offset to line, column and UTF-16 offset, without rescanning the
/// source for each read.
struct Lines<'a> {
    source: &'a str,
    /// The byte and UTF-16 offsets of each line's start.
    starts: Vec<(usize, usize)>,
}

impl<'a> Lines<'a> {
    fn new(source: &'a str) -> Self {
        let mut starts = vec![(0, 0)];
        let mut utf16 = 0;
        for (offset, character) in source.char_indices() {
            utf16 += character.len_utf16();
            if character == '\n' {
                starts.push((offset + 1, utf16));
            }
        }
        Self { source, starts }
    }

    /// One-based line, one-based Unicode-scalar column and UTF-16 offset,
    /// counted as compiler diagnostics and the outline count them.
    fn locate(&self, offset: usize) -> (usize, usize, usize) {
        let offset = self
            .source
            .floor_char_boundary(offset.min(self.source.len()));
        let line = self.starts.partition_point(|(start, _)| *start <= offset) - 1;
        let (start, utf16) = self.starts[line];
        let prefix = &self.source[start..offset];
        (
            line + 1,
            prefix.chars().count() + 1,
            utf16 + prefix.encode_utf16().count(),
        )
    }

    fn range(&self, span: Range<usize>) -> SourceRange {
        let (line, column, from) = self.locate(span.start);
        let (_, _, to) = self.locate(span.end.max(span.start));
        SourceRange {
            line,
            column,
            from,
            to,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ClaimReadForm::{Dynamic, Get, In, Index, Member};

    const COMPLEX_RULES: &str =
        include_str!("../../../conformance/fixtures/rules-v2/complex-firestore.rules");

    fn compile(source: &str) -> Ruleset {
        crate::compile(source).unwrap_or_else(|errors| panic!("{errors:?}"))
    }

    /// Wraps match blocks in the documents root of a version 2 Firestore
    /// ruleset.
    fn rules(body: &str) -> String {
        format!(
            "rules_version = '2';\nservice cloud.firestore {{\n  match /databases/{{database}}/documents {{\n{body}\n  }}\n}}\n"
        )
    }

    /// The text between two UTF-16 offsets, as a browser editor slices it.
    fn utf16_slice(source: &str, from: usize, to: usize) -> String {
        let units = source.encode_utf16().collect::<Vec<_>>();
        String::from_utf16(&units[from..to]).expect("a whole-character range")
    }

    /// Each read as (key, form, the text its range covers).
    fn reads(source: &str) -> Vec<(Option<String>, ClaimReadForm, String)> {
        compile(source)
            .claim_reads()
            .into_iter()
            .map(|read| {
                (
                    read.key,
                    read.form,
                    utf16_slice(source, read.range.from, read.range.to),
                )
            })
            .collect()
    }

    fn read(
        key: Option<&str>,
        form: ClaimReadForm,
        text: &str,
    ) -> (Option<String>, ClaimReadForm, String) {
        (key.map(str::to_owned), form, text.to_owned())
    }

    #[test]
    fn every_spelling_of_a_read_is_found_in_source_order() {
        let source = rules(
            r#"    match /posts/{post} {
      allow get: if request.auth.token.role == 'editor';
      allow list: if request.auth.token['plan'] == 'pro' && request.auth.token["tier"] > 1;
      allow create: if request.auth.token.get('beta', false);
      allow update: if 'admin' in request.auth.token;
      allow delete: if request.auth.token.org.team == resource.data.team;
    }"#,
        );
        assert_eq!(
            reads(&source),
            [
                read(Some("role"), Member, "request.auth.token.role"),
                read(Some("plan"), Index, "request.auth.token['plan']"),
                read(Some("tier"), Index, r#"request.auth.token["tier"]"#),
                read(Some("beta"), Get, "request.auth.token.get('beta', false)"),
                read(Some("admin"), In, "'admin' in request.auth.token"),
                // A nested claim is reported by its top-level key.
                read(Some("org"), Member, "request.auth.token.org"),
            ]
        );
    }

    #[test]
    fn a_parenthesized_read_is_highlighted_without_its_parentheses() {
        let source = rules(
            "    match /posts/{post} {
      allow read: if (request.auth.token.role) == 'x' || ('admin' in request.auth.token)
        || (request.auth.token).team == 'a' || (request.auth.token.get('beta', false));
    }",
        );
        assert_eq!(
            reads(&source),
            [
                read(Some("role"), Member, "request.auth.token.role"),
                read(Some("admin"), In, "'admin' in request.auth.token"),
                // The parentheses group the token, and the read covers both.
                read(Some("team"), Member, "(request.auth.token).team"),
                read(Some("beta"), Get, "request.auth.token.get('beta', false)"),
            ]
        );
    }

    #[test]
    fn nothing_but_the_token_counts() {
        let source = rules(
            "    match /posts/{post} {
      allow read: if request.auth.uid == post && resource.data.role == 'editor';
      allow write: if request.auth != null && request.resource.data.token.role == 'x'
        && 'role' in resource.data && request.auth.token == null;
    }",
        );
        assert_eq!(reads(&source), []);
    }

    #[test]
    fn a_let_binding_carries_the_token() {
        let source = rules(
            "    function isStaff() {
      let claims = request.auth.token;
      let auth = request.auth;
      return claims.staff == true || auth.token.contractor == true;
    }
    match /posts/{post} {
      allow read: if isStaff();
    }",
        );
        assert_eq!(
            reads(&source),
            [
                read(Some("staff"), Member, "claims.staff"),
                read(Some("contractor"), Member, "auth.token.contractor"),
            ]
        );
    }

    #[test]
    fn a_parameter_carries_the_token_only_where_a_call_passes_it() {
        let source = rules(
            "    function hasRole(claims, role) {
      return claims.role == role;
    }
    function owns(data) {
      return data.owner == request.auth.uid;
    }
    function viaRequest(r) {
      return r.auth.token.region == 'eu';
    }
    match /posts/{post} {
      allow read: if hasRole(request.auth.token, 'reader') && owns(resource.data);
      allow write: if viaRequest(request);
    }",
        );
        // `owns` reads `.owner` of document data, never of the token.
        assert_eq!(
            reads(&source),
            [
                read(Some("role"), Member, "claims.role"),
                read(Some("region"), Member, "r.auth.token.region"),
            ]
        );
    }

    #[test]
    fn the_token_passes_through_nested_calls_lets_and_returns() {
        let source = rules(
            "    function claims() {
      return request.auth.token;
    }
    function check(token, key) {
      return token[key] == true;
    }
    function relay(token) {
      let inner = token;
      return check(inner, 'unused');
    }
    match /posts/{post} {
      allow read: if claims().verified && relay(claims());
    }",
        );
        assert_eq!(
            reads(&source),
            [
                read(None, Dynamic, "token[key]"),
                read(Some("verified"), Member, "claims().verified"),
            ]
        );
    }

    #[test]
    fn a_dynamic_index_has_no_key_and_a_key_list_is_a_presence_test() {
        let source = rules(
            "    match /orgs/{org} {
      allow read: if request.auth.token[org] == 'member';
      allow create: if request.auth.token.keys().hasAny(['owner', 'admin']);
      allow update: if 'editor' in request.auth.token.keys();
      allow delete: if request.auth.token.get(org, null) != null;
    }",
        );
        assert_eq!(
            reads(&source),
            [
                read(None, Dynamic, "request.auth.token[org]"),
                read(
                    Some("admin"),
                    In,
                    "request.auth.token.keys().hasAny(['owner', 'admin'])"
                ),
                read(
                    Some("owner"),
                    In,
                    "request.auth.token.keys().hasAny(['owner', 'admin'])"
                ),
                read(Some("editor"), In, "'editor' in request.auth.token.keys()"),
                read(None, Get, "request.auth.token.get(org, null)"),
            ]
        );
    }

    #[test]
    fn calls_resolve_where_the_condition_sits() {
        // Two blocks declare their own `allowed`: only the one handed the
        // token reads a claim, though both read `.level` of their parameter.
        let source = rules(
            "    match /a/{doc} {
      function allowed(value) { return value.level > 1; }
      allow read: if allowed(request.auth.token);
    }
    match /b/{doc} {
      function allowed(value) { return value.level > 2; }
      allow read: if allowed(resource.data);
    }",
        );
        assert_eq!(reads(&source), [read(Some("level"), Member, "value.level")]);
        let reads = compile(&source).claim_reads();
        assert_eq!(reads[0].range.line, 5, "{reads:?}");
    }

    #[test]
    fn a_function_nothing_calls_and_a_path_still_report_their_reads() {
        let source = rules(
            "    function unusedRole() {
      return request.auth.token.role;
    }
    function shadowed(request) {
      return request.auth.token.ignored;
    }
    match /teams/{team} {
      allow read: if exists(/databases/$(database)/documents/teams/$(request.auth.token.team));
    }",
        );
        // A parameter named `request` hides the request, and no call passes
        // the request in its place.
        assert_eq!(
            reads(&source),
            [
                read(Some("role"), Member, "request.auth.token.role"),
                read(Some("team"), Member, "request.auth.token.team"),
            ]
        );
    }

    #[test]
    fn a_storage_ruleset_is_read_the_same_way() {
        let source = "service firebase.storage {
  match /b/{bucket}/o {
    function quota() { return request.auth.token.get('quotaMb', 10); }
    match /uploads/{name} {
      allow write: if request.resource.size < quota() * 1024 * 1024
        && request.auth.token.uploader == true;
    }
  }
}
";
        let ruleset = compile(source);
        assert_eq!(ruleset.service(), crate::RulesService::FirebaseStorage);
        assert_eq!(
            reads(source),
            [
                read(
                    Some("quotaMb"),
                    Get,
                    "request.auth.token.get('quotaMb', 10)"
                ),
                read(Some("uploader"), Member, "request.auth.token.uploader"),
            ]
        );
    }

    #[test]
    fn positions_are_utf16_after_a_non_ascii_comment() {
        let source = rules(
            "    // Rôles 🔥 des éditeurs\n    match /posts/{post} {\n      allow read: if request.auth.token.role == 'éditeur';\n    }",
        );
        let reads = compile(&source).claim_reads();
        let [read] = reads.as_slice() else {
            panic!("one read: {reads:?}");
        };
        let byte = source.find("request.auth.token.role").expect("present");
        // ô and é are two bytes and one unit each, 🔥 four bytes and two
        // units, so the read starts four units before its byte offset.
        assert_eq!(byte - read.range.from, 4);
        assert_eq!(read.range.from, source[..byte].encode_utf16().count());
        assert_eq!(
            utf16_slice(&source, read.range.from, read.range.to),
            "request.auth.token.role"
        );
        assert_eq!(read.range.line, 6);
        assert_eq!(read.range.column, 22);
    }

    #[test]
    fn the_frozen_complex_ruleset_reads_two_claims() {
        let reads = compile(COMPLEX_RULES).claim_reads();
        let found = reads
            .iter()
            .map(|read| (read.key.as_deref(), read.form, read.range.line))
            .collect::<Vec<_>>();
        assert_eq!(
            found,
            [(Some("role"), Member, 11), (Some("tenant_id"), Member, 23)]
        );
        for read in &reads {
            assert_eq!(
                utf16_slice(COMPLEX_RULES, read.range.from, read.range.to),
                format!(
                    "request.auth.token.{}",
                    read.key.as_deref().unwrap_or_default()
                )
            );
        }
    }

    #[test]
    fn a_cycle_the_compiler_cannot_see_ends() {
        // Each block's functions are acyclic on their own, so this compiles;
        // from the inner block, `b` calls the outer `a`, which resolves `b`
        // where the condition sits and so calls it again.
        let source = rules(
            "    function a(t) { return b(t); }
    match /posts/{post} {
      function b(t) { return t.level > 0 || a(t); }
      allow read: if b(request.auth.token);
    }",
        );
        assert_eq!(reads(&source), [read(Some("level"), Member, "t.level")]);
    }

    #[test]
    fn a_ruleset_near_the_size_limit_reports_each_read_once() {
        let blocks = (0..800)
            .map(|block| {
                format!(
                    "    match /c{block}/{{doc}} {{\n      function local() {{ return has(request.auth.token, 'k{block}') && request.auth.token.c{block} == 1; }}\n      allow read: if local();\n      match /sub/{{item}} {{ allow write: if local() && has(request.auth.token, 'x'); }}\n    }}\n"
                )
            })
            .collect::<Vec<_>>()
            .concat();
        let source = rules(&format!(
            "    function has(claims, key) {{ return claims.get(key, false) == true; }}\n{blocks}"
        ));
        assert!(source.len() > 150_000, "{}", source.len());
        let reads = compile(&source).claim_reads();
        // The helper's `get` once, however many blocks call it, and one
        // member read per block.
        assert_eq!(reads.len(), 801);
        assert_eq!((reads[0].key.as_deref(), reads[0].form), (None, Get));
        assert_eq!(reads[800].key.as_deref(), Some("c799"));
    }
}
