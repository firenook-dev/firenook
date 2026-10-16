//! What a ruleset says, read without evaluating it.
//!
//! An editor needs three things the evaluator never computes: an outline to
//! navigate by, warnings for the constructs that compile yet rarely mean
//! what was intended, and — given the collections that actually hold data —
//! which match blocks govern each one and which govern nothing at all. The
//! last is usually a typo in a path, and without this it surfaces only as a
//! request denied for no visible reason.
//!
//! Every position is in UTF-16 code units. The consumer is a browser
//! editor, whose offsets are JavaScript string indices; the compiler's byte
//! offsets would misplace every mark after the first non-ASCII character,
//! and a comment in another language is enough for that.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use crate::ast::{
    Allow, BinaryOperator, Expr, ExprKind, Function, MatchBlock, Operation, PathPart,
    PatternSegment, Program,
};
use crate::evaluator::match_pattern;
use crate::{Diagnostic, DiagnosticSeverity, RequestOperation, RulesService};

/// Stands for a document id in a representative document path. A schema
/// pattern writes ids as `*` and a path needs one; this never meets a
/// literal id it could be mistaken for, because a block with a literal id at
/// that position is given its own literal instead.
const PLACEHOLDER_ID: &str = "__firenook_id__";

/// The order operations are listed in, whatever order the source used.
const OPERATION_ORDER: [Operation; 5] = [
    Operation::Get,
    Operation::List,
    Operation::Create,
    Operation::Update,
    Operation::Delete,
];

/// Where something is in rules source.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourceRange {
    /// One-based line of the start.
    pub line: usize,
    /// One-based Unicode-scalar column of the start, counted the way
    /// compiler diagnostics count it.
    pub column: usize,
    /// Zero-based UTF-16 offset of the start.
    pub from: usize,
    /// Exclusive UTF-16 offset of the end.
    pub to: usize,
}

/// The match blocks of a ruleset, depth first in source order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RulesOutline {
    /// Declared `rules_version`.
    pub rules_version: u8,
    /// Every match block except the documents root itself, which is a
    /// scope rather than something a document can match.
    pub matches: Vec<OutlineMatch>,
}

/// One match block.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutlineMatch {
    /// The full pattern below the documents root, nesting included, such as
    /// `/users/{uid}/orders/{orderId}`. A block outside the root shows its
    /// whole pattern.
    pub path: String,
    /// The `match /…` header.
    pub header: SourceRange,
    /// Nesting below the documents root: its direct children are 0.
    pub depth: usize,
    /// The block's own allow statements, in source order.
    pub allows: Vec<OutlineAllow>,
}

/// One allow statement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutlineAllow {
    /// The whole statement, `allow` through its semicolon.
    pub statement: SourceRange,
    /// The condition as written; empty (at the statement's end) when the
    /// statement has none.
    pub condition_range: SourceRange,
    /// The operations granted, `read` and `write` expanded, in the order
    /// get, list, create, update, delete.
    pub operations: Vec<RequestOperation>,
    /// The condition's source text; `true` for a statement without one,
    /// which is what it means.
    pub condition: String,
    /// `Some` when the condition is the literal `true` or `false`.
    pub always: Option<bool>,
}

/// Which match blocks govern which collections.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GoverningMap {
    /// One entry per collection pattern asked about, in the order asked.
    pub collections: Vec<CollectionGovernance>,
    /// Match blocks that govern none of those collections, nor does any
    /// block nested in them, in source order. Empty when no collection was
    /// asked about: with no data there is nothing to be unused against.
    pub unused_matches: Vec<UnusedMatch>,
}

/// The match blocks that govern the documents of one collection pattern.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollectionGovernance {
    /// The pattern as asked, such as `users/*/orders`.
    pub pattern: String,
    /// Blocks whose pattern matches its documents, in source order. A block
    /// with a literal document id (`/config/global`) governs some of them
    /// and is included.
    pub governed_by: Vec<GoverningMatch>,
}

impl CollectionGovernance {
    /// No block matches these documents, so every client request for them
    /// is denied.
    #[must_use]
    pub const fn uncovered(&self) -> bool {
        self.governed_by.is_empty()
    }
}

/// A block that governs a collection, with what it can grant there.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoverningMatch {
    /// Line of the block's header.
    pub line: usize,
    /// The block's outline path.
    pub path: String,
    /// The operations its allow statements grant under some condition (a
    /// literal `false` grants nothing and is left out), in canonical order.
    pub operations: Vec<RequestOperation>,
}

/// A block no collection in the data reaches.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnusedMatch {
    /// Line of the block's header.
    pub line: usize,
    /// The block's outline path.
    pub path: String,
}

/// Which lint raised a warning.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum LintCode {
    /// An unconditional allow on a block that reaches arbitrary collections.
    OpenAccess,
    /// A condition that only asks whether the caller is signed in.
    AuthOnly,
    /// A create or update allowed without looking at the written data.
    UnvalidatedWrite,
    /// A recursive wildcard under `rules_version` 1, where it does not
    /// match collection group queries.
    CollectionGroupV1,
    /// Storage: an upload allowed with checks on what is uploaded but none
    /// on its size.
    UnboundedUpload,
    /// Storage: a list allowed below `rules_version` 2, where every list
    /// request is refused.
    ListV1,
}

impl LintCode {
    /// The stable name a client keys on.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::OpenAccess => "open-access",
            Self::AuthOnly => "auth-only",
            Self::UnvalidatedWrite => "unvalidated-write",
            Self::CollectionGroupV1 => "collection-group-v1",
            Self::UnboundedUpload => "unbounded-upload",
            Self::ListV1 => "list-v1",
        }
    }
}

/// Byte → line, column and UTF-16 offset, without rescanning the source per
/// position: an outline of a large ruleset asks for hundreds of them.
struct LineIndex<'a> {
    source: &'a str,
    /// Byte offset of each line's start.
    starts: Vec<usize>,
    /// UTF-16 offset of each line's start.
    utf16_starts: Vec<usize>,
}

impl<'a> LineIndex<'a> {
    fn new(source: &'a str) -> Self {
        let mut starts = vec![0];
        let mut utf16_starts = vec![0];
        let mut utf16 = 0;
        for (offset, character) in source.char_indices() {
            utf16 += character.len_utf16();
            if character == '\n' {
                starts.push(offset + 1);
                utf16_starts.push(utf16);
            }
        }
        Self {
            source,
            starts,
            utf16_starts,
        }
    }

