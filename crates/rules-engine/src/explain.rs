//! Inline values for one evaluation: what each executed expression came to,
//! in the order the evaluator ran it, placed in the source the way an editor
//! counts positions.
//!
//! The explanation rides on the coverage observer, so it sees exactly the
//! expressions the decision executed and the values they produced; nothing is
//! replayed and no extra document is read. Values are rendered to short
//! strings while they are still borrowed from the evaluator, so an
//! explanation retains text, never documents, and its size is bounded by
//! [`MAXIMUM_EXPLANATION_STEPS`] times [`MAXIMUM_VALUE_CHARS`].
//!
//! A list request is proven, not run: the rules must hold for every document
//! the query could return. When they cannot be proven, the comparisons the
//! query's filters failed to establish say what the query is missing, which
//! is what [`EvaluationExplanation::query_reason`] puts into words.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use time::format_description::well_known::Rfc3339;

use crate::ast::MatchBlock;
use crate::{
    AllowDecision, ConstraintOperator, CoverageObserver, DocumentAccess, EvaluationRequest,
    EvaluationResult, ExpressionKey, ExpressionValue, FieldConstraint, MapKeyStatus,
    QueryComparison, QueryProof, QueryScope, RequestOperation, RulesDuration, Ruleset, Value,
};

/// Steps kept per explained request. A function called twice is shown twice,
/// so a deep ruleset reaches this; the explanation then says it was cut.
pub const MAXIMUM_EXPLANATION_STEPS: usize = 400;

/// Characters a rendered value keeps; a longer one ends in `…` at this length.
pub const MAXIMUM_VALUE_CHARS: usize = 160;

/// Comparisons kept per request for the query reason. The reason names at
/// most three; the rest only cost memory.
const MAXIMUM_QUERY_GAPS: usize = 16;

/// A range of the rules source in the units an editor uses: UTF-16 code units,
/// so a console can hand the offsets straight to its text component.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourceSpan {
    /// One-based line of `from`.
    pub line: usize,
    /// Inclusive UTF-16 offset into the source.
    pub from: usize,
    /// Exclusive UTF-16 offset into the source.
    pub to: usize,
}

/// One executed expression and what it evaluated to.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExplanationStep {
    /// The expression.
    pub span: SourceSpan,
    /// The value, rendered (see the module documentation of the console route
    /// for the notation), or the error message when `error` is set.
    pub value: String,
    /// The expression raised instead of producing a value.
    pub error: bool,
}

/// One allow condition the evaluator ran, in order.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExplainedAllow {
    /// The condition (an empty span at its position for `allow read;`).
    pub condition: SourceSpan,
    /// What the condition decided.
    pub decision: AllowDecision,
}

/// Why one evaluation decided what it did.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EvaluationExplanation {
    /// Every allow condition executed, in evaluation order.
    pub allows: Vec<ExplainedAllow>,
    /// Executed expressions in evaluation order (operands before the
    /// expression that uses them), at most [`MAXIMUM_EXPLANATION_STEPS`].
    pub steps: Vec<ExplanationStep>,
    /// More expressions ran than `steps` holds.
    pub truncated: bool,
    /// For a denied list: what the query must add for the rules to be
    /// provable, in plain words. `None` for every other request, and for a
    /// list denied for a reason the query's filters cannot change.
    pub query_reason: Option<String>,
}

/// Byte offset to editor position conversion for one source.
#[derive(Clone, Debug)]
pub struct SourceIndex {
    source: Arc<str>,
    /// Byte offset where each line starts.
    line_starts: Vec<usize>,
    /// UTF-16 offset where each line starts.
    utf16_line_starts: Vec<usize>,
}

impl SourceIndex {
    fn new(source: Arc<str>) -> Self {
        let mut line_starts = vec![0];
        let mut utf16_line_starts = vec![0];
        let mut utf16 = 0;
        for (offset, character) in source.char_indices() {
            utf16 += character.len_utf16();
            if character == '\n' {
                line_starts.push(offset + 1);
                utf16_line_starts.push(utf16);
            }
        }
        Self {
            source,
            line_starts,
            utf16_line_starts,
        }
    }

