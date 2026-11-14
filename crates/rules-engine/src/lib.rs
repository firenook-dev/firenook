//! Clean-room Firestore Security Rules v2 compiler and evaluator.
//!
//! Phase 3 behavior is derived from the frozen production and official Java
//! oracle fixtures under `conformance/fixtures/rules-v2`.

#![forbid(unsafe_code)]

mod analysis;
mod ast;
mod coverage_layout;
mod coverage_observer;
mod evaluator;
mod explain;
mod expression_depth;
mod issues;
mod lexer;
mod model;
mod parser;
mod trace;

pub use analysis::{
    CollectionGovernance, GoverningMap, GoverningMatch, LintCode, OutlineAllow, OutlineMatch,
    RulesOutline, SourceRange, UnusedMatch,
};
pub use coverage_layout::{CoverageNode, SourcePosition};
pub use coverage_observer::{
    CoverageObserver, ExpressionKey, ExpressionValue, MapDifference, MapKeyStatus, QueryComparison,
    QueryProof,
};
pub use explain::{
    EvaluationExplanation, ExplainedAllow, ExplanationStep, MAXIMUM_EXPLANATION_STEPS,
    MAXIMUM_VALUE_CHARS, RulesExplainer, SourceIndex, SourceSpan,
};

pub use trace::{
    AllowDecision, AllowLocation, AllowOutcome, EvaluationTrace, MAXIMUM_TRACE_OUTCOMES,
};

pub use model::{
    AtomicEvaluationResult, Auth, ConstraintOperator, DocumentAccess, DocumentAccessError,
    EmptyDocumentAccess, EvaluationRequest, EvaluationResult, FieldConstraint, LatLng,
    MAXIMUM_REFUSALS, PRODUCTION_DENIAL, Query, QueryFilter, QueryScope, RefusingAllow,
    RequestOperation, Resource, RulesDuration, RulesService, RuntimeError, StorageObject,
    Timestamp, TimestampParseError, Value,
};

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use ast::{Expr, ExprKind, MatchBlock, Program};

/// Maximum UTF-8 source size accepted by a deployed ruleset.
pub const MAXIMUM_SOURCE_BYTES: usize = 262_144;

/// The stack a thread that evaluates rules is given (#228).
///
/// Compile lets a call stack reach 21 functions and an expression 99 levels,
/// so one evaluation nests about 2,100 levels at most, and every level is a
/// frame of the evaluator's. Measured at those limits, with each call at the
/// deepest point of its expression, the hungriest shape (a function's
/// argument nested in another's) overflows 8 MiB and fits in 10 in a release
/// build, and fits in 48 MiB in a debug build; chains of `&&`, `!`, the
/// conditional, lists, maps, methods and arithmetic need less. The stack
/// given is several times that. A thread's stack is reserved, not committed,
/// so a thread that never nests deep uses no more memory for it.
pub const EVALUATION_STACK_BYTES: usize = if cfg!(debug_assertions) {
    128 * 1024 * 1024
} else {
    32 * 1024 * 1024
};

/// Severity attached to a compiler diagnostic.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticSeverity {
    /// The ruleset cannot be installed.
    Error,
    /// The ruleset is valid but contains a suspicious construct.
    Warning,
}

/// One source-positioned rules compiler diagnostic.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    /// Diagnostic severity.
    pub severity: DiagnosticSeverity,
    /// Human-readable explanation.
    pub message: String,
    /// One-based source line.
    pub line: usize,
    /// One-based Unicode-scalar source column.
    pub column: usize,
    /// Zero-based UTF-8 byte offset.
    pub byte_offset: usize,
    /// Zero-based UTF-16 code-unit offset of the start. Browser editors
    /// index text in UTF-16, so this is what places a mark there; the byte
    /// offset would drift after the first non-ASCII character.
    pub from: usize,
    /// Exclusive UTF-16 end. Equal to `from` when only a position is known,
    /// as for compiler errors.
    pub to: usize,
    /// The lint that raised a warning; `None` for a compiler error.
    pub code: Option<LintCode>,
}

/// Structural counts for an installed ruleset.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RulesetStatistics {
    /// Match declarations, including nested matches.
    pub matches: usize,
    /// Allow declarations before method expansion.
    pub allows: usize,
    /// User-defined functions.
    pub functions: usize,
    /// Literal, single-wildcard, and recursive-wildcard match segments.
    pub pattern_segments: usize,
    /// Expanded concrete operations covered by allow declarations.
    pub operations: usize,
    /// User-defined function parameters.
    pub parameters: usize,
    /// Parsed expression nodes.
    pub expressions: usize,
}