    /// Zero-based line, one-based column and UTF-16 offset of a byte offset.
    fn locate(&self, offset: usize) -> (usize, usize, usize) {
        let offset = self
            .source
            .floor_char_boundary(offset.min(self.source.len()));
        let line = self.starts.partition_point(|start| *start <= offset) - 1;
        let prefix = &self.source[self.starts[line]..offset];
        (
            line,
            prefix.chars().count() + 1,
            self.utf16_starts[line] + prefix.encode_utf16().count(),
        )
    }

    fn range(&self, span: Range<usize>) -> SourceRange {
        let (line, column, from) = self.locate(span.start);
        let (_, _, to) = self.locate(span.end.max(span.start));
        SourceRange {
            line: line + 1,
            column,
            from,
            to,
        }
    }

    fn line(&self, offset: usize) -> usize {
        self.locate(offset).0 + 1
    }
}

/// One match block with what its nesting gives it.
struct Flat<'p> {
    block: &'p MatchBlock,
    /// The full pattern from the top, enclosing blocks' segments first.
    pattern: Vec<PatternSegment>,
    /// Where the segments below the documents root start, when the block
    /// lies under the root.
    below_root: Option<usize>,
    /// The outline path.
    path: String,
    depth: usize,
    /// The nearest enclosing block in the flat list.
    parent: Option<usize>,
    /// Functions visible to the block's conditions: the service's, then each
    /// enclosing block's, inner definitions shadowing outer ones.
    functions: BTreeMap<&'p str, &'p Function>,
}

impl Flat<'_> {
    /// The segments that decide what the block reaches: those below the
    /// documents root, or the whole pattern for a block outside it.
    fn scope(&self) -> &[PatternSegment] {
        self.below_root
            .map_or(&self.pattern[..], |root| &self.pattern[root..])
    }
}

/// Every match block, depth first in source order, the documents root left
/// out (its children are depth 0).
fn flatten(program: &Program) -> Vec<Flat<'_>> {
    let functions = program
        .functions
        .iter()
        .map(|(name, function)| (name.as_str(), function))
        .collect::<BTreeMap<_, _>>();
    let mut flat = Vec::new();
    for block in &program.matches {
        visit(
            program.service,
            block,
            &[],
            &functions,
            (0, None),
            &mut flat,
        );
    }
    flat
}

fn visit<'p>(
    service: RulesService,
    block: &'p MatchBlock,
    parent_pattern: &[PatternSegment],
    inherited: &BTreeMap<&'p str, &'p Function>,
    (depth, parent): (usize, Option<usize>),
    flat: &mut Vec<Flat<'p>>,
) {
    let mut pattern = parent_pattern.to_vec();
    pattern.extend(block.pattern.iter().cloned());
    let mut functions = inherited.clone();
    functions.extend(
        block
            .functions
            .iter()
            .map(|(name, function)| (name.as_str(), function)),
    );
    let root = root_length(&pattern, service);
    let below = if root == Some(pattern.len()) {
        // The documents root names a scope, never a document, so nothing
        // can match it; the outline starts below it.
        (depth, parent)
    } else {
        let path = display_path(root.map_or(&pattern[..], |root| &pattern[root..]));
        flat.push(Flat {
            block,
            pattern: pattern.clone(),
            below_root: root,
            path,
            depth,
            parent,
            functions: functions.clone(),
        });
        (depth + 1, Some(flat.len() - 1))
    };
    for child in &block.children {
        visit(service, child, &pattern, &functions, below, flat);
    }
}

/// Three segments when `pattern` begins with the service's documents root
/// (`/databases/{database}/documents`, or `/b/{bucket}/o` for Storage).
fn root_length(pattern: &[PatternSegment], service: RulesService) -> Option<usize> {
    let (first, last) = match service {
        RulesService::CloudFirestore => ("databases", "documents"),
        RulesService::FirebaseStorage => ("b", "o"),
    };
    match pattern {
        [
            PatternSegment::Literal(head),
            PatternSegment::Literal(_) | PatternSegment::Wildcard(_),
            PatternSegment::Literal(tail),
            ..,
        ] if head == first && tail == last => Some(3),
        _ => None,
    }
}

fn display_path(segments: &[PatternSegment]) -> String {
    let mut path = String::new();
    for segment in segments {
        path.push('/');
        match segment {
            PatternSegment::Literal(id) => path.push_str(id),
            PatternSegment::Wildcard(name) => {
                path.push('{');
                path.push_str(name);
                path.push('}');
            }
            PatternSegment::RecursiveWildcard(name) => {
                path.push('{');
                path.push_str(name);
                path.push_str("=**}");
            }
        }
    }
    if path.is_empty() {
        path.push('/');
    }
    path
}

const fn request_operation(operation: Operation) -> RequestOperation {
    match operation {
        Operation::Get => RequestOperation::Get,
        Operation::List => RequestOperation::List,
        Operation::Create => RequestOperation::Create,
        Operation::Update => RequestOperation::Update,
        Operation::Delete => RequestOperation::Delete,
    }
}

fn canonical(operations: &[Operation]) -> Vec<RequestOperation> {
    OPERATION_ORDER
        .iter()
        .filter(|operation| operations.contains(operation))
        .map(|operation| request_operation(*operation))
        .collect()
}

/// `read and write`, `get, create and update`: what a person reads the
/// granted operations as.
fn verbs(operations: &[Operation]) -> String {
    let has = |operation| operations.contains(&operation);
    let mut verbs = Vec::new();
    match (has(Operation::Get), has(Operation::List)) {
        (true, true) => verbs.push("read"),
        (true, false) => verbs.push("get"),
        (false, true) => verbs.push("list"),
        (false, false) => {}
    }
    if has(Operation::Create) && has(Operation::Update) && has(Operation::Delete) {
        verbs.push("write");
    } else {
        for (operation, verb) in [
            (Operation::Create, "create"),
            (Operation::Update, "update"),
            (Operation::Delete, "delete"),
        ] {
            if has(operation) {
                verbs.push(verb);
            }
        }
    }
    match verbs.split_last() {
        None => String::new(),
        Some((last, [])) => (*last).to_owned(),
        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
    }
}

/// `Some` for a literal `true` or `false` condition.
const fn literal(condition: &Expr) -> Option<bool> {
    match condition.kind {
        ExprKind::Bool(value) => Some(value),
        _ => None,
    }
}

pub(crate) fn outline(program: &Program, source: &str) -> RulesOutline {
    let index = LineIndex::new(source);
    let matches = flatten(program)
        .iter()
        .map(|flat| OutlineMatch {
            path: flat.path.clone(),
            header: index.range(flat.block.header.clone()),
            depth: flat.depth,
            allows: flat
                .block
                .allows
                .iter()
                .map(|allow| OutlineAllow {
                    statement: index.range(allow.statement.clone()),
                    condition_range: index.range(allow.condition_span.clone()),
                    operations: canonical(&allow.operations),
                    condition: if allow.condition_span.is_empty() {
                        "true".to_owned()
                    } else {
                        source[allow.condition_span.clone()].to_owned()
                    },
                    always: literal(&allow.condition),
                })
                .collect(),
        })
        .collect();
    RulesOutline {
        rules_version: program.rules_version,
        matches,
    }
}