    /// The editor span of a byte range of this source. Offsets that are not
    /// character boundaries are moved back to the boundary before them.
    #[must_use]
    pub fn span(&self, start: usize, end: usize) -> SourceSpan {
        let line = self.line_starts.partition_point(|offset| *offset <= start);
        SourceSpan {
            line,
            from: self.utf16(start),
            to: self.utf16(end.max(start)),
        }
    }

    fn utf16(&self, offset: usize) -> usize {
        let mut offset = offset.min(self.source.len());
        while !self.source.is_char_boundary(offset) {
            offset -= 1;
        }
        let line = self.line_starts.partition_point(|start| *start <= offset) - 1;
        self.utf16_line_starts[line]
            + self.source[self.line_starts[line]..offset]
                .encode_utf16()
                .count()
    }
}

/// A ruleset prepared for explained evaluation: its source index and the map
/// from allow declarations to their conditions, built once and shared by
/// every request explained against it.
#[derive(Clone, Debug)]
pub struct RulesExplainer<'r> {
    ruleset: &'r Ruleset,
    index: SourceIndex,
    /// Allow declaration byte offset to its condition.
    conditions: BTreeMap<usize, ExpressionKey>,
    condition_keys: BTreeSet<ExpressionKey>,
}

impl Ruleset {
    /// Prepares this ruleset for [`RulesExplainer::evaluate`].
    #[must_use]
    pub fn explainer(&self) -> RulesExplainer<'_> {
        let mut conditions = BTreeMap::new();
        for block in &self.program.matches {
            collect_conditions(block, &mut conditions);
        }
        let condition_keys = conditions.values().copied().collect();
        RulesExplainer {
            ruleset: self,
            index: SourceIndex::new(self.source.clone()),
            conditions,
            condition_keys,
        }
    }
}

fn collect_conditions(block: &MatchBlock, conditions: &mut BTreeMap<usize, ExpressionKey>) {
    for allow in &block.allows {
        conditions.insert(
            allow.location.byte_offset,
            ExpressionKey {
                start: allow.condition.span.start,
                end: allow.condition.span.end,
            },
        );
    }
    for child in &block.children {
        collect_conditions(child, conditions);
    }
}

impl RulesExplainer<'_> {
    /// Evaluates once, exactly as [`Ruleset::evaluate`] does — the same
    /// verdict, error, budgets and document reads — and explains it.
    #[must_use]
    pub fn evaluate<A: DocumentAccess + ?Sized>(
        &self,
        request: &EvaluationRequest,
        access: &A,
    ) -> (EvaluationResult, EvaluationExplanation) {
        let mut recorder = Recorder::new(&self.condition_keys);
        let (result, trace) = self
            .ruleset
            .evaluate_with_coverage(request, access, &mut recorder);
        let allows = trace
            .outcomes()
            .iter()
            .map(|outcome| {
                let condition = self
                    .conditions
                    .get(&outcome.location.byte_offset)
                    .copied()
                    .unwrap_or(ExpressionKey {
                        start: outcome.location.byte_offset,
                        end: outcome.location.byte_offset,
                    });
                ExplainedAllow {
                    condition: self.index.span(condition.start, condition.end),
                    decision: outcome.decision,
                }
            })
            .collect();
        let steps = recorder
            .steps
            .iter()
            .map(|step| ExplanationStep {
                span: self.index.span(step.key.start, step.key.end),
                value: step.value.clone(),
                error: step.error,
            })
            .collect();
        let is_list = request.operation == RequestOperation::List && request.query.scope.is_some();
        let query_reason = (is_list && !result.allowed)
            .then(|| self.query_reason(&recorder))
            .flatten();
        (
            result,
            EvaluationExplanation {
                allows,
                steps,
                truncated: recorder.truncated,
                query_reason,
            },
        )
    }

    /// The editor span of a byte range of this ruleset's source.
    #[must_use]
    pub fn span(&self, key: ExpressionKey) -> SourceSpan {
        self.index.span(key.start, key.end)
    }

    fn query_reason(&self, recorder: &Recorder<'_>) -> Option<String> {
        let mut seen = BTreeSet::new();
        let gaps = recorder
            .gaps
            .iter()
            .chain(&recorder.pending_gaps)
            .filter(|gap| seen.insert(gap.key))
            .take(3)
            .collect::<Vec<_>>();
        let Some((first, rest)) = gaps.split_first() else {
            let key = recorder.unknown_conditions.first()?;
            return Some(format!(
                "The rule at line {} cannot be proven for every document this query may return: {} depends on something the query's filters do not fix.",
                self.span(*key).line,
                self.excerpt(*key),
            ));
        };
        let mut reason = self.gap_sentence(first);
        for gap in rest {
            let _ = write!(
                reason,
                " Alternatively, the rule at line {} accepts {}.",
                self.span(gap.key).line,
                gap.suggestion(),
            );
        }
        Some(reason)
    }

    fn gap_sentence(&self, gap: &Gap) -> String {
        let line = self.span(gap.key).line;
        let rule = self.excerpt(gap.key);
        let field = &gap.field;
        let suggestion = gap.suggestion();
        if gap.constraints.is_empty() {
            return format!(
                "The query must filter on {field}: the rule at line {line} needs {rule} for every result. Add {suggestion}."
            );
        }
        let constraints = &gap.constraints;
        if gap.proven == Some(false) {
            format!(
                "The query's filter on {field} ({constraints}) contradicts the rule at line {line}, which needs {rule} for every result. Use {suggestion}."
            )
        } else {
            format!(
                "The query's filter on {field} ({constraints}) does not guarantee the rule at line {line}, which needs {rule} for every result. Use {suggestion}."
            )
        }
    }

    /// The source of an expression on one line, shortened for a sentence.
    fn excerpt(&self, key: ExpressionKey) -> String {
        let source = &self.ruleset.source;
        let text = source.get(key.start..key.end).unwrap_or_default();
        let mut out = Out::new(120);
        let mut space = false;
        for word in text.split_whitespace() {
            if space {
                out.push(" ");
            }
            out.push(word);
            space = true;
        }
        out.finish()
    }
}

