//! How deep one rules expression may nest.
//!
//! Production's Rules compiler refuses an expression in which a node sits
//! [`REFUSED_LEVEL`] levels down, the expression's root being level 1: one
//! issue per such node, at its start, in source order, and nothing for the
//! nodes below one it names (`rules-v2/expression-size`, and
//! `linear-expression-terms-100` of `production-limit-probes.json`).
//!
//! What the recordings determine: a binary operator is one level; so is each
//! grouping bracket, named at its `(`; a chain of fields down to a variable,
//! such as `request.auth.token.n`, is one node, named where it starts; a
//! literal, `true` or a variable is one level.
//!
//! Firenook's choice where nothing is recorded: a unary operator, an index, a
//! slice, a call or a method call, a list, a map, a path, `is` and the
//! conditional are one level each, like a binary operator, with their
//! operands one level down (a method's receiver and arguments, a function's
//! arguments but not its name, a path's interpolations). A field chain over a
//! base that is not a variable (a call, an index, a bracket) is one node whose
//! base is one level down. Every expression root is checked: allow
//! conditions, function `return` values and `let` values, although only
//! allow conditions are recorded.
//!
//! The parser keeps no node for a grouping: the grouped expression's span
//! starts at its `(` instead (`prefix` in `parser.rs`). A node's brackets are
//! therefore the `(` tokens, with whitespace and comments between them, from
//! its span's start to its own first token, or to its first child's start.
//!
//! The check runs once, at compile, so evaluation pays nothing for it, and
//! its walk stops at [`REFUSED_LEVEL`], so it cannot exhaust the stack.

use std::collections::BTreeMap;

use crate::ast::{Expr, ExprKind, Function, MatchBlock, PathPart, Program};
use crate::{Diagnostic, DiagnosticSeverity};

/// The level at which production refuses a node, the expression's root being
/// level 1: 99 terms of `a >= 1` joined by `&&` are refused, 98 compile;
/// 100 `true` terms are refused, 99 compile.
pub(crate) const REFUSED_LEVEL: usize = 100;

/// Production's description of each node it refuses.
pub(crate) const TOO_COMPLEX: &str = "Expression is too complex to evaluate safely.";

/// Appends one diagnostic for each node of `program`'s expressions that sits
/// [`REFUSED_LEVEL`] levels down, in source order.
pub(crate) fn check(source: &str, program: &Program, diagnostics: &mut Vec<Diagnostic>) {
    let mut walk = Walk {
        source,
        refused: Vec::new(),
    };
    walk.functions(&program.functions);
    for block in &program.matches {
        walk.block(block);
    }
    walk.refused.sort_unstable();
    // Positioned in one pass: a large list one level short of the limit can
    // name a node per element, and positioning each from the source's start
    // would be quadratic in the source.
    let mut position = Position::default();
    for offset in walk.refused {
        position.advance(source, offset);
        diagnostics.push(Diagnostic {
            severity: DiagnosticSeverity::Error,
            message: TOO_COMPLEX.to_owned(),
            line: position.line,
            column: position.column,
            byte_offset: position.offset,
            from: position.utf16,
            to: position.utf16,
            code: None,
        });
    }
}

struct Walk<'a> {
    source: &'a str,
    /// Byte offsets of the refused nodes and brackets.
    refused: Vec<usize>,
}