/// Parsed and validated Firestore Security Rules v2 source.
#[derive(Clone, Debug)]
pub struct Ruleset {
    program: Arc<Program>,
    source: Arc<str>,
    issues: Arc<[Diagnostic]>,
}

impl Ruleset {
    /// Source-positioned dynamic expressions before any evaluation counters.
    /// This does not evaluate rules or issue document reads.
    #[must_use]
    pub fn coverage_layout(&self) -> Vec<CoverageNode> {
        coverage_layout::layout(&self.program, &self.source)
    }

    /// Exact immutable source associated with this ruleset's trace locations.
    #[must_use]
    pub fn source(&self) -> &str {
        &self.source
    }

    /// The same source, shared rather than copied, for a caller that keeps
    /// it longer than the ruleset (a version history keeps the text, not the
    /// compiled program).
    #[must_use]
    pub fn shared_source(&self) -> Arc<str> {
        Arc::clone(&self.source)
    }

    /// The match blocks and allow statements in source order, positioned in
    /// UTF-16. Nothing is evaluated.
    #[must_use]
    pub fn outline(&self) -> RulesOutline {
        analysis::outline(&self.program, &self.source)
    }

    /// The official compiler's warnings for this source, in its words and in
    /// source order: what the official emulator answers as `issues` with a
    /// rules reload. Each spans the name it is about; a [`Self::lints`]
    /// warning is Firenook's own.
    #[must_use]
    pub fn issues(&self) -> &[Diagnostic] {
        &self.issues
    }

    /// Warnings about constructs that compile but rarely mean what was
    /// intended, in source order. Each carries its [`LintCode`].
    #[must_use]
    pub fn lints(&self) -> Vec<Diagnostic> {
        analysis::lints(&self.program, &self.source)
    }

    /// Which match blocks govern the documents of each collection pattern
    /// (`users/*/orders`, as a schema index writes them) in `database_id`,
    /// and which blocks govern none of them. Matching is the evaluator's
    /// own, run against a representative document path per pattern, so the
    /// answer agrees with what a request would hit.
    #[must_use]
    pub fn governing<S: AsRef<str>>(
        &self,
        database_id: &str,
        collection_patterns: &[S],
    ) -> GoverningMap {
        analysis::governing(
            &self.program,
            &self.source,
            database_id,
            collection_patterns,
        )
    }

    /// Service named by the `service` head.
    #[must_use]
    pub fn service(&self) -> RulesService {
        self.program.service
    }

    /// Declared `rules_version`; `1` when the declaration is absent, which
    /// only `service firebase.storage` sources may omit.
    #[must_use]
    pub fn rules_version(&self) -> u8 {
        self.program.rules_version
    }

    /// Evaluates once, with bounded allow-decision diagnostics. This follows the
    /// same evaluation path and access budgets as `evaluate`; it does not replay
    /// expressions or issue additional document reads for diagnostics.
    #[must_use]
    pub fn evaluate_with_trace<A: DocumentAccess + ?Sized>(
        &self,
        request: &EvaluationRequest,
        access: &A,
    ) -> (EvaluationResult, EvaluationTrace) {
        evaluator::evaluate_with_trace(&self.program, request, access)
    }

    /// Evaluate once with bounded allow tracing and a trusted borrowed coverage
    /// observer. The observer must obey its nonblocking, bounded-storage contract.
    #[must_use]
    pub fn evaluate_with_coverage<A: DocumentAccess + ?Sized>(
        &self,
        request: &EvaluationRequest,
        access: &A,
        observer: &mut dyn CoverageObserver,
    ) -> (EvaluationResult, EvaluationTrace) {
        evaluator::evaluate_with_coverage(&self.program, request, access, observer)
    }

    /// Observe atomic operations without changing shared access budgets/caches.
    #[must_use]
    pub fn evaluate_atomic_with_coverage<A: DocumentAccess + ?Sized>(
        &self,
        requests: &[EvaluationRequest],
        access: &A,
        observer: &mut dyn CoverageObserver,
    ) -> (AtomicEvaluationResult, Vec<EvaluationTrace>) {
        evaluator::evaluate_atomic_with_coverage(&self.program, requests, access, observer)
    }

    /// Evaluates an atomic request with one trace per operation, in request order.
    /// Document-access accounting and caching remain shared across the batch.
    #[must_use]
    pub fn evaluate_atomic_with_trace<A: DocumentAccess + ?Sized>(
        &self,
        requests: &[EvaluationRequest],
        access: &A,
    ) -> (AtomicEvaluationResult, Vec<EvaluationTrace>) {
        evaluator::evaluate_atomic_with_trace(&self.program, requests, access)
    }