/// One rule comparison the query's filters did not prove.
#[derive(Clone, Debug)]
struct Gap {
    key: ExpressionKey,
    /// Dotted field path, as a query names it.
    field: String,
    operator: ConstraintOperator,
    /// The rule's value, rendered.
    value: String,
    /// The query's predicates on the field, rendered; empty when none.
    constraints: String,
    proven: Option<bool>,
}

impl Gap {
    fn suggestion(&self) -> String {
        format!(
            "where('{}', '{}', {})",
            self.field,
            operator_symbol(self.operator),
            self.value
        )
    }
}

struct RawStep {
    key: ExpressionKey,
    value: String,
    error: bool,
}

/// The observer behind an explanation. Bounded: steps stop at the cap (and
/// are not rendered past it), comparisons at [`MAXIMUM_QUERY_GAPS`].
struct Recorder<'c> {
    condition_keys: &'c BTreeSet<ExpressionKey>,
    steps: Vec<RawStep>,
    truncated: bool,
    /// Comparisons not proven since the last allow condition finished.
    pending_gaps: Vec<Gap>,
    /// Comparisons not proven inside allow conditions that did not hold.
    gaps: Vec<Gap>,
    /// Allow conditions a list proof left undecided.
    unknown_conditions: Vec<ExpressionKey>,
}

impl<'c> Recorder<'c> {
    fn new(condition_keys: &'c BTreeSet<ExpressionKey>) -> Self {
        Self {
            condition_keys,
            steps: Vec::new(),
            truncated: false,
            pending_gaps: Vec::new(),
            gaps: Vec::new(),
            unknown_conditions: Vec::new(),
        }
    }

    fn step(&mut self, key: ExpressionKey, error: bool, render: impl FnOnce(&mut Out)) {
        if self.steps.len() == MAXIMUM_EXPLANATION_STEPS {
            self.truncated = true;
            return;
        }
        let mut out = Out::new(MAXIMUM_VALUE_CHARS);
        render(&mut out);
        self.steps.push(RawStep {
            key,
            value: out.finish(),
            error,
        });
    }