pub(crate) fn lints(program: &Program, source: &str) -> Vec<Diagnostic> {
    let index = LineIndex::new(source);
    let storage = program.service == RulesService::FirebaseStorage;
    // What the rules guard, in the words of the service.
    let noun = if storage { "file" } else { "document" };
    let mut lints = Vec::new();
    for flat in flatten(program) {
        let scope = flat.scope();
        // Reaches collections nobody named: a recursive wildcard anywhere,
        // or a wildcard where the collection id goes.
        let reaches_anything = scope
            .iter()
            .any(|segment| matches!(segment, PatternSegment::RecursiveWildcard(_)))
            || matches!(scope.first(), Some(PatternSegment::Wildcard(_)));
        for allow in &flat.block.allows {
            let always = literal(&allow.condition);
            // The condition when there is one, else the whole statement.
            let target = if allow.condition_span.is_empty() {
                allow.statement.clone()
            } else {
                allow.condition_span.clone()
            };
            let open = reaches_anything && always == Some(true);
            if open {
                lints.push(warning(
                    &index,
                    target.clone(),
                    LintCode::OpenAccess,
                    format!(
                        "Anyone, signed in or not, can {} every {noun} under {}",
                        verbs(&allow.operations),
                        flat.path
                    ),
                ));
            }
            if is_signed_in_check(&allow.condition) {
                lints.push(warning(
                    &index,
                    target.clone(),
                    LintCode::AuthOnly,
                    auth_only_message(storage, scope, &allow.operations),
                ));
            }
            let writes = allow
                .operations
                .iter()
                .any(|operation| matches!(operation, Operation::Create | Operation::Update));
            // An open grant already says anyone may write anything, and a
            // literal `false` lets nothing through to validate.
            let validates =
                checks_written_data(&allow.condition, &flat.functions, &mut BTreeSet::new());
            if writes && !open && always != Some(false) && !validates {
                lints.push(warning(
                    &index,
                    target.clone(),
                    LintCode::UnvalidatedWrite,
                    if storage {
                        "Uploads here are not validated: nothing checks request.resource (its size or contentType)."
                    } else {
                        "Writes here are not validated: nothing checks request.resource.data."
                    }
                    .to_owned(),
                ));
            }
            if storage && always != Some(false) {
                storage_lints(
                    (program, &flat, allow),
                    &index,
                    target,
                    validates,
                    &mut lints,
                );
            }
        }
        // Reported on the block whose own pattern introduces the wildcard,
        // once, rather than on every block nested in it.
        if program.service == RulesService::CloudFirestore
            && program.rules_version < 2
            && let Some(name) = flat.block.pattern.iter().find_map(|segment| match segment {
                PatternSegment::RecursiveWildcard(name) => Some(name),
                _ => None,
            })
        {
            lints.push(warning(
                &index,
                flat.block.header.clone(),
                LintCode::CollectionGroupV1,
                format!(
                    "Without rules_version = '2', {{{name}=**}} does not match collection group queries."
                ),
            ));
        }
    }
    lints.sort_by_key(|lint| (lint.from, lint.to));
    lints
}

/// What `auth-only` says: who can do what, and the wildcard naming the
/// owner to compare the caller with.
fn auth_only_message(storage: bool, scope: &[PatternSegment], operations: &[Operation]) -> String {
    let verbs = verbs(operations);
    if storage {
        // A Storage block's last segment names the file; the owner is a
        // folder above it.
        let wildcard = last_wildcard(&scope[..scope.len().saturating_sub(1)])
            .or_else(|| last_wildcard(scope))
            .unwrap_or("uid");
        format!(
            "Any signed-in user can {verbs} every file here, not only their own. Compare request.auth.uid with the {{{wildcard}}} in the path."
        )
    } else {
        let wildcard = last_wildcard(scope).unwrap_or("uid");
        format!(
            "Any signed-in user can {verbs} every document here, not only their own. Compare request.auth.uid with the document's owner field or the {{{wildcard}}} in the path."
        )
    }
}