    /// Returns stable structural counts for diagnostics and gate evidence.
    #[must_use]
    pub fn statistics(&self) -> RulesetStatistics {
        RulesetStatistics {
            matches: self.program.match_count(),
            allows: self.program.allow_count(),
            functions: self.program.function_count(),
            pattern_segments: self.program.pattern_segment_count(),
            operations: self.program.operation_count(),
            parameters: self.program.parameter_count(),
            expressions: self.program.expression_count(),
        }
    }

    /// Evaluates one request against this immutable ruleset and snapshot.
    #[must_use]
    pub fn evaluate<A: DocumentAccess + ?Sized>(
        &self,
        request: &EvaluationRequest,
        access: &A,
    ) -> EvaluationResult {
        evaluator::evaluate(&self.program, request, access)
    }

    /// Evaluates a transaction or batched write with one shared 20-access
    /// budget while retaining the frozen 10-access per-operation limit.
    #[must_use]
    pub fn evaluate_atomic<A: DocumentAccess + ?Sized>(
        &self,
        requests: &[EvaluationRequest],
        access: &A,
    ) -> AtomicEvaluationResult {
        evaluator::evaluate_atomic(&self.program, requests, access)
    }
}

/// Compiles Firestore Security Rules v2 source without consulting runtime data.
///
/// # Errors
///
/// Returns source-positioned diagnostics for oversized, malformed, recursive,
/// or over-depth rulesets: a chain of calls too deep, or an expression nested
/// too deep. A caller must keep the previously installed ruleset when this
/// function returns an error.
pub fn compile(source: &str) -> Result<Ruleset, Vec<Diagnostic>> {
    if source.len() > MAXIMUM_SOURCE_BYTES {
        return Err(vec![diagnostic(
            source,
            MAXIMUM_SOURCE_BYTES.min(source.len()),
            format!(
                "rules source is {} bytes; maximum is {MAXIMUM_SOURCE_BYTES}",
                source.len()
            ),
        )]);
    }
    if source.is_empty() {
        // At no line or column, as the official emulator answers it
        // (developer-tools-compile-errors-v1 top/empty).
        return Err(vec![Diagnostic {
            severity: DiagnosticSeverity::Error,
            message: "Rules content empty. Compilation aborted.".to_owned(),
            line: 0,
            column: 0,
            byte_offset: 0,
            from: 0,
            to: 0,
            code: None,
        }]);
    }
    let (mut program, refused) = parser::parse_program(source).map_err(|errors| {
        errors
            .into_iter()
            .map(|error| diagnostic(source, error.offset, error.message))
            .collect::<Vec<_>>()
    })?;
    // The official compiler's warnings are answered beside what is refused
    // in a source that parses (production/duplicate-let), and with it in
    // source order.
    let issues = issues::warnings(&program)
        .into_iter()
        .map(|(span, message)| Diagnostic {
            severity: DiagnosticSeverity::Warning,
            to: utf16_offset(source, span.end),
            ..diagnostic(source, span.start, message)
        })
        .collect::<Vec<_>>();
    let refuse = |mut refused: Vec<Diagnostic>| {
        refused.extend(issues.iter().cloned());
        refused.sort_by(|left, right| {
            (left.byte_offset, &left.message).cmp(&(right.byte_offset, &right.message))
        });
        refused
    };
    if !refused.is_empty() {
        return Err(refuse(
            refused
                .into_iter()
                .map(|error| diagnostic(source, error.offset, error.message))
                .collect(),
        ));
    }
    let mut validation = Vec::new();
    validate_function_map(source, &program.functions, &mut validation);
    for block in &program.matches {
        validate_functions(source, block, &mut validation);
    }
    expression_depth::check(source, &program, &mut validation);
    if !validation.is_empty() {
        return Err(refuse(validation));
    }
    // The rules of a service the official compiler does not know govern
    // nothing (top/service-name-misspelled: the official emulator then
    // refuses every request).
    if !issues::service_is_known(&program) {
        program.matches.clear();
    }
    Ok(Ruleset {
        program: Arc::new(program),
        source: Arc::from(source),
        issues: issues.into(),
    })
}

fn validate_functions(source: &str, block: &MatchBlock, diagnostics: &mut Vec<Diagnostic>) {
    validate_function_map(source, &block.functions, diagnostics);
    for child in &block.children {
        validate_functions(source, child, diagnostics);
    }
}