    /// An allow condition finished. Comparisons it left unproven matter only
    /// when it did not hold: an `||` whose other side was true, or an earlier
    /// proof branch that passed, explains nothing about a denial.
    fn condition_finished(&mut self, key: ExpressionKey, held: bool, unknown: bool) {
        if !self.condition_keys.contains(&key) {
            return;
        }
        if held {
            self.pending_gaps.clear();
            return;
        }
        for gap in self.pending_gaps.drain(..) {
            if self.gaps.len() < MAXIMUM_QUERY_GAPS {
                self.gaps.push(gap);
            }
        }
        if unknown && self.unknown_conditions.len() < MAXIMUM_QUERY_GAPS {
            self.unknown_conditions.push(key);
        }
    }
}

impl CoverageObserver for Recorder<'_> {
    fn observe(&mut self, key: ExpressionKey, value: ExpressionValue<'_>) {
        // A namespace (`math`, `timestamp`, …) has no value worth showing.
        if matches!(value, ExpressionValue::Symbolic) {
            return;
        }
        let error = matches!(value, ExpressionValue::Error(_));
        self.step(key, error, |out| render_expression(out, value));
        let held = matches!(value, ExpressionValue::Data(Value::Bool(true)));
        self.condition_finished(key, held, false);
    }

    fn explains_queries(&self) -> bool {
        true
    }

    fn observe_query(
        &mut self,
        key: ExpressionKey,
        value: ExpressionValue<'_>,
        proof: QueryProof<'_>,
    ) {
        self.step(key, false, |out| match proof {
            QueryProof::Resource => out.push("query: any result"),
            QueryProof::Data => out.push("query: any result's data"),
            QueryProof::Unknown => out.push("query: unproven"),
            QueryProof::Field { field, constraints } => {
                let on_field = constraints
                    .iter()
                    .filter(|constraint| constraint.field == field)
                    .collect::<Vec<_>>();
                out.push("query: ");
                if on_field.is_empty() {
                    out.push(&field_path(field));
                    out.push(" unconstrained");
                } else {
                    render_constraints(out, &on_field);
                }
            }
        });
        let held = matches!(value, ExpressionValue::Data(Value::Bool(true)));
        self.condition_finished(key, held, matches!(proof, QueryProof::Unknown));
    }

    fn observe_query_comparison(&mut self, comparison: QueryComparison<'_>) {
        if self.pending_gaps.len() == MAXIMUM_QUERY_GAPS {
            return;
        }
        let on_field = comparison
            .constraints
            .iter()
            .filter(|constraint| constraint.field == comparison.field)
            .collect::<Vec<_>>();
        let mut constraints = Out::new(MAXIMUM_VALUE_CHARS);
        if !on_field.is_empty() {
            render_constraints(&mut constraints, &on_field);
        }
        let mut value = Out::new(MAXIMUM_VALUE_CHARS);
        render_value(&mut value, comparison.value);
        self.pending_gaps.push(Gap {
            key: comparison.key,
            field: field_path(comparison.field),
            operator: comparison.operator,
            value: value.finish(),
            constraints: constraints.finish(),
            proven: comparison.proven,
        });
    }
}

/// A bounded string: text past the limit is dropped and the result ends in
/// `…`, and renderers stop walking a value once it is full, so a large
/// document costs no more to render than a small one.
struct Out {
    text: String,
    chars: usize,
    limit: usize,
    overflow: bool,
}

impl Out {
    fn new(limit: usize) -> Self {
        Self {
            text: String::new(),
            chars: 0,
            limit,
            overflow: false,
        }
    }

    fn push(&mut self, text: &str) {
        for character in text.chars() {
            if self.chars == self.limit {
                self.overflow = true;
                return;
            }
            self.text.push(character);
            self.chars += 1;
        }
    }

    fn full(&self) -> bool {
        self.overflow
    }

    fn finish(mut self) -> String {
        if self.overflow {
            self.text.pop();
            self.text.push('…');
        }
        self.text
    }
}