/// The lints only Storage rules can earn, for one allow statement whose
/// condition can grant something.
fn storage_lints(
    (program, flat, allow): (&Program, &Flat<'_>, &Allow),
    index: &LineIndex<'_>,
    target: Range<usize>,
    validates: bool,
    lints: &mut Vec<Diagnostic>,
) {
    // Every upload, over an existing object too, is judged as `create`;
    // `update` is a metadata patch that cannot change the size, so only a
    // grant of `create` can leave uploads unbounded. A grant that checks
    // nothing at all is `unvalidated-write` already.
    if validates
        && allow.operations.contains(&Operation::Create)
        && !reads_upload_size(&allow.condition, &flat.functions, &mut BTreeSet::new())
    {
        lints.push(warning(
            index,
            target,
            LintCode::UnboundedUpload,
            "Uploads here have no size limit. Add request.resource.size < 10 * 1024 * 1024 (or your own limit)."
                .to_owned(),
        ));
    }
    // Mirrors the evaluator, which refuses every list below version 2.
    if program.rules_version < 2 && allow.operations.contains(&Operation::List) {
        lints.push(warning(
            index,
            allow.statement.clone(),
            LintCode::ListV1,
            "List requests are refused below rules_version = '2', so listAll() and list() fail here. Add rules_version = '2'; at the top."
                .to_owned(),
        ));
    }
}

fn warning(
    index: &LineIndex<'_>,
    span: Range<usize>,
    code: LintCode,
    message: String,
) -> Diagnostic {
    let range = index.range(span.clone());
    Diagnostic {
        severity: DiagnosticSeverity::Warning,
        message,
        line: range.line,
        column: range.column,
        byte_offset: span.start,
        from: range.from,
        to: range.to,
        code: Some(code),
    }
}

/// The name of the last single-segment wildcard among `segments`.
fn last_wildcard(segments: &[PatternSegment]) -> Option<&str> {
    segments.iter().rev().find_map(|segment| match segment {
        PatternSegment::Wildcard(name) => Some(name.as_str()),
        _ => None,
    })
}

/// The whole condition is `request.auth != null` or
/// `request.auth.uid != null`, either way round.
fn is_signed_in_check(condition: &Expr) -> bool {
    let ExprKind::Binary {
        operator: BinaryOperator::NotEqual,
        left,
        right,
    } = &condition.kind
    else {
        return false;
    };
    let is_null = |expression: &Expr| matches!(expression.kind, ExprKind::Null);
    (is_auth(left) && is_null(right)) || (is_null(left) && is_auth(right))
}

/// `request.auth` or `request.auth.uid`.
fn is_auth(expression: &Expr) -> bool {
    let ExprKind::Field { base, name } = &expression.kind else {
        return false;
    };
    match name.as_str() {
        "auth" => is_variable(base, "request"),
        "uid" => matches!(
            &base.kind,
            ExprKind::Field { base, name } if name == "auth" && is_variable(base, "request")
        ),
        _ => false,
    }
}

fn is_variable(expression: &Expr, expected: &str) -> bool {
    matches!(&expression.kind, ExprKind::Variable(name) if name == expected)
}

/// Whether evaluating `expression` can look at what is being written:
/// `request.resource`, or the post-write state through `getAfter` and
/// `existsAfter` (how a batch validates one document against another).
/// User functions it calls are followed, each once.
fn checks_written_data<'p>(
    expression: &Expr,
    functions: &BTreeMap<&'p str, &'p Function>,
    followed: &mut BTreeSet<&'p str>,
) -> bool {
    let mut checks = |expression: &Expr| checks_written_data(expression, functions, followed);
    match &expression.kind {
        ExprKind::Field { base, name } => {
            (name == "resource" && is_variable(base, "request")) || checks(base)
        }
        ExprKind::Index { base, index } => {
            (is_variable(base, "request")
                && matches!(&index.kind, ExprKind::String(key) if key == "resource"))
                || checks(base)
                || checks(index)
        }
        ExprKind::Call { callee, arguments } => {
            if let ExprKind::Variable(name) = &callee.kind {
                if name == "getAfter" || name == "existsAfter" {
                    return true;
                }
                if let Some((&key, function)) = functions.get_key_value(name.as_str())
                    && followed.insert(key)
                    && (function
                        .lets
                        .iter()
                        .any(|(_, value)| checks_written_data(value, functions, followed))
                        || checks_written_data(&function.result, functions, followed))
                {
                    return true;
                }
            }
            checks_written_data(callee, functions, followed)
                || arguments
                    .iter()
                    .any(|argument| checks_written_data(argument, functions, followed))
        }
        ExprKind::List(values) => values.iter().any(checks),
        ExprKind::Map(entries) => entries.iter().any(|(_, value)| checks(value)),
        ExprKind::Path(parts) => parts.iter().any(|part| match part {
            PathPart::Literal(_) => false,
            PathPart::Interpolation(value) => checks(value),
        }),
        ExprKind::Slice { base, start, end } => {
            checks(base)
                || start.as_deref().is_some_and(&mut checks)
                || end.as_deref().is_some_and(&mut checks)
        }
        ExprKind::Unary { operand, .. } => checks(operand),
        ExprKind::Binary { left, right, .. } => checks(left) || checks(right),
        ExprKind::Is { value, .. } => checks(value),
        ExprKind::Null
        | ExprKind::Bool(_)
        | ExprKind::Integer(_)
        | ExprKind::Float(_)
        | ExprKind::String(_)
        | ExprKind::Variable(_) => false,
    }
}

/// Whether evaluating `expression` can read the upload's size:
/// `request.resource.size`, however indexed, here or in a user function it
/// calls (each followed once).
fn reads_upload_size<'p>(
    expression: &Expr,
    functions: &BTreeMap<&'p str, &'p Function>,
    followed: &mut BTreeSet<&'p str>,
) -> bool {
    let is_request_resource = |expression: &Expr| match &expression.kind {
        ExprKind::Field { base, name } => name == "resource" && is_variable(base, "request"),
        ExprKind::Index { base, index } => {
            is_variable(base, "request")
                && matches!(&index.kind, ExprKind::String(key) if key == "resource")
        }
        _ => false,
    };
    let mut reads = |expression: &Expr| reads_upload_size(expression, functions, followed);
    match &expression.kind {
        ExprKind::Field { base, name } => {
            (name == "size" && is_request_resource(base)) || reads(base)
        }
        ExprKind::Index { base, index } => {
            (is_request_resource(base)
                && matches!(&index.kind, ExprKind::String(key) if key == "size"))
                || reads(base)
                || reads(index)
        }
        ExprKind::Call { callee, arguments } => {
            if let ExprKind::Variable(name) = &callee.kind
                && let Some((&key, function)) = functions.get_key_value(name.as_str())
                && followed.insert(key)
                && (function
                    .lets
                    .iter()
                    .any(|(_, value)| reads_upload_size(value, functions, followed))
                    || reads_upload_size(&function.result, functions, followed))
            {
                return true;
            }
            reads_upload_size(callee, functions, followed)
                || arguments
                    .iter()
                    .any(|argument| reads_upload_size(argument, functions, followed))
        }
        ExprKind::List(values) => values.iter().any(reads),
        ExprKind::Map(entries) => entries.iter().any(|(_, value)| reads(value)),
        ExprKind::Path(parts) => parts.iter().any(|part| match part {
            PathPart::Literal(_) => false,
            PathPart::Interpolation(value) => reads(value),
        }),
        ExprKind::Slice { base, start, end } => {
            reads(base)
                || start.as_deref().is_some_and(&mut reads)
                || end.as_deref().is_some_and(&mut reads)
        }
        ExprKind::Unary { operand, .. } => reads(operand),
        ExprKind::Binary { left, right, .. } => reads(left) || reads(right),
        ExprKind::Is { value, .. } => reads(value),
        ExprKind::Null
        | ExprKind::Bool(_)
        | ExprKind::Integer(_)
        | ExprKind::Float(_)
        | ExprKind::String(_)
        | ExprKind::Variable(_) => false,
    }
}

pub(crate) fn governing<S: AsRef<str>>(
    program: &Program,
    source: &str,
    database_id: &str,
    patterns: &[S],
) -> GoverningMap {
    govern(program, source, patterns, |pattern, block| {
        let segments = pattern.split('/').collect::<Vec<_>>();
        representative_path(database_id, &segments, block)
    })
}

/// Which match blocks govern the files directly in each folder pattern of
/// a Storage bucket (`users/*/uploads/2026/`, `''` for the bucket root):
/// [`governing`] with the representative path a request for one of those
/// files carries.
pub(crate) fn governing_objects<S: AsRef<str>>(
    program: &Program,
    source: &str,
    bucket: &str,
    patterns: &[S],
) -> GoverningMap {
    govern(program, source, patterns, |pattern, block| {
        // A folder pattern ends in `/`; its segments are the folders, the
        // root having none. The rules see a path without empty segments, as
        // the runtime builds it.
        let folders = pattern
            .strip_suffix('/')
            .unwrap_or(pattern)
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        object_representative_path(bucket, &folders, block)
    })
}