fn validate_function_map(
    source: &str,
    functions: &BTreeMap<String, ast::Function>,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let function_names = functions.keys().cloned().collect::<BTreeSet<_>>();
    let graph = functions
        .iter()
        .map(|(name, function)| {
            let mut calls = BTreeSet::new();
            for (_, value) in &function.lets {
                collect_direct_calls(value, &mut calls);
            }
            collect_direct_calls(&function.result, &mut calls);
            calls.retain(|called| function_names.contains(called));
            (name.clone(), calls)
        })
        .collect::<BTreeMap<_, _>>();
    let mut memo = BTreeMap::new();
    let mut recursive = BTreeSet::new();
    for name in graph.keys() {
        let mut visiting = BTreeSet::new();
        if let Err(cycle) = function_depth(name, &graph, &mut visiting, &mut memo) {
            recursive.insert(cycle);
        }
    }
    // Each function a cycle of calls returns to, once, at its name. One that
    // calls itself is worded as production and the official emulator word
    // it (rules-v2 production-parse-errors recursive-function,
    // developer-tools-compile-errors-v1 production/recursive-function).
    let mut recursive = recursive.into_iter().collect::<Vec<_>>();
    recursive.sort_by_key(|name| functions[name].name_start);
    for name in recursive {
        let message = if graph[&name].contains(&name) {
            "Recursive call is not allowed.".to_owned()
        } else {
            format!("recursive function call is not allowed: {name}")
        };
        diagnostics.push(diagnostic(source, functions[&name].name_start, message));
    }
    // Production refuses a chain of calls that would open a 22nd frame
    // (`function-depth-22` and `-23` of the production limit probes) with one
    // issue, at the declaration of the function that frame would be, naming
    // the 21 frames already open. Every longest chain starts at a function
    // no other function calls; each over-deep function is named once.
    let called = graph.values().flatten().collect::<BTreeSet<_>>();
    let mut roots = graph
        .keys()
        .filter(|name| !called.contains(name) && memo.get(*name) > Some(&MAXIMUM_CALL_FRAMES))
        .collect::<Vec<_>>();
    roots.sort_by_key(|name| functions[*name].name_start);
    let mut walk = DepthWalk {
        source,
        functions,
        graph: &graph,
        memo: &memo,
        stack: Vec::new(),
        walked: BTreeSet::new(),
        reported: BTreeSet::new(),
    };
    for root in roots {
        walk.stack.push(root);
        walk.calls(diagnostics);
        walk.stack.pop();
    }
}

/// The frames a chain of user function calls may hold: production evaluates
/// `f0` … `f20` and refuses a 22nd (`maximum allowed call depth of 20`, the
/// first frame being depth 0).
const MAXIMUM_CALL_FRAMES: usize = 21;

/// The call chains of one function map that open more frames than
/// [`MAXIMUM_CALL_FRAMES`].
struct DepthWalk<'a> {
    source: &'a str,
    functions: &'a BTreeMap<String, ast::Function>,
    graph: &'a BTreeMap<String, BTreeSet<String>>,
    /// The frames of the longest chain from each function.
    memo: &'a BTreeMap<String, usize>,
    stack: Vec<&'a str>,
    /// A function already walked at the same depth reports nothing new;
    /// remembering it keeps the walk proportional to the calls.
    walked: BTreeSet<(&'a str, usize)>,
    reported: BTreeSet<&'a str>,
}

impl DepthWalk<'_> {
    /// Walks the calls of the last function on the stack that lead to a
    /// chain too deep, and refuses the first function each such chain would
    /// open past the limit.
    fn calls(&mut self, diagnostics: &mut Vec<Diagnostic>) {
        let caller = self.stack.last().copied().expect("a frame");
        if !self.walked.insert((caller, self.stack.len())) {
            return;
        }
        let functions = self.functions;
        let mut calls = self.graph[caller].iter().collect::<Vec<_>>();
        calls.sort_by_key(|name| functions[*name].name_start);
        for called in calls {
            if self.stack.len() == MAXIMUM_CALL_FRAMES {
                if self.reported.insert(called) {
                    diagnostics.push(diagnostic(
                        self.source,
                        functions[called].name_start,
                        format!(
                            "Maximum allowed call depth of {} is reached for [{}] call stack.",
                            MAXIMUM_CALL_FRAMES - 1,
                            self.stack.join("->")
                        ),
                    ));
                }
            } else if self.stack.len() + self.memo[called] > MAXIMUM_CALL_FRAMES {
                self.stack.push(called);
                self.calls(diagnostics);
                self.stack.pop();
            }
        }
    }
}