fn render_expression(out: &mut Out, value: ExpressionValue<'_>) {
    match value {
        ExpressionValue::Data(value) => render_value(out, value),
        ExpressionValue::Auth(auth) => {
            out.push("{uid: ");
            match &auth.uid {
                Some(uid) => render_string(out, uid),
                None => out.push("null"),
            }
            out.push(if auth.token.is_empty() {
                ", token: {}}"
            } else {
                ", token: {…}}"
            });
        }
        ExpressionValue::Query(request) => render_query(out, request),
        ExpressionValue::Request(request) => render_request(out, request),
        ExpressionValue::Resource(resource) => {
            out.push("resource(");
            out.push(relative_path(&resource.name));
            out.push(")");
        }
        ExpressionValue::Set(values) => {
            out.push("set(");
            render_list(out, values);
            out.push(")");
        }
        ExpressionValue::MapDiff(difference) => render_diff(out, difference),
        ExpressionValue::Bytes(bytes) => render_bytes(out, bytes),
        ExpressionValue::Symbolic => out.push("…"),
        ExpressionValue::Error(error) => out.push(&error.message),
    }
}

/// `request.query`, as the map rules see.
fn render_query(out: &mut Out, request: &EvaluationRequest) {
    let query = &request.query;
    out.push("{limit: ");
    match query.limit {
        Some(limit) => out.push(&limit.to_string()),
        None => out.push("null"),
    }
    out.push(", offset: ");
    out.push(&query.offset.unwrap_or(0).to_string());
    out.push(", orderBy: {");
    for (index, (field, direction)) in query.order_by.iter().enumerate() {
        if out.full() {
            return;
        }
        if index > 0 {
            out.push(", ");
        }
        render_key(out, field);
        out.push(": ");
        render_string(out, direction);
    }
    out.push("}}");
}

/// `request` itself: the method and what it is about.
fn render_request(out: &mut Out, request: &EvaluationRequest) {
    out.push("request(");
    out.push(operation_name(request.operation));
    out.push(" ");
    match (&request.query.scope, request.operation) {
        (Some(QueryScope::Collection(path)), RequestOperation::List) => out.push(path),
        (
            Some(QueryScope::CollectionGroup {
                collection_id,
                ancestor,
            }),
            RequestOperation::List,
        ) => {
            out.push("group ");
            out.push(collection_id);
            if let Some(ancestor) = ancestor {
                out.push(" under ");
                out.push(ancestor);
            }
        }
        _ => out.push(relative_path(&request.path)),
    }
    out.push(")");
}

/// A map difference by what changed: `diff(added: […], removed: […], changed: […])`.
fn render_diff(out: &mut Out, difference: crate::MapDifference<'_>) {
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    for (key, status) in difference.keys() {
        match status {
            MapKeyStatus::OnlyLeft => added.push(key),
            MapKeyStatus::OnlyRight => removed.push(key),
            MapKeyStatus::Different => changed.push(key),
            MapKeyStatus::Equal => {}
        }
    }
    out.push("diff(");
    for (index, (label, keys)) in [
        ("added", &added),
        ("removed", &removed),
        ("changed", &changed),
    ]
    .into_iter()
    .enumerate()
    {
        if index > 0 {
            out.push(", ");
        }
        out.push(label);
        out.push(": [");
        for (position, key) in keys.iter().enumerate() {
            if out.full() {
                return;
            }
            if position > 0 {
                out.push(", ");
            }
            render_string(out, key);
        }
        out.push("]");
    }
    out.push(")");
}

fn render_value(out: &mut Out, value: &Value) {
    if out.full() {
        return;
    }
    match value {
        Value::Null => out.push("null"),
        Value::Bool(value) => out.push(if *value { "true" } else { "false" }),
        Value::Integer(value) => out.push(&value.to_string()),
        Value::Float(value) => out.push(&float_text(*value)),
        Value::String(value) => render_string(out, value),
        Value::List(values) => render_list(out, values),
        Value::Map(map) => {
            out.push("{");
            for (index, (key, value)) in map.iter().enumerate() {
                if out.full() {
                    return;
                }
                if index > 0 {
                    out.push(", ");
                }
                render_key(out, key);
                out.push(": ");
                render_value(out, value);
            }
            out.push("}");
        }
        Value::Timestamp(timestamp) => {
            match timestamp
                .to_offset_date_time()
                .ok()
                .and_then(|time| time.format(&Rfc3339).ok())
            {
                Some(text) => out.push(&text),
                None => out.push(&format!(
                    "timestamp({}, {})",
                    timestamp.seconds(),
                    timestamp.nanoseconds()
                )),
            }
        }
        Value::Duration(duration) => out.push(&duration_text(*duration)),
        Value::Path(path) => out.push(path_text(path)),
        Value::Bytes(bytes) => render_bytes(out, bytes),
        Value::LatLng(point) => out.push(&format!(
            "latlng({}, {})",
            float_text(point.latitude),
            float_text(point.longitude)
        )),
    }
}