impl Walk<'_> {
    fn functions(&mut self, functions: &BTreeMap<String, Function>) {
        for function in functions.values() {
            for (_, value) in &function.lets {
                self.node(value, 1);
            }
            self.node(&function.result, 1);
        }
    }

    fn block(&mut self, block: &MatchBlock) {
        self.functions(&block.functions);
        for allow in &block.allows {
            self.node(&allow.condition, 1);
        }
        for child in &block.children {
            self.block(child);
        }
    }

    /// Walks `expression`, whose outermost bracket, or the node itself when
    /// it has none, sits at `level`.
    fn node(&mut self, expression: &Expr, mut level: usize) {
        let inner = first_child(expression).map_or(expression.span.end, |child| child.span.start);
        let mut at = expression.span.start;
        while at < inner && self.source.as_bytes().get(at) == Some(&b'(') {
            if level == REFUSED_LEVEL {
                self.refused.push(at);
                return;
            }
            level += 1;
            at = skip_trivia(self.source, at + 1, inner);
        }
        if level == REFUSED_LEVEL {
            self.refused.push(at);
            return;
        }
        let below = level + 1;
        match &expression.kind {
            ExprKind::Field { base, .. } => {
                let mut base = &**base;
                while let ExprKind::Field { base: next, .. } = &base.kind
                    && !self.grouped(base)
                {
                    base = &**next;
                }
                if !matches!(base.kind, ExprKind::Variable(_)) || self.grouped(base) {
                    self.node(base, below);
                }
            }
            ExprKind::Call { callee, arguments } => {
                match &callee.kind {
                    ExprKind::Variable(_) if !self.grouped(callee) => {}
                    ExprKind::Field { base, .. } if !self.grouped(callee) => {
                        self.node(base, below);
                    }
                    _ => self.node(callee, below),
                }
                for argument in arguments {
                    self.node(argument, below);
                }
            }
            ExprKind::Index { base, index } => {
                self.node(base, below);
                self.node(index, below);
            }
            ExprKind::Slice { base, start, end } => {
                self.node(base, below);
                for bound in [start, end].into_iter().flatten() {
                    self.node(bound, below);
                }
            }
            ExprKind::Unary { operand, .. } => self.node(operand, below),
            ExprKind::Binary { left, right, .. } => {
                self.node(left, below);
                self.node(right, below);
            }
            ExprKind::Is { value, .. } => self.node(value, below),
            ExprKind::Conditional {
                condition,
                then,
                otherwise,
            } => {
                self.node(condition, below);
                self.node(then, below);
                self.node(otherwise, below);
            }
            ExprKind::List(values) => {
                for value in values {
                    self.node(value, below);
                }
            }
            ExprKind::Map(entries) => {
                for (_, value) in entries {
                    self.node(value, below);
                }
            }
            ExprKind::Path(parts) => {
                for part in parts {
                    if let PathPart::Interpolation(value) = part {
                        self.node(value, below);
                    }
                }
            }
            ExprKind::Null
            | ExprKind::Bool(_)
            | ExprKind::Integer(_)
            | ExprKind::Float(_)
            | ExprKind::String(_)
            | ExprKind::Variable(_) => {}
        }
    }

    /// Whether `expression` is written in brackets.
    fn grouped(&self, expression: &Expr) -> bool {
        match first_child(expression) {
            // Without a bracket an operator's span starts where its first
            // operand's does.
            Some(child) => expression.span.start < child.span.start,
            // A node that starts with its own token never starts with `(`.
            None => {
                !expression.span.is_empty()
                    && self.source.as_bytes().get(expression.span.start) == Some(&b'(')
            }
        }
    }
}

/// The child an operator's source starts with; `None` for a node that starts
/// with its own token.
fn first_child(expression: &Expr) -> Option<&Expr> {
    match &expression.kind {
        ExprKind::Field { base, .. }
        | ExprKind::Index { base, .. }
        | ExprKind::Slice { base, .. } => Some(base),
        ExprKind::Call { callee, .. } => Some(callee),
        ExprKind::Binary { left, .. } => Some(left),
        ExprKind::Is { value, .. } => Some(value),
        ExprKind::Conditional { condition, .. } => Some(condition),
        ExprKind::Null
        | ExprKind::Bool(_)
        | ExprKind::Integer(_)
        | ExprKind::Float(_)
        | ExprKind::String(_)
        | ExprKind::List(_)
        | ExprKind::Map(_)
        | ExprKind::Path(_)
        | ExprKind::Variable(_)
        | ExprKind::Unary { .. } => None,
    }
}

/// The first offset from `at` that is not whitespace or a comment, as the
/// lexer skips them, and at most `limit`.
fn skip_trivia(source: &str, mut at: usize, limit: usize) -> usize {
    while let Some(rest) = source.get(at..limit) {
        let text = rest.trim_start();
        at = limit - text.len();
        if let Some(comment) = text.strip_prefix("//") {
            at += 2 + comment.find('\n').unwrap_or(comment.len());
        } else if let Some(comment) = text.strip_prefix("/*") {
            at += 2 + comment.find("*/").map_or(comment.len(), |end| end + 2);
        } else {
            break;
        }
    }
    at.min(limit)
}

/// A line, column and UTF-16 offset, as [`crate::compile`]'s diagnostics
/// give them, moved forward through ascending offsets.
struct Position {
    offset: usize,
    line: usize,
    column: usize,
    utf16: usize,
}