fn function_depth(
    name: &str,
    graph: &BTreeMap<String, BTreeSet<String>>,
    visiting: &mut BTreeSet<String>,
    memo: &mut BTreeMap<String, usize>,
) -> Result<usize, String> {
    if let Some(depth) = memo.get(name) {
        return Ok(*depth);
    }
    if !visiting.insert(name.to_owned()) {
        return Err(name.to_owned());
    }
    let mut depth = 1_usize;
    if let Some(calls) = graph.get(name) {
        for called in calls {
            depth = depth.max(1 + function_depth(called, graph, visiting, memo)?);
        }
    }
    visiting.remove(name);
    memo.insert(name.to_owned(), depth);
    Ok(depth)
}

fn collect_direct_calls(expression: &Expr, calls: &mut BTreeSet<String>) {
    match &expression.kind {
        ExprKind::Call { callee, arguments } => {
            if let ExprKind::Variable(name) = &callee.kind {
                calls.insert(name.clone());
            }
            collect_direct_calls(callee, calls);
            for argument in arguments {
                collect_direct_calls(argument, calls);
            }
        }
        ExprKind::List(values) => {
            for value in values {
                collect_direct_calls(value, calls);
            }
        }
        ExprKind::Map(entries) => {
            for (_, value) in entries {
                collect_direct_calls(value, calls);
            }
        }
        ExprKind::Path(parts) => {
            for part in parts {
                if let ast::PathPart::Interpolation(value) = part {
                    collect_direct_calls(value, calls);
                }
            }
        }
        ExprKind::Field { base, .. } => collect_direct_calls(base, calls),
        ExprKind::Index { base, index } => {
            collect_direct_calls(base, calls);
            collect_direct_calls(index, calls);
        }
        ExprKind::Slice { base, start, end } => {
            collect_direct_calls(base, calls);
            if let Some(start) = start {
                collect_direct_calls(start, calls);
            }
            if let Some(end) = end {
                collect_direct_calls(end, calls);
            }
        }
        ExprKind::Unary { operand, .. } => collect_direct_calls(operand, calls),
        ExprKind::Binary { left, right, .. } => {
            collect_direct_calls(left, calls);
            collect_direct_calls(right, calls);
        }
        ExprKind::Is { value, .. } => collect_direct_calls(value, calls),
        ExprKind::Conditional {
            condition,
            then,
            otherwise,
        } => {
            collect_direct_calls(condition, calls);
            collect_direct_calls(then, calls);
            collect_direct_calls(otherwise, calls);
        }
        ExprKind::Null
        | ExprKind::Bool(_)
        | ExprKind::Integer(_)
        | ExprKind::Float(_)
        | ExprKind::String(_)
        | ExprKind::Variable(_) => {}
    }
}

fn diagnostic(source: &str, offset: usize, message: String) -> Diagnostic {
    // An offset past the end, or inside a multi-byte character (the size
    // limit cuts wherever it falls), must not panic the slicing below.
    let offset = source.floor_char_boundary(offset.min(source.len()));
    let before = &source[..offset];
    let from = before.encode_utf16().count();
    let line = before.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let column = before
        .rsplit_once('\n')
        .map_or(before, |(_, line)| line)
        .chars()
        .count()
        + 1;
    Diagnostic {
        severity: DiagnosticSeverity::Error,
        message,
        line,
        column,
        byte_offset: offset,
        from,
        to: from,
        code: None,
    }
}