fn render_list(out: &mut Out, values: &[Value]) {
    out.push("[");
    for (index, value) in values.iter().enumerate() {
        if out.full() {
            return;
        }
        if index > 0 {
            out.push(", ");
        }
        render_value(out, value);
    }
    out.push("]");
}

fn render_bytes(out: &mut Out, bytes: &[u8]) {
    out.push("bytes(");
    // Encode no more than can be shown.
    let shown = &bytes[..bytes.len().min(MAXIMUM_VALUE_CHARS)];
    out.push(&BASE64_STANDARD.encode(shown));
    out.push(")");
}

fn render_string(out: &mut Out, value: &str) {
    out.push("\"");
    let mut escaped = [0_u8; 4];
    for character in value.chars() {
        if out.full() {
            return;
        }
        match character {
            '"' => out.push("\\\""),
            '\\' => out.push("\\\\"),
            '\n' => out.push("\\n"),
            '\r' => out.push("\\r"),
            '\t' => out.push("\\t"),
            character if character.is_control() => {
                out.push(&format!("\\u{:04x}", u32::from(character)));
            }
            character => out.push(character.encode_utf8(&mut escaped)),
        }
    }
    out.push("\"");
}

/// A map key bare when it reads as an identifier, quoted otherwise.
fn render_key(out: &mut Out, key: &str) {
    if is_identifier(key) {
        out.push(key);
    } else {
        render_string(out, key);
    }
}

fn render_constraints(out: &mut Out, constraints: &[&FieldConstraint]) {
    for (index, constraint) in constraints.iter().enumerate() {
        if out.full() {
            return;
        }
        if index > 0 {
            out.push(", ");
        }
        out.push(&field_path(&constraint.field));
        out.push(" ");
        out.push(operator_symbol(constraint.operator));
        out.push(" ");
        render_value(out, &constraint.value);
    }
}