impl Default for Position {
    fn default() -> Self {
        Self {
            offset: 0,
            line: 1,
            column: 1,
            utf16: 0,
        }
    }
}

impl Position {
    fn advance(&mut self, source: &str, offset: usize) {
        let offset = source.floor_char_boundary(offset.min(source.len()));
        for character in source.get(self.offset..offset).unwrap_or_default().chars() {
            if character == '\n' {
                self.line += 1;
                self.column = 1;
            } else {
                self.column += 1;
            }
            self.utf16 += character.len_utf16();
        }
        self.offset = self.offset.max(offset);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::TOO_COMPLEX;
    use crate::{
        Auth, CoverageObserver, EmptyDocumentAccess, EvaluationRequest, ExpressionKey,
        ExpressionValue, RequestOperation, Timestamp, Value, compile,
    };

    /// `condition` as the only allow of a ruleset, on line 5 from column 21,
    /// as `conformance/src/rules/capture-expression-size-probes.ts` sends it.
    fn probe(condition: &str) -> String {
        format!(
            "rules_version = '2';\nservice cloud.firestore {{\n  match /databases/{{database}}/documents {{\n    match /phase3/{{document}} {{\n      allow get: if {condition};\n    }}\n  }}\n}}\n"
        )
    }

    fn token_term(index: usize) -> String {
        format!("request.auth.token.n >= {index}")
    }

    fn chain(terms: usize, term: impl Fn(usize) -> String) -> String {
        (0..terms).map(term).collect::<Vec<_>>().join(" && ")
    }

    fn right_nested(terms: usize) -> String {
        let mut expression = token_term(terms - 1);
        for index in (0..terms - 1).rev() {
            expression = format!("{} && ({expression})", token_term(index));
        }
        expression
    }

    /// The `line:column` of each refusal, or `None` when `source` compiles.
    fn refused(source: &str) -> Option<Vec<String>> {
        let diagnostics = compile(source).err()?;
        Some(
            diagnostics
                .into_iter()
                .map(|diagnostic| {
                    assert_eq!(diagnostic.message, TOO_COMPLEX);
                    format!("{}:{}", diagnostic.line, diagnostic.column)
                })
                .collect(),
        )
    }

    /// The source text of each refusal, from where it is named to the end
    /// of `condition`, cut to `width` characters.
    fn refused_at(condition: &str, width: usize) -> Option<Vec<String>> {
        let source = probe(condition);
        let diagnostics = compile(&source).err()?;
        Some(
            diagnostics
                .into_iter()
                .map(|diagnostic| {
                    assert_eq!(diagnostic.message, TOO_COMPLEX);
                    source[diagnostic.byte_offset..]
                        .chars()
                        .take(width)
                        .collect()
                })
                .collect(),
        )
    }

    #[test]
    fn refuses_where_production_refuses_a_chain_and_names_each_node_100_levels_down() {
        assert_eq!(refused(&probe(&chain(98, token_term))), None);
        assert_eq!(
            refused(&probe(&chain(99, token_term))).unwrap(),
            ["5:21", "5:45", "5:50", "5:74"]
        );
        assert_eq!(refused(&probe(&chain(99, |_| "true".to_owned()))), None);
        assert_eq!(
            refused(&probe(&chain(100, |_| "true".to_owned()))).unwrap(),
            ["5:21", "5:29"]
        );
        // Nothing below a named node is named again.
        assert_eq!(
            refused(&probe(&chain(200, |_| "true".to_owned()))).unwrap(),
            ["5:21", "5:829"]
        );
        assert_eq!(refused(&probe(&right_nested(49))), None);
        assert_eq!(
            refused(&probe(&right_nested(50))).unwrap(),
            ["5:1530", "5:1554"]
        );
        // The bracket 100 levels down is named at its `(`.
        assert_eq!(
            refused(&probe(&right_nested(60))).unwrap(),
            ["5:1530", "5:1560"]
        );
    }

    #[test]
    fn counts_each_bracket_whatever_whitespace_or_comment_is_between() {
        // 97 `true` terms and the `&&` above them reach level 97; the first
        // term in two brackets puts `true` at level 99, in three at 100.
        let terms = |brackets: &str, closing: &str| {
            format!(
                "{brackets}true{closing} && {}",
                chain(96, |_| "true".to_owned())
            )
        };
        assert_eq!(refused_at(&terms("((", "))"), 1), None);
        assert_eq!(
            refused_at(&terms("( /* a */ (\n // b\n (", ")))"), 4).unwrap(),
            ["true"]
        );
        // With a fourth, that bracket itself sits at level 100.
        assert_eq!(refused_at(&terms("(( (\t(", "))))"), 2).unwrap(), ["(t"]);
    }

    #[test]
    fn a_field_chain_is_one_node_and_its_base_one_level_down_unless_a_variable() {
        // 98 `&&` levels over terms at 99: a chain over a variable is one
        // node there; over a call, an index or a bracket, its base is one
        // level further down, at 100.
        let source = |term: &str| format!("{term} && {}", chain(98, |_| "true".to_owned()));
        assert_eq!(refused_at(&source("request.auth.token.n.a.b.c"), 1), None);
        assert_eq!(
            refused_at(&source("request.path.split('/').size"), 13).unwrap(),
            ["request.path."]
        );
        assert_eq!(
            refused_at(&source("request.auth.token['n'].x"), 7).unwrap(),
            ["request"]
        );
        assert_eq!(
            refused_at(&source("(request.auth).token"), 2).unwrap(),
            ["(r"]
        );
    }

    #[test]
    fn every_other_node_kind_is_one_level_over_its_operands() {
        // Firenook's choice, unrecorded. A term at level 98 puts its operands
        // at 99, and theirs at 100: (term, characters shown, what is named).
        let cases: [(&str, usize, &[&str]); 11] = [
            ("!!true", 4, &["true"]),
            // A method call: its receiver and its arguments.
            ("[1].hasAny([2])", 1, &["1", "2"]),
            ("request.auth.token.keys().hasAll([])", 7, &["request"]),
            // A function call: its arguments, not its name.
            ("f(f(1))", 1, &["1"]),
            ("[1][2 + 3]", 1, &["1", "2", "3"]),
            ("'abc'[0:1 + 2]", 1, &["1", "2"]),
            ("{'a': {'b': 1}}", 1, &["1"]),
            ("-(-1)", 2, &["-1"]),
            ("(1 is int) is bool", 1, &["1"]),
            // In a bracket, which is level 98 itself.
            ("(true ? 1 : 2)", 1, &["t", "1", "2"]),
            ("/databases/$(database)/documents/a/$(-(1))", 1, &["("]),
        ];
        for (term, width, named) in cases {
            let source = format!(
                "rules_version = '2';\nservice cloud.firestore {{\n  function f(x) {{ return x; }}\n  match /databases/{{database}}/documents/c/{{id}} {{\n    allow get: if {term} && {};\n  }}\n}}\n",
                chain(97, |_| "true".to_owned())
            );
            let names = compile(&source)
                .expect_err(term)
                .into_iter()
                .map(|diagnostic| {
                    assert_eq!(diagnostic.message, TOO_COMPLEX);
                    source[diagnostic.byte_offset..]
                        .chars()
                        .take(width)
                        .collect::<String>()
                })
                .collect::<Vec<_>>();
            assert_eq!(names, named, "{term}");
        }
    }

    #[test]
    fn checks_function_returns_and_lets_and_names_every_root_in_source_order() {
        let deep = chain(100, |_| "true".to_owned());
        let source = format!(
            "rules_version = '2';\nservice cloud.firestore {{\n  function z() {{ let a = {deep}; return {deep}; }}\n  match /databases/{{database}}/documents/c/{{id}} {{\n    function a() {{ return {deep}; }}\n    allow get: if {deep};\n  }}\n}}\n"
        );
        let diagnostics = compile(&source).expect_err("four deep roots");
        assert_eq!(diagnostics.len(), 8, "{diagnostics:?}");
        let lines = diagnostics
            .iter()
            .map(|diagnostic| diagnostic.line)
            .collect::<Vec<_>>();
        assert_eq!(lines, [3, 3, 3, 3, 5, 5, 6, 6]);
        assert!(
            diagnostics
                .windows(2)
                .all(|pair| pair[0].byte_offset < pair[1].byte_offset)
        );
    }

    #[test]
    fn positions_each_refusal_as_any_other_diagnostic() {
        // A non-ASCII line before and a multi-line condition: one pass gives
        // what positioning each from the start gives.
        let source = format!(
            "// é🔥\n{}",
            probe(&chain(150, |index| if index % 7 == 0 {
                "true\n".to_owned()
            } else {
                "'é🔥' != ''".to_owned()
            }))
        );
        let diagnostics = compile(&source).expect_err("too deep");
        assert!(diagnostics.len() > 2, "{diagnostics:?}");
        for diagnostic in diagnostics {
            let expected =
                crate::diagnostic(&source, diagnostic.byte_offset, TOO_COMPLEX.to_owned());
            assert_eq!(diagnostic, expected);
        }
    }

    #[test]
    fn names_every_element_of_a_list_one_level_short() {
        // Every element of a list at level 99 is 100 levels down; 40,000 of
        // them are positioned in one pass over the source.
        let list = format!("[{}[1]]", "[1],".repeat(39_999));
        let condition = format!("{list} != [] && {}", chain(97, |_| "true".to_owned()));
        let diagnostics = compile(&probe(&condition)).expect_err("too deep");
        assert_eq!(diagnostics.len(), 40_000);
        assert_eq!(diagnostics[1].column - diagnostics[0].column, 4);
    }

    #[derive(Default)]
    struct Count(usize);
    impl CoverageObserver for Count {
        fn observe(&mut self, _: ExpressionKey, _: ExpressionValue<'_>) {
            self.0 += 1;
        }
    }

    /// The deepest expressions the limit lets through evaluate in a debug
    /// build on a thread of the default 2 MiB a test or a Tokio worker gets.
    #[test]
    fn the_deepest_allowed_expressions_evaluate_on_a_2_mib_stack() {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(|| {
                // 98 `>=` terms, 99 `true` terms, 49 terms nested to the right.
                for condition in [
                    chain(98, token_term),
                    chain(99, |_| "true".to_owned()),
                    right_nested(49),
                ] {
                    let rules = compile(&probe(&condition)).expect("within the limit");
                    let mut request = EvaluationRequest::new(
                        RequestOperation::Get,
                        "/databases/(default)/documents/phase3/limit-probe",
                        Timestamp::new(1, 0),
                    );
                    request.auth = Some(Auth {
                        uid: Some("limit-probe".to_owned()),
                        token: BTreeMap::from([("n".to_owned(), Value::Integer(10_000))]),
                    });
                    let result = rules.evaluate(&request, &EmptyDocumentAccess);
                    assert!(result.allowed, "{result:?}");
                    assert_eq!(
                        rules.evaluate_with_trace(&request, &EmptyDocumentAccess).0,
                        result
                    );
                    let mut count = Count::default();
                    assert_eq!(
                        rules
                            .evaluate_with_coverage(&request, &EmptyDocumentAccess, &mut count)
                            .0,
                        result
                    );
                    assert_eq!(
                        rules.explainer().evaluate(&request, &EmptyDocumentAccess).0,
                        result
                    );
                    let _ = rules.coverage_layout();
                }
            })
            .expect("a test thread")
            .join()
            .expect("no stack overflow");
    }

    /// A ruleset of 21 functions, each calling the next from the deepest
    /// point of an expression at the limit, in one of two shapes: a chain of
    /// 98 `&&` terms, and a function's argument nested in another's 96 times
    /// (the hungriest shape measured).
    fn deepest_call_chain(shape: &str) -> String {
        use std::fmt::Write as _;

        let functions = (0..21).fold(String::new(), |mut text, index| {
            let inner = if index == 20 {
                "true".to_owned()
            } else {
                format!("f{}()", index + 1)
            };
            let body = if shape == "chain" {
                format!("{inner} && {}", chain(97, |term| token_term(term + 1)))
            } else {
                let mut nested = inner;
                for _ in 0..96 {
                    nested = format!("string({nested})");
                }
                format!("{nested} == 'x'")
            };
            writeln!(text, "  function f{index}() {{ return {body}; }}")
                .expect("a String takes any text");
            text
        });
        format!(
            "rules_version = '2';\nservice cloud.firestore {{\n{functions}  match /databases/{{database}}/documents/phase3/limit-probe {{\n    allow get: if f0();\n  }}\n}}\n"
        )
    }

    /// Both limits allow 21 calls each nesting an expression 99 levels deep;
    /// evaluating that on Tokio's 2 MiB aborted the engine (#228). On
    /// `EVALUATION_STACK_BYTES`, every way of evaluating it ends.
    #[test]
    fn the_deepest_call_chains_evaluate_on_the_evaluation_stack() {
        std::thread::Builder::new()
            .stack_size(crate::EVALUATION_STACK_BYTES)
            .spawn(|| {
                for shape in ["chain", "calls"] {
                    let rules = compile(&deepest_call_chain(shape)).expect("within both limits");
                    let mut request = EvaluationRequest::new(
                        RequestOperation::Get,
                        "/databases/(default)/documents/phase3/limit-probe",
                        Timestamp::new(1, 0),
                    );
                    request.auth = Some(Auth {
                        uid: Some("limit-probe".to_owned()),
                        token: BTreeMap::from([("n".to_owned(), Value::Integer(10_000))]),
                    });
                    let result = rules.evaluate(&request, &EmptyDocumentAccess);
                    assert_eq!(
                        rules.evaluate_with_trace(&request, &EmptyDocumentAccess).0,
                        result,
                        "{shape}"
                    );
                    let mut count = Count::default();
                    assert_eq!(
                        rules
                            .evaluate_with_coverage(&request, &EmptyDocumentAccess, &mut count)
                            .0,
                        result,
                        "{shape}"
                    );
                    assert_eq!(
                        rules.explainer().evaluate(&request, &EmptyDocumentAccess).0,
                        result,
                        "{shape}"
                    );
                }
            })
            .expect("a test thread")
            .join()
            .expect("no stack overflow");
    }

    /// `compile` on a 2 MiB thread, as a test or a Tokio worker has: each
    /// diagnostic's line, column and message.
    fn compile_on_2_mib(source: String) -> Result<(), Vec<(usize, usize, String)>> {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                compile(&source).map(|_| ()).map_err(|diagnostics| {
                    diagnostics
                        .into_iter()
                        .map(|diagnostic| (diagnostic.line, diagnostic.column, diagnostic.message))
                        .collect()
                })
            })
            .expect("a test thread")
            .join()
            .expect("no stack overflow")
    }

    /// Thousands of nested brackets overflowed the parser before anything
    /// could refuse them (#231). Past the parser's bound every nesting shape
    /// is refused as the depth check refuses it when it can walk the source:
    /// once, where its 100th level starts.
    #[test]
    fn nesting_past_the_parsers_bound_is_refused_as_the_depth_check_refuses_it() {
        type Shape = fn(usize) -> String;
        let shapes: [(&str, Shape, usize); 5] = [
            (
                "brackets",
                |n| format!("{}true{}", "(".repeat(n), ")".repeat(n)),
                100_000,
            ),
            ("unary", |n| format!("{}true", "!".repeat(n)), 200_000),
            (
                "lists",
                |n| format!("{}1{}", "[".repeat(n), "]".repeat(n)),
                100_000,
            ),
            (
                "maps",
                |n| format!("{}1{}", "{'a': ".repeat(n), "}".repeat(n)),
                30_000,
            ),
            (
                "calls",
                |n| format!("{}true{}", "string(".repeat(n), ")".repeat(n)),
                30_000,
            ),
        ];
        for (name, shape, deepest) in shapes {
            // Just under the bound (each shape is one level deeper than its
            // openers) the parser takes it all and the depth check refuses it;
            // at the bound and far past it, the parser stops.
            let walked = compile_on_2_mib(probe(&shape(239))).expect_err(name);
            assert_eq!(walked.len(), 1, "{name}");
            assert_eq!(walked[0].2, TOO_COMPLEX, "{name}");
            for depth in [240, deepest] {
                assert_eq!(
                    compile_on_2_mib(probe(&shape(depth))).expect_err(name),
                    walked,
                    "{name} {depth}"
                );
            }
        }
    }

    /// Match blocks nest 128 deep; the 129th is refused where it starts, and
    /// thousands no longer overflow the parser (#231).
    #[test]
    fn match_blocks_nest_128_deep() {
        let nested = |n: usize| {
            format!(
                "rules_version = '2';\nservice cloud.firestore {{\n  match /databases/{{database}}/documents {{\n{}allow get: if true;\n{}  }}\n}}\n",
                "match /a {\n".repeat(n),
                "}\n".repeat(n)
            )
        };
        assert_eq!(compile_on_2_mib(nested(127)), Ok(()));
        let refused = vec![(
            131,
            1,
            "match blocks are nested more than 128 deep".to_owned(),
        )];
        assert_eq!(compile_on_2_mib(nested(128)), Err(refused.clone()));
        assert_eq!(compile_on_2_mib(nested(20_000)), Err(refused));
    }
}