/// Matches every block against the representative path `path_of` builds
/// per pattern, and reports the blocks no pattern reaches.
fn govern<S: AsRef<str>>(
    program: &Program,
    source: &str,
    patterns: &[S],
    path_of: impl Fn(&str, &Flat<'_>) -> String,
) -> GoverningMap {
    let index = LineIndex::new(source);
    let flat = flatten(program);
    let mut reached = vec![false; flat.len()];
    let mut collections = Vec::with_capacity(patterns.len());
    for pattern in patterns {
        let pattern = pattern.as_ref();
        let mut governed_by = Vec::new();
        for (position, block) in flat.iter().enumerate() {
            let path = path_of(pattern, block);
            if match_pattern(&block.pattern, &path).is_none() {
                continue;
            }
            reached[position] = true;
            governed_by.push(GoverningMatch {
                line: index.line(block.block.header.start),
                path: block.path.clone(),
                operations: granted(block.block),
            });
        }
        collections.push(CollectionGovernance {
            pattern: pattern.to_owned(),
            governed_by,
        });
    }
    // A block whose nested blocks are reached is a scope in use, even when
    // its own documents hold nothing: only a whole unreached subtree is a
    // likely typo. Parents precede their children in the flat list.
    for position in (0..flat.len()).rev() {
        if reached[position]
            && let Some(parent) = flat[position].parent
        {
            reached[parent] = true;
        }
    }
    let unused_matches = if collections.is_empty() {
        Vec::new()
    } else {
        flat.iter()
            .zip(&reached)
            .filter(|(_, reached)| !**reached)
            .map(|(block, _)| UnusedMatch {
                line: index.line(block.block.header.start),
                path: block.path.clone(),
            })
            .collect()
    };
    GoverningMap {
        collections,
        unused_matches,
    }
}

/// A document path standing for every document of `collection` (a schema
/// pattern split at its slashes: collection ids at even positions, `*` for
/// document ids at odd ones), as a request for one of them would carry it.
/// A document id is the block's own literal when the block names one at
/// that position (`/config/global`), so a block written for one document
/// still counts as governing its collection.
fn representative_path(database_id: &str, collection: &[&str], block: &Flat<'_>) -> String {
    let mut path = format!("/databases/{database_id}/documents");
    let length = collection.len() + collection.len() % 2;
    for position in 0..length {
        path.push('/');
        if position % 2 == 0 {
            path.push_str(collection.get(position).copied().unwrap_or(PLACEHOLDER_ID));
            continue;
        }
        path.push_str(literal_at(block, position).unwrap_or(PLACEHOLDER_ID));
    }
    path
}

/// A file path standing for every file directly in a folder of `bucket`
/// (`folders` as the pattern names them, `*` for any folder at a level), as
/// a request for one of them would carry it. A `*` folder and the file name
/// are the block's own literal when it names one at that position
/// (`match /public/logo.png`), so a block written for one file still counts
/// as governing the folder it lies in.
fn object_representative_path(bucket: &str, folders: &[&str], block: &Flat<'_>) -> String {
    let mut path = format!("/b/{bucket}/o");
    for (position, folder) in folders.iter().enumerate() {
        path.push('/');
        if *folder == "*" {
            path.push_str(literal_at(block, position).unwrap_or(PLACEHOLDER_ID));
        } else {
            path.push_str(folder);
        }
    }
    path.push('/');
    path.push_str(literal_at(block, folders.len()).unwrap_or(PLACEHOLDER_ID));
    path
}

/// The block's literal segment `position` levels below the root, when its
/// pattern names one there. Past a recursive wildcard, pattern positions no
/// longer line up with path positions, so there is none.
fn literal_at<'a>(block: &'a Flat<'_>, position: usize) -> Option<&'a str> {
    block.below_root.and_then(|root| {
        let at = root + position;
        let aligned = !block.pattern[..at.min(block.pattern.len())]
            .iter()
            .any(|segment| matches!(segment, PatternSegment::RecursiveWildcard(_)));
        match block.pattern.get(at) {
            Some(PatternSegment::Literal(id)) if aligned => Some(id.as_str()),
            _ => None,
        }
    })
}

impl crate::Ruleset {
    /// Which match blocks govern the files directly in each folder pattern
    /// of a Storage `bucket` (`users/*/`, as a folder index writes them,
    /// `''` for the bucket root), and which blocks govern none of them.
    /// Each pattern is probed where its files are, at its real depth: a
    /// pattern for files four levels down is not governed by a block that
    /// matches one level only. Matching is the evaluator's own, so the
    /// answer agrees with what a request would hit.
    #[must_use]
    pub fn governing_objects<S: AsRef<str>>(
        &self,
        bucket: &str,
        folder_patterns: &[S],
    ) -> GoverningMap {
        governing_objects(&self.program, &self.source, bucket, folder_patterns)
    }
}

/// What a block's allow statements can grant: every operation of an allow
/// whose condition is not the literal `false`.
fn granted(block: &MatchBlock) -> Vec<RequestOperation> {
    let operations = block
        .allows
        .iter()
        .filter(|allow| literal(&allow.condition) != Some(false))
        .flat_map(|allow| allow.operations.iter().copied())
        .collect::<Vec<_>>();
    canonical(&operations)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RequestOperation::{Create, Delete, Get, List, Update};

    fn compile(source: &str) -> crate::Ruleset {
        crate::compile(source).unwrap_or_else(|errors| panic!("{errors:?}"))
    }

    /// Wraps match blocks in the documents root of a version 2 ruleset.
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

    fn codes(lints: &[Diagnostic]) -> Vec<LintCode> {
        lints.iter().filter_map(|lint| lint.code).collect()
    }

    #[test]
    fn the_outline_nests_expands_operations_and_counts_utf16() {
        let source = rules(
            "    // Règles 🔥 pour les utilisateurs\n    match /users/{uid} {\n      allow read: if request.auth.uid == uid;\n      allow write: if (request.auth.uid == uid);\n      match /orders/{orderId} {\n        allow get, create;\n      }\n    }",
        );
        let outline = compile(&source).outline();
        assert_eq!(outline.rules_version, 2);
        assert_eq!(outline.matches.len(), 2, "{outline:?}");

        let users = &outline.matches[0];
        assert_eq!(users.path, "/users/{uid}");
        assert_eq!(users.depth, 0);
        assert_eq!(users.header.line, 5);
        let byte = source.find("match /users").expect("header");
        let utf16 = source[..byte].encode_utf16().count();
        assert_eq!(users.header.from, utf16);
        // The comment's è (two bytes, one unit) and 🔥 (four bytes, two
        // units) put the UTF-16 offset three behind the byte offset.
        assert_eq!(byte - users.header.from, 3);
        assert_eq!(
            utf16_slice(&source, users.header.from, users.header.to),
            "match /users/{uid}"
        );

        let [read, write] = users.allows.as_slice() else {
            panic!("two allows: {users:?}");
        };
        assert_eq!(read.operations, [Get, List]);
        assert_eq!(read.condition, "request.auth.uid == uid");
        assert_eq!(read.always, None);
        assert_eq!(
            utf16_slice(&source, read.statement.from, read.statement.to),
            "allow read: if request.auth.uid == uid;"
        );
        assert_eq!(write.operations, [Create, Update, Delete]);
        // The closing parenthesis belongs to the condition as written.
        assert_eq!(write.condition, "(request.auth.uid == uid)");
        assert_eq!(
            utf16_slice(
                &source,
                write.condition_range.from,
                write.condition_range.to
            ),
            "(request.auth.uid == uid)"
        );

        let orders = &outline.matches[1];
        assert_eq!(orders.path, "/users/{uid}/orders/{orderId}");
        assert_eq!(orders.depth, 1);
        let [grant] = orders.allows.as_slice() else {
            panic!("one allow: {orders:?}");
        };
        assert_eq!(grant.operations, [Get, Create]);
        assert_eq!(grant.condition, "true");
        assert_eq!(grant.always, Some(true));
        assert_eq!(
            utf16_slice(&source, grant.statement.from, grant.statement.to),
            "allow get, create;"
        );
        assert_eq!(grant.condition_range.from, grant.condition_range.to);
    }

    #[test]
    fn a_block_written_from_the_top_still_reads_below_the_root() {
        let source = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents/items/{item} {\n    allow read: if false;\n  }\n}\n";
        let outline = compile(source).outline();
        assert_eq!(outline.matches[0].path, "/items/{item}");
        assert_eq!(outline.matches[0].depth, 0);
        assert_eq!(outline.matches[0].allows[0].always, Some(false));
    }

    #[test]
    fn open_access_fires_on_an_unconditional_grant_that_reaches_everything() {
        let lints = compile(&rules(
            "    match /{document=**} {\n      allow read, write: if true;\n    }",
        ))
        .lints();
        assert_eq!(codes(&lints), [LintCode::OpenAccess], "{lints:?}");
        assert_eq!(
            lints[0].message,
            "Anyone, signed in or not, can read and write every document under /{document=**}"
        );
        assert_eq!(lints[0].severity, DiagnosticSeverity::Warning);
        assert_eq!(lints[0].line, 5);
        assert_eq!(lints[0].to - lints[0].from, "true".len());

        // A wildcard collection id reaches every collection too; a statement
        // without a condition is marked as a whole.
        let source = rules("    match /{collection}/{doc} {\n      allow read;\n    }");
        let lints = compile(&source).lints();
        assert_eq!(codes(&lints), [LintCode::OpenAccess], "{lints:?}");
        assert_eq!(
            lints[0].message,
            "Anyone, signed in or not, can read every document under /{collection}/{doc}"
        );
        assert_eq!(
            utf16_slice(&source, lints[0].from, lints[0].to),
            "allow read;"
        );
    }

    #[test]
    fn open_access_spares_a_named_collection_and_a_real_condition() {
        let lints = compile(&rules(
            "    match /posts/{post} {\n      allow read: if true;\n    }\n    match /{document=**} {\n      allow read: if request.time < timestamp.date(2030, 1, 1);\n    }",
        ))
        .lints();
        assert!(!codes(&lints).contains(&LintCode::OpenAccess), "{lints:?}");
    }

    #[test]
    fn auth_only_fires_on_a_bare_signed_in_check_either_way_round() {
        let source = rules(
            "    match /notes/{noteId} {\n      allow read: if request.auth != null;\n      allow delete: if null != request.auth.uid;\n    }",
        );
        let lints = compile(&source).lints();
        assert_eq!(
            codes(&lints),
            [LintCode::AuthOnly, LintCode::AuthOnly],
            "{lints:?}"
        );
        assert_eq!(
            lints[0].message,
            "Any signed-in user can read every document here, not only their own. Compare request.auth.uid with the document's owner field or the {noteId} in the path."
        );
        assert_eq!(
            utf16_slice(&source, lints[0].from, lints[0].to),
            "request.auth != null"
        );
        assert!(
            lints[1]
                .message
                .starts_with("Any signed-in user can delete")
        );
    }

    #[test]
    fn auth_only_spares_a_condition_that_also_checks_ownership() {
        let lints = compile(&rules(
            "    match /notes/{uid} {\n      allow read: if request.auth != null && request.auth.uid == uid;\n      allow get: if request.auth == null;\n    }",
        ))
        .lints();
        assert!(codes(&lints).is_empty(), "{lints:?}");
    }

    #[test]
    fn unvalidated_write_fires_when_nothing_reads_the_written_data() {
        let lints = compile(&rules(
            "    match /profiles/{uid} {\n      allow update: if request.auth.uid == resource.data.owner;\n    }",
        ))
        .lints();
        assert_eq!(codes(&lints), [LintCode::UnvalidatedWrite], "{lints:?}");
        assert_eq!(
            lints[0].message,
            "Writes here are not validated: nothing checks request.resource.data."
        );
    }

    #[test]
    fn unvalidated_write_follows_functions_and_spares_what_cannot_write() {
        let lints = compile(&rules(
            "    function named() { return request.resource.data.keys().hasOnly(['name']); }\n    function valid() { return request.auth != null && named(); }\n    match /profiles/{uid} {\n      allow create: if valid();\n      allow update: if getAfter(/databases/$(database)/documents/profiles/$(uid)).data.v == 2;\n      allow write: if false;\n      allow delete: if request.auth.uid == uid;\n    }",
        ))
        .lints();
        assert!(codes(&lints).is_empty(), "{lints:?}");
    }

    #[test]
    fn collection_group_v1_fires_only_for_a_recursive_wildcard_below_version_2() {
        // The compiler refuses a Firestore source below version 2, so the
        // lint is exercised on the program the parser builds.
        let source = rules(
            "    match /{document=**} {\n      allow read: if request.auth.uid != resource.data.owner;\n    }",
        );
        let mut program = crate::parser::parse(&source).expect("parses");
        assert_eq!(codes(&lints(&program, &source)), []);
        program.rules_version = 1;
        let found = lints(&program, &source);
        assert_eq!(codes(&found), [LintCode::CollectionGroupV1], "{found:?}");
        assert_eq!(
            found[0].message,
            "Without rules_version = '2', {document=**} does not match collection group queries."
        );
        assert_eq!(
            utf16_slice(&source, found[0].from, found[0].to),
            "match /{document=**}"
        );

        let plain = rules("    match /items/{item} {\n      allow read: if false;\n    }");
        let mut program = crate::parser::parse(&plain).expect("parses");
        program.rules_version = 1;
        assert_eq!(codes(&lints(&program, &plain)), []);
    }

    /// Wraps match blocks in the Storage root, with a declared version or
    /// none (which Storage allows: version 1).
    fn storage_rules(version: Option<u8>, body: &str) -> String {
        format!(
            "{}service firebase.storage {{\n  match /b/{{bucket}}/o {{\n{body}\n  }}\n}}\n",
            version.map_or_else(String::new, |version| format!(
                "rules_version = '{version}';\n"
            ))
        )
    }

    #[test]
    fn storage_lints_speak_of_files() {
        let lints = compile(&storage_rules(
            Some(2),
            "    match /users/{uid}/{allPaths=**} {\n      allow read, write: if true;\n    }",
        ))
        .lints();
        assert_eq!(codes(&lints), [LintCode::OpenAccess], "{lints:?}");
        assert_eq!(
            lints[0].message,
            "Anyone, signed in or not, can read and write every file under /users/{uid}/{allPaths=**}"
        );

        let lints = compile(&storage_rules(
            Some(2),
            "    match /notes/{uid}/{fileName} {\n      allow read: if request.auth != null;\n      allow write: if request.auth.uid == uid;\n    }",
        ))
        .lints();
        assert_eq!(
            codes(&lints),
            [LintCode::AuthOnly, LintCode::UnvalidatedWrite],
            "{lints:?}"
        );
        assert_eq!(
            lints[0].message,
            "Any signed-in user can read every file here, not only their own. Compare request.auth.uid with the {uid} in the path."
        );
        assert_eq!(
            lints[1].message,
            "Uploads here are not validated: nothing checks request.resource (its size or contentType)."
        );
    }

    #[test]
    fn unbounded_upload_fires_for_create_only() {
        let source = storage_rules(
            Some(2),
            "    match /images/{uid}/{file} {\n      allow write: if request.auth.uid == uid && request.resource.contentType.matches('image/.*');\n      allow update: if request.resource.contentType == resource.contentType;\n    }",
        );
        let lints = compile(&source).lints();
        assert_eq!(codes(&lints), [LintCode::UnboundedUpload], "{lints:?}");
        assert_eq!(
            lints[0].message,
            "Uploads here have no size limit. Add request.resource.size < 10 * 1024 * 1024 (or your own limit)."
        );
        assert!(
            utf16_slice(&source, lints[0].from, lints[0].to).starts_with("request.auth.uid == uid"),
            "placed on the condition"
        );

        // A size check, written directly, indexed or in a function, bounds it.
        for grant in [
            "allow create: if request.resource.size < 5 * 1024 * 1024 && request.resource.contentType == 'image/png';",
            "allow create: if request['resource']['size'] < 1000;",
            "allow create: if small() && request.resource.contentType == 'text/plain';",
        ] {
            let lints = compile(&storage_rules(
                Some(2),
                &format!(
                    "    function small() {{ return request.resource.size < 1000; }}\n    match /docs/{{file}} {{\n      {grant}\n    }}"
                ),
            ))
            .lints();
            assert_eq!(codes(&lints), [], "{grant}: {lints:?}");
        }
    }

    #[test]
    fn list_v1_fires_below_version_2_only() {
        let source = storage_rules(
            None,
            "    match /users/{uid}/{file} {\n      allow read: if request.auth.uid == uid;\n      allow get: if request.auth.uid == uid;\n      allow list: if false;\n    }",
        );
        let lints = compile(&source).lints();
        assert_eq!(codes(&lints), [LintCode::ListV1], "{lints:?}");
        assert_eq!(
            lints[0].message,
            "List requests are refused below rules_version = '2', so listAll() and list() fail here. Add rules_version = '2'; at the top."
        );
        assert_eq!(
            utf16_slice(&source, lints[0].from, lints[0].to),
            "allow read: if request.auth.uid == uid;"
        );
        let lints = compile(&storage_rules(
            Some(2),
            "    match /users/{uid}/{file} {\n      allow read: if request.auth.uid == uid;\n    }",
        ))
        .lints();
        assert_eq!(codes(&lints), [], "{lints:?}");
    }

    #[test]
    fn governing_objects_name_blocks_files_and_folders_nothing_reaches() {
        let ruleset = compile(&storage_rules(
            Some(2),
            "    match /users/{uid}/{allPaths=**} {\n      allow read, write: if request.auth.uid == uid;\n    }\n    match /public/logo.png {\n      allow read;\n    }\n    match /tmp/{f} {\n      allow read: if false;\n    }",
        ));
        let map =
            ruleset.governing_objects("demo.appspot.com", &["users/*/", "public/", "misc/", ""]);
        let by_pattern = map
            .collections
            .iter()
            .map(|folder| (folder.pattern.as_str(), folder))
            .collect::<BTreeMap<_, _>>();
        let users = by_pattern["users/*/"];
        assert_eq!(users.governed_by.len(), 1);
        assert_eq!(users.governed_by[0].path, "/users/{uid}/{allPaths=**}");
        assert_eq!(users.governed_by[0].line, 4);
        assert_eq!(
            users.governed_by[0].operations,
            [Get, List, Create, Update, Delete]
        );
        // A block written for one file governs the folder it lies in.
        let public = by_pattern["public/"];
        assert_eq!(public.governed_by[0].path, "/public/logo.png");
        assert_eq!(public.governed_by[0].operations, [Get, List]);
        assert!(by_pattern["misc/"].uncovered());
        assert!(by_pattern[""].uncovered());
        let unused = map
            .unused_matches
            .iter()
            .map(|block| block.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(unused, ["/tmp/{f}"]);
    }

    #[test]
    fn governing_objects_under_a_recursive_wildcard_cover_every_folder() {
        let ruleset = compile(&storage_rules(
            Some(2),
            "    match /{allPaths=**} {\n      allow read: if request.auth != null;\n    }",
        ));
        let map = ruleset.governing_objects("b", &["", "a/", "a/b/c/d/e/f/", "a//"]);
        assert!(map.collections.iter().all(|folder| {
            folder
                .governed_by
                .iter()
                .any(|block| block.path == "/{allPaths=**}")
        }));
        let nothing: [&str; 0] = [];
        assert_eq!(ruleset.governing_objects("b", &nothing).unused_matches, []);
    }

    #[test]
    fn governing_objects_probe_real_depths() {
        // Files only four levels down are not governed by a block that
        // matches one level below the user's folder.
        let ruleset = compile(&storage_rules(
            Some(2),
            "    match /users/{uid}/{file} {\n      allow read: if request.auth.uid == uid;\n    }",
        ));
        let map = ruleset.governing_objects("b", &["users/*/uploads/2026/", "users/*/"]);
        assert!(map.collections[0].uncovered(), "{map:?}");
        assert_eq!(map.collections[1].governed_by.len(), 1);
        // A literal folder in the block governs the star level it names.
        let ruleset = compile(&storage_rules(
            Some(2),
            "    match /users/admin/{file} {\n      allow read: if true;\n    }",
        ));
        let map = ruleset.governing_objects("b", &["users/*/"]);
        assert_eq!(
            map.collections[0].governed_by[0].path,
            "/users/admin/{file}"
        );
    }

    #[test]
    fn the_map_shows_what_governs_each_collection_and_what_governs_nothing() {
        let ruleset = compile(&rules(
            "    match /users/{uid} {\n      allow read: if request.auth.uid == uid;\n      match /orders/{orderId} {\n        allow get: if request.auth.uid == uid;\n        allow write: if false;\n      }\n    }\n    match /config/global {\n      allow get: if true;\n    }\n    match /usres/{uid} {\n      allow read: if true;\n    }\n    match /admin/{doc} {\n      match /logs/{log} {\n        allow list: if false;\n      }\n    }",
        ));
        let map = ruleset.governing(
            "(default)",
            &["users", "users/*/orders", "config", "products"],
        );
        let by_pattern = map
            .collections
            .iter()
            .map(|collection| (collection.pattern.as_str(), collection))
            .collect::<BTreeMap<_, _>>();

        let users = by_pattern["users"];
        assert!(!users.uncovered());
        assert_eq!(users.governed_by.len(), 1);
        assert_eq!(users.governed_by[0].path, "/users/{uid}");
        assert_eq!(users.governed_by[0].line, 4);
        assert_eq!(users.governed_by[0].operations, [Get, List]);

        let orders = by_pattern["users/*/orders"];
        assert_eq!(orders.governed_by.len(), 1);
        assert_eq!(orders.governed_by[0].path, "/users/{uid}/orders/{orderId}");
        // `allow write: if false` grants nothing.
        assert_eq!(orders.governed_by[0].operations, [Get]);

        // A block written for one document governs its collection.
        let config = by_pattern["config"];
        assert_eq!(config.governed_by[0].path, "/config/global");

        assert!(by_pattern["products"].uncovered());

        let unused = map
            .unused_matches
            .iter()
            .map(|block| block.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            unused,
            ["/usres/{uid}", "/admin/{doc}", "/admin/{doc}/logs/{log}"]
        );
        assert_eq!(map.unused_matches[0].line, 14);
    }

    #[test]
    fn a_recursive_wildcard_governs_every_collection_and_no_data_means_nothing_unused() {
        let ruleset = compile(&rules(
            "    match /{document=**} {\n      allow read: if request.auth != null;\n    }\n    match /orphans/{id} {\n      allow get: if false;\n    }",
        ));
        let map = ruleset.governing("(default)", &["a", "a/*/b/*/c"]);
        assert!(map.collections.iter().all(|collection| {
            collection
                .governed_by
                .iter()
                .any(|block| block.path == "/{document=**}")
        }));
        assert_eq!(map.unused_matches.len(), 1);
        let nothing: [&str; 0] = [];
        assert_eq!(ruleset.governing("(default)", &nothing).unused_matches, []);
    }

    #[test]
    fn the_frozen_complex_ruleset_reads_cleanly() {
        let source = include_str!("../../../conformance/fixtures/rules-v2/complex-firestore.rules");
        // A non-ASCII line in front moves every UTF-16 offset off its byte
        // offset, so a byte/unit mix-up anywhere shows as a bad slice.
        let source = format!("// Überblick 🔥\n{source}");
        let ruleset = compile(&source);
        let outline = ruleset.outline();
        assert!(outline.matches.len() >= 70, "{}", outline.matches.len());
        for block in &outline.matches {
            assert!(
                utf16_slice(&source, block.header.from, block.header.to).starts_with("match /"),
                "{block:?}"
            );
            for allow in &block.allows {
                let statement = utf16_slice(&source, allow.statement.from, allow.statement.to);
                assert!(statement.starts_with("allow "), "{statement}");
                if allow.condition_range.from < allow.condition_range.to {
                    assert_eq!(
                        utf16_slice(
                            &source,
                            allow.condition_range.from,
                            allow.condition_range.to
                        ),
                        allow.condition
                    );
                }
            }
        }
        for lint in ruleset.lints() {
            assert!(lint.from <= lint.to && lint.code.is_some(), "{lint:?}");
        }
        // Every block shaped `/collection/{id}/…/collection/{id}` governs
        // the collection pattern its own path spells.
        let shaped = outline
            .matches
            .iter()
            .filter_map(|block| {
                let segments = block
                    .path
                    .trim_start_matches('/')
                    .split('/')
                    .collect::<Vec<_>>();
                let alternating = segments.len() % 2 == 0
                    && segments.iter().enumerate().all(|(index, segment)| {
                        let wildcard = segment.starts_with('{') && !segment.contains("=**");
                        (index % 2 == 1) == wildcard
                    });
                alternating.then(|| {
                    let collections = segments.iter().step_by(2).copied().collect::<Vec<_>>();
                    (block.path.clone(), collections.join("/*/"))
                })
            })
            .collect::<Vec<_>>();
        assert!(shaped.len() >= 20, "{}", shaped.len());
        let patterns = shaped
            .iter()
            .map(|(_, pattern)| pattern.as_str())
            .collect::<Vec<_>>();
        let map = ruleset.governing("(default)", &patterns);
        for ((path, pattern), collection) in shaped.iter().zip(&map.collections) {
            assert_eq!(&collection.pattern, pattern);
            assert!(
                collection
                    .governed_by
                    .iter()
                    .any(|block| &block.path == path),
                "{pattern} is not governed by {path}: {collection:?}"
            );
        }
    }

    #[test]
    fn the_map_agrees_with_evaluation_about_the_database_segment() {
        let ruleset = compile(
            "rules_version = '2';\nservice cloud.firestore {\n  match /databases/analytics/documents/events/{id} {\n    allow read: if true;\n  }\n}\n",
        );
        assert_eq!(
            ruleset.governing("analytics", &["events"]).collections[0]
                .governed_by
                .len(),
            1
        );
        assert!(ruleset.governing("(default)", &["events"]).collections[0].uncovered());
    }
}