fn is_identifier(text: &str) -> bool {
    let mut characters = text.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// A field path as a query spells it: dotted, with backticks around any
/// segment that is not a plain identifier.
fn field_path(field: &[String]) -> String {
    field
        .iter()
        .map(|segment| {
            if is_identifier(segment) {
                segment.clone()
            } else {
                format!("`{}`", segment.replace('\\', "\\\\").replace('`', "\\`"))
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}

/// The query operator that proves a constraint, as the client SDKs spell it.
fn operator_symbol(operator: ConstraintOperator) -> &'static str {
    match operator {
        ConstraintOperator::Equal => "==",
        ConstraintOperator::NotEqual => "!=",
        ConstraintOperator::Less => "<",
        ConstraintOperator::LessEqual => "<=",
        ConstraintOperator::Greater => ">",
        ConstraintOperator::GreaterEqual => ">=",
        ConstraintOperator::In => "in",
        ConstraintOperator::NotIn => "not-in",
        ConstraintOperator::ArrayContains => "array-contains",
        ConstraintOperator::ArrayContainsAny => "array-contains-any",
    }
}

fn operation_name(operation: RequestOperation) -> &'static str {
    match operation {
        RequestOperation::Get => "get",
        RequestOperation::List => "list",
        RequestOperation::Create => "create",
        RequestOperation::Update => "update",
        RequestOperation::Delete => "delete",
    }
}

/// `1.0` stays distinguishable from the integer `1`.
fn float_text(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned()
    } else {
        format!("{value:?}")
    }
}

fn duration_text(duration: RulesDuration) -> String {
    let total = duration.total_nanoseconds();
    let sign = if total < 0 { "-" } else { "" };
    let magnitude = total.unsigned_abs();
    let seconds = magnitude / 1_000_000_000;
    let nanoseconds = magnitude % 1_000_000_000;
    if nanoseconds == 0 {
        format!("{sign}{seconds}s")
    } else {
        let fraction = format!("{nanoseconds:09}");
        format!("{sign}{seconds}.{}s", fraction.trim_end_matches('0'))
    }
}

/// A document path as rules write it: `/databases/(default)/documents/…`,
/// whichever project the stored reference names.
fn path_text(path: &str) -> &str {
    if path.starts_with("projects/")
        && let Some(index) = path.find("/databases/")
    {
        return &path[index..];
    }
    path
}

/// The part of a document name below `/documents/`, `users/u1`.
fn relative_path(name: &str) -> &str {
    name.find("/documents/")
        .map_or(name, |index| &name[index + "/documents/".len()..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Auth, Timestamp, compile};

    fn rendered(value: &Value) -> String {
        let mut out = Out::new(MAXIMUM_VALUE_CHARS);
        render_value(&mut out, value);
        out.finish()
    }

    #[test]
    fn values_render_in_the_rules_notation() {
        let map = Value::Map(BTreeMap::from([
            ("plan".to_owned(), Value::from("pro")),
            ("seats".to_owned(), Value::Integer(11)),
            ("two words".to_owned(), Value::Null),
        ]));
        assert_eq!(
            rendered(&map),
            "{plan: \"pro\", seats: 11, \"two words\": null}"
        );
        assert_eq!(
            rendered(&Value::List(vec![Value::Integer(1), Value::Float(2.0)])),
            "[1, 2.0]"
        );
        assert_eq!(
            rendered(&Value::from("say \"hi\"\n")),
            "\"say \\\"hi\\\"\\n\""
        );
        assert_eq!(
            rendered(&Value::Timestamp(Timestamp::new(1_760_000_000, 5_000_000))),
            "2025-10-09T08:53:20.005Z"
        );
        assert_eq!(
            rendered(&Value::Path(
                "projects/demo/databases/(default)/documents/users/u1".to_owned()
            )),
            "/databases/(default)/documents/users/u1"
        );
        assert_eq!(
            rendered(&Value::Duration(RulesDuration::from_nanoseconds(
                -1_500_000_000
            ))),
            "-1.5s"
        );
        assert_eq!(rendered(&Value::Float(f64::NAN)), "NaN");
    }

    #[test]
    fn long_values_end_in_an_ellipsis_at_the_limit() {
        let long = Value::List((0..500).map(Value::Integer).collect());
        let text = rendered(&long);
        assert_eq!(text.chars().count(), MAXIMUM_VALUE_CHARS);
        assert!(text.ends_with('…'), "{text}");
        let exact = Value::from("x".repeat(MAXIMUM_VALUE_CHARS - 2).as_str());
        assert_eq!(rendered(&exact).chars().count(), MAXIMUM_VALUE_CHARS);
        assert!(!rendered(&exact).ends_with('…'));
    }

    #[test]
    fn auth_shows_the_uid_and_hides_the_claims() {
        let mut out = Out::new(MAXIMUM_VALUE_CHARS);
        let auth = Auth {
            uid: Some("u1".to_owned()),
            token: BTreeMap::from([("admin".to_owned(), Value::Bool(true))]),
        };
        render_expression(&mut out, ExpressionValue::Auth(&auth));
        assert_eq!(out.finish(), "{uid: \"u1\", token: {…}}");
    }

    #[test]
    fn positions_count_utf16_code_units() {
        let source = "// é😀\nmatch";
        let ruleset_source: Arc<str> = Arc::from(source);
        let index = SourceIndex::new(ruleset_source);
        let start = source.find("match").expect("present");
        let span = index.span(start, start + "match".len());
        // `// é😀\n` is 9 bytes but 7 UTF-16 code units (😀 is a pair).
        assert_eq!(start, 10);
        assert_eq!(
            span,
            SourceSpan {
                line: 2,
                from: 7,
                to: 12
            }
        );
    }

    #[test]
    fn every_allow_condition_is_indexed() {
        let rules = compile(
            "rules_version = '2'; service cloud.firestore { match /databases/{d}/documents { match /a/{x} { allow read; allow write: if false; match /b/{y} { allow get: if x == y; } } } }",
        )
        .expect("compiles");
        let explainer = rules.explainer();
        assert_eq!(explainer.conditions.len(), 3);
        assert_eq!(explainer.condition_keys.len(), 3);
    }
}