/// The UTF-16 code-unit offset of a UTF-8 byte offset in `source`, which is
/// how a browser editor addresses the same place. An offset inside a
/// character is taken at that character's start.
#[must_use]
pub fn utf16_offset(source: &str, byte_offset: usize) -> usize {
    let offset = source.floor_char_boundary(byte_offset.min(source.len()));
    source[..offset].encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value as JsonValue;

    const COMPLEX_RULES: &str =
        include_str!("../../../conformance/fixtures/rules-v2/complex-firestore.rules");
    const PARSE_ORACLE: &str =
        include_str!("../../../conformance/fixtures/rules-v2/production-parse-errors.json");

    #[test]
    fn compiles_the_frozen_complex_ruleset() {
        let rules = compile(COMPLEX_RULES).expect("frozen complex rules should compile");
        let statistics = rules.statistics();
        assert!(statistics.matches >= 70, "{statistics:?}");
        assert!(statistics.allows >= 300, "{statistics:?}");
        assert!(statistics.functions >= 10, "{statistics:?}");
    }

    #[test]
    fn rejects_oversized_source_before_parsing() {
        let source = "x".repeat(MAXIMUM_SOURCE_BYTES + 1);
        let error = compile(&source).expect_err("oversized source must fail");
        assert!(error[0].message.contains("maximum is 262144"));
    }

    #[test]
    fn compiler_errors_carry_utf16_positions_for_browser_editors() {
        let source = "// é🔥\nrules_version = '2'; service cloud.firestore { match }";
        let errors = compile(source).expect_err("a match without a path must fail");
        let error = &errors[0];
        assert_eq!(error.from, utf16_offset(source, error.byte_offset));
        // é is two bytes and one unit, 🔥 four bytes and two units.
        assert_eq!(error.byte_offset - error.from, 3);
        assert_eq!(error.to, error.from, "only a position is known");
        assert_eq!(error.code, None);
    }

    #[test]
    fn an_oversized_source_cut_inside_a_character_is_still_reported() {
        let source = format!("{}é", "x".repeat(MAXIMUM_SOURCE_BYTES - 1));
        let error = compile(&source).expect_err("oversized source must fail");
        assert_eq!(error[0].byte_offset, MAXIMUM_SOURCE_BYTES - 1);
        assert_eq!(error[0].from, MAXIMUM_SOURCE_BYTES - 1);
    }

    #[test]
    fn a_function_return_needs_no_semicolon() {
        for terminator in ["", ";"] {
            let source = format!(
                "rules_version = '2'; service cloud.firestore {{
                   match /databases/{{database}}/documents {{
                     function signedIn() {{ return request.auth != null{terminator} }}
                     match /notes/{{id}} {{ allow get: if signedIn(); }}
                   }}
                 }}"
            );
            let rules = compile(&source).expect("a return with or without ';' compiles");
            let mut request = EvaluationRequest::new(
                RequestOperation::Get,
                "/databases/(default)/documents/notes/n1",
                Timestamp::new(1, 0),
            );
            request.auth = Some(Auth {
                uid: Some("alice".to_owned()),
                token: BTreeMap::new(),
            });
            assert!(
                rules.evaluate(&request, &EmptyDocumentAccess).allowed,
                "terminator {terminator:?}"
            );
        }
    }

    #[test]
    fn rejects_recursive_functions() {
        let source = r"
          rules_version = '2'; service cloud.firestore {
            match /databases/{database}/documents {
              function recurse() { return recurse(); }
              match /items/{item} { allow get: if recurse(); }
            }
          }
        ";
        let error = compile(source).expect_err("recursive function must fail");
        // Once, at the function's name, as production words it.
        assert_eq!(error.len(), 1, "{error:?}");
        assert_eq!(error[0].message, "Recursive call is not allowed.");
        assert_eq!((error[0].line, error[0].column), (4, 24));
    }

    #[test]
    fn an_empty_source_is_refused_at_no_position() {
        let error = compile("").expect_err("an empty source is refused");
        assert_eq!(
            error[0].message,
            "Rules content empty. Compilation aborted."
        );
        assert_eq!((error[0].line, error[0].column), (0, 0));
        // Only an empty one: blank lines are a source that ends too soon.
        let error = compile("\n").expect_err("a blank source is refused");
        assert_eq!((error[0].line, error[0].column), (2, 1));
    }

    #[test]
    fn replays_the_frozen_production_parse_boundary() {
        let fixture: JsonValue =
            serde_json::from_str(PARSE_ORACLE).expect("parse fixture should be valid JSON");
        let observations = fixture["observations"]
            .as_array()
            .expect("parse observations should be an array");
        for observation in observations {
            let id = observation["id"]
                .as_str()
                .expect("observation id should be a string");
            let source = observation["source"]
                .as_str()
                .expect("observation source should be a string");
            let result = compile(source);
            match id {
                "unexpected-token"
                | "unclosed-block"
                | "duplicate-let"
                | "recursive-function"
                | "invalid-recursive-wildcard"
                | "source-bytes-262145" => {
                    assert!(result.is_err(), "{id} must be rejected");
                }
                "undefined-name"
                | "invalid-function-arity"
                | "source-bytes-255999"
                | "source-bytes-256000"
                | "source-bytes-256001"
                | "source-bytes-262143"
                | "source-bytes-262144" => {
                    assert!(result.is_ok(), "{id} should compile: {result:?}");
                }
                other => panic!("unclassified frozen parse observation {other}"),
            }
            let recorded_refused = observation["httpStatus"] != 200
                || observation["response"]["issues"]
                    .as_array()
                    .is_some_and(|issues| issues.iter().any(|issue| issue["severity"] == "ERROR"));
            let case = format!("parse-errors/{id}");
            if recorded_refused == result.is_err() {
                firenook_conformance_ledger::checked(
                    "rules-v2/production-rules-api",
                    &case,
                    firenook_conformance_ledger::Compared::Verdict,
                );
            } else if matches!(id, "source-bytes-262143" | "source-bytes-262144") {
                firenook_conformance_ledger::differs(
                    "rules-v2/production-rules-api",
                    &case,
                    firenook_conformance_ledger::Compared::Verdict,
                    "the Rules API's request envelope refuses this source below the documented 256 KiB deployed-rules maximum; Firenook accepts a source up to 262,144 bytes",
                );
            }
        }
    }

    #[test]
    fn indexes_a_string_by_utf16_code_unit() {
        let rules = compile(
            "rules_version = '2'; service cloud.firestore {
               match /databases/{database}/documents {
                 match /s/{id} { allow get: if resource.data.s[resource.data.i] == resource.data.want; }
               }
             }",
        )
        .expect("rules compile");
        // Verdicts recorded from the official emulator (firebase-tools 15.31.0).
        let cases: [(&str, i64, &str, bool); 9] = [
            ("c123", 0, "c", true),
            ("c123", 3, "3", true),
            ("aé", 1, "é", true),
            ("é🔥x", 0, "é", true),
            ("é🔥x", 3, "x", true),
            ("é🔥x", 1, "🔥", false),
            ("é🔥x", 2, "x", false),
            ("abc", 3, "", false),
            ("abc", -1, "c", false),
        ];
        for (value, index, want, allowed) in cases {
            let path = "/databases/(default)/documents/s/case";
            let mut request =
                EvaluationRequest::new(RequestOperation::Get, path, Timestamp::new(1, 0));
            request.resource = Some(Resource::new(
                path,
                BTreeMap::from([
                    ("s".to_owned(), Value::from(value)),
                    ("i".to_owned(), Value::Integer(index)),
                    ("want".to_owned(), Value::from(want)),
                ]),
            ));
            assert_eq!(
                rules.evaluate(&request, &EmptyDocumentAccess).allowed,
                allowed,
                "{value:?}[{index}] == {want:?}"
            );
        }
    }

    #[test]
    fn measures_slices_and_cases_strings_and_slices_lists_as_the_official_emulator_does() {
        // Verdicts recorded from the official emulator (firebase-tools 15.34.0,
        // Firestore 1.22.0): size and slices count UTF-16 code units, a slice
        // must start at an element and end after one, and only ASCII letters
        // change case.
        let cases: [(&str, bool); 28] = [
            ("'🔥'.size() == 2", true),
            ("'é🔥x'.size() == 4", true),
            ("'é🔥x'.size() == 3", false),
            ("'abc'[0:2] == 'ab'", true),
            ("'abc'[1:1] == ''", true),
            ("'abc'[2:2] == ''", true),
            ("'abc'[0:3] == 'abc'", true),
            ("'abc'[0:0] == ''", false),
            ("'abc'[3:3] == ''", false),
            ("'abc'[0:4] == 'abc'", false),
            ("'abc'[2:1] == ''", false),
            ("'abc'[-1:2] == 'ab'", false),
            ("''[0:0] == ''", false),
            ("'é🔥x'[0:1] == 'é'", true),
            ("'é🔥x'[1:3] == '🔥'", true),
            ("'é🔥x'[3:4] == 'x'", true),
            ("[1, 2, 3, 4][1:3] == [2, 3]", true),
            ("[1, 2, 3, 4][2:2] == []", true),
            ("[1, 2, 3, 4][0:0] == []", false),
            ("[1, 2, 3, 4][4:4] == []", false),
            ("[1, 2, 3, 4][0:5] == [1, 2, 3, 4]", false),
            ("'é🔥x'.upper() == 'é🔥X'", true),
            ("'é🔥x'.upper() == 'É🔥X'", false),
            ("'ß'.upper() == 'ß'", true),
            ("'ß'.upper() == 'SS'", false),
            ("'École'.lower() == 'École'", true),
            ("'ÉCOLE'.lower() == 'école'", false),
            ("'Σίσυφος'.lower() == 'σίσυφος'", false),
        ];
        for (expression, allowed) in cases {
            let source = format!(
                "rules_version = '2'; service cloud.firestore {{ match /databases/{{database}}/documents {{ match /s/{{id}} {{ allow get: if {expression}; }} }} }}"
            );
            let rules = compile(&source).expect("rules compile");
            let path = "/databases/(default)/documents/s/case";
            let request = EvaluationRequest::new(RequestOperation::Get, path, Timestamp::new(1, 0));
            assert_eq!(
                rules.evaluate(&request, &EmptyDocumentAccess).allowed,
                allowed,
                "{expression}"
            );
        }
    }

    /// `count` functions `f0` … in a chain, the last returning true, at the
    /// service level; `entry` is the allow's condition.
    fn call_chain(count: usize, entry: &str) -> String {
        use std::fmt::Write as _;
        let mut functions = String::new();
        for index in 0..count - 1 {
            writeln!(
                functions,
                "  function f{index}() {{ return f{}(); }}",
                index + 1
            )
            .unwrap();
        }
        writeln!(functions, "  function f{}() {{ return true; }}", count - 1).unwrap();
        format!(
            "rules_version = '2';\nservice cloud.firestore {{\n{functions}  match /databases/{{database}}/documents/c/{{id}} {{\n    allow get: if {entry};\n  }}\n}}\n"
        )
    }

    #[test]
    fn a_too_deep_chain_is_refused_once_where_its_22nd_frame_is_declared() {
        // Two chains share their over-deep tail and a third branch stays
        // within the limit: one issue, for the first stack that reaches it.
        let mut source = call_chain(23, "f0() && g0()");
        source = source.replace(
            "  function f0() { return f1(); }",
            "  function f0() { return f1() && f20(); }\n  function g0() { return f1(); }",
        );
        let errors = compile(&source).expect_err("a 22nd frame must be refused");
        assert_eq!(errors.len(), 1, "{errors:?}");
        let stack = (0..21).map(|index| format!("f{index}")).collect::<Vec<_>>();
        assert_eq!(
            errors[0].message,
            format!(
                "Maximum allowed call depth of 20 is reached for [{}] call stack.",
                stack.join("->")
            )
        );
        let declaration = source.find("function f21()").unwrap() + "function ".len();
        assert_eq!(errors[0].byte_offset, declaration);
        assert!(compile(&call_chain(21, "f0()")).is_ok());
    }

    #[test]
    fn evaluation_opens_21_function_frames_and_refuses_a_22nd() {
        // A match-level function calling the service-level chain is past what
        // the compile-time check of one scope sees; evaluation holds the limit.
        let rules = |count: usize| {
            let source = call_chain(count, "g()").replace(
                "    allow get:",
                "    function g() { return f0(); }\n    allow get:",
            );
            compile(&source).expect("each scope's own chain is within the limit")
        };
        let request = EvaluationRequest::new(
            RequestOperation::Get,
            "/databases/(default)/documents/c/one",
            Timestamp::new(1, 0),
        );
        assert!(rules(20).evaluate(&request, &EmptyDocumentAccess).allowed);
        let refused = rules(21).evaluate(&request, &EmptyDocumentAccess);
        assert!(!refused.allowed);
        assert_eq!(
            refused.error.expect("the 22nd frame").message,
            "maximum allowed call depth of 20 is reached"
        );
    }

    /// The expression budget's accounting, at its edge. Every expression is
    /// charged once it has its value; `&&` once more when it goes on to its
    /// right operand, failing at the operator; a literal operand before the
    /// other operand; and a field access fails where its member chain starts.
    #[test]
    fn the_expression_budget_runs_out_where_its_1001st_charge_falls() {
        // `true` (1), `&&` going on (2), the list's `n` literals and the list
        // (n + 3), `0` and the index (n + 5), the first `&&` (n + 6); then
        // the second `&&` going on (n + 7), `'get'` (n + 8), `request`
        // (n + 9), `.method` (n + 10), `==` (n + 11), the second `&&`
        // (n + 12).
        let failing_at = |n: usize| {
            let list = vec!["true"; n].join(", ");
            let source = format!(
                "rules_version = '2'; service cloud.firestore {{ match /databases/{{d}}/documents/c/{{id}} {{ allow get: if true && [{list}][0] && request.method == 'get'; }} }}"
            );
            let request = EvaluationRequest::new(
                RequestOperation::Get,
                "/databases/(default)/documents/c/one",
                Timestamp::new(1, 0),
            );
            let result = compile(&source)
                .unwrap()
                .evaluate(&request, &EmptyDocumentAccess);
            let Some(error) = result.error else {
                return "allowed".to_owned();
            };
            assert_eq!(
                error.message,
                "maximum of 1000 expressions to evaluate has been reached"
            );
            let key = error.expression_key().expect("a position");
            source[key.start..key.end].to_owned()
        };
        assert_eq!(failing_at(988), "allowed");
        assert_eq!(failing_at(990), "request.method == 'get'");
        assert_eq!(failing_at(991), "request");
        assert_eq!(failing_at(992), "request");
        assert_eq!(failing_at(993), "'get'");
        assert_eq!(failing_at(994), "&&");
    }
}
