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
/// or over-depth rulesets. A caller must keep the previously installed ruleset
/// when this function returns an error.
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
    let program = parser::parse(source)
        .map_err(|error| vec![diagnostic(source, error.offset, error.message)])?;
    let mut validation = Vec::new();
    validate_function_map(source, &program.functions, &mut validation);
    for block in &program.matches {
        validate_functions(source, block, &mut validation);
    }
    if validation.is_empty() {
        Ok(Ruleset {
            program: Arc::new(program),
            source: Arc::from(source),
        })
    } else {
        Err(validation)
    }
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
    for name in graph.keys() {
        let mut visiting = BTreeSet::new();
        match function_depth(name, &graph, &mut visiting, &mut memo) {
            Ok(depth) if depth > 21 => diagnostics.push(diagnostic(
                source,
                0,
                "maximum allowed function call depth of 20 is exceeded".to_owned(),
            )),
            Ok(_) => {}
            Err(cycle) => diagnostics.push(diagnostic(
                source,
                0,
                format!("recursive function call is not allowed: {cycle}"),
            )),
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
        assert!(error[0].message.contains("recursive function"));
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
        }
    }
}
