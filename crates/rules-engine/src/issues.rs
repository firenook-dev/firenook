//! The official compiler's warnings: what the official emulator answers as
//! `issues` with a rules reload that compiles, and beside the errors of one
//! that does not (developer-tools-compile-errors-v1
//! top/service-name-misspelled, conditions/method-unknown,
//! production/duplicate-let).
//!
//! The official compiler checks more than this: it infers types, and warns
//! of names it does not define and of functions nothing calls. Firenook
//! gives the warnings the recordings show, each by the rule they and the
//! official emulator follow:
//!
//! - a service other than `cloud.firestore` or `firebase.storage` is not
//!   one, and its rules govern nothing;
//! - a method other than `get`, `list`, `read`, `create`, `update`,
//!   `delete` and `write`, or any method of a service that is not one, is
//!   not one, and grants nothing;
//! - `request` and `resource` are defined only where an allow names a
//!   method that is one: in its condition and in the functions it calls,
//!   which are checked once whoever calls them, and where a parameter, let
//!   or wildcard of that name does not hide them;
//! - a parameter or let that nothing reads, before another of its name
//!   hides it, is unused.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use crate::ast::{Expr, ExprKind, Function, MatchBlock, PathPart, PatternSegment, Program};

/// The services the official compiler knows.
const SERVICES: [&str; 2] = ["cloud.firestore", "firebase.storage"];
/// The methods an allow may name.
const METHODS: [&str; 7] = ["get", "list", "read", "create", "update", "delete", "write"];
/// What a service defines for an allow that names one of its methods.
const SERVICE_VARIABLES: [&str; 2] = ["request", "resource"];

/// Whether the official compiler knows the program's service.
pub(crate) fn service_is_known(program: &Program) -> bool {
    SERVICES.contains(&program.service_name.0.as_str())
}

/// The program's warnings, each with the half-open UTF-8 span it is about,
/// in source order.
pub(crate) fn warnings(program: &Program) -> Vec<(Range<usize>, String)> {
    let mut warnings = Vec::new();
    let known = service_is_known(program);
    if !known {
        let (name, span) = &program.service_name;
        warnings.push((span.clone(), format!("Invalid service name: {name}.")));
    }
    let mut checker = Checker {
        known,
        functions: vec![visible(&program.functions)],
        wildcards: Vec::new(),
        reached: BTreeMap::new(),
        warnings: &mut warnings,
    };
    for block in &program.matches {
        checker.block(block);
    }
    let reached = std::mem::take(&mut checker.reached);
    for (function, defined) in reached.into_values() {
        if !defined {
            checker.function_body(function);
        }
    }
    let mut functions = program.functions.values().collect::<Vec<_>>();
    for block in &program.matches {
        collect_functions(block, &mut functions);
    }
    for function in functions {
        unused_variables(function, &mut warnings);
    }
    warnings.sort_by(|left, right| (left.0.start, &left.1).cmp(&(right.0.start, &right.1)));
    warnings.dedup();
    warnings
}

struct Checker<'p, 'w> {
    known: bool,
    /// The functions visible where the checker is, outermost first; an inner
    /// one hides an outer one of the same name, as in the evaluator.
    functions: Vec<BTreeMap<&'p str, &'p Function>>,
    /// The wildcards of the match blocks the checker is in.
    wildcards: Vec<&'p str>,
    /// Each function an allow calls, by where its name is, and whether one
    /// that defines the service's variables calls it.
    reached: BTreeMap<usize, (&'p Function, bool)>,
    warnings: &'w mut Vec<(Range<usize>, String)>,
}

impl<'p> Checker<'p, '_> {
    fn block(&mut self, block: &'p MatchBlock) {
        self.functions.push(visible(&block.functions));
        let wildcards = self.wildcards.len();
        for segment in &block.pattern {
            if let PatternSegment::Wildcard(name) | PatternSegment::RecursiveWildcard(name) =
                segment
            {
                self.wildcards.push(name);
            }
        }
        // What the allows call, by whether they define the service's
        // variables: every allow of a block resolves a name alike.
        let mut calls = [BTreeSet::new(), BTreeSet::new()];
        for allow in &block.allows {
            let mut defined = false;
            for (method, start) in &allow.methods {
                if self.known && METHODS.contains(&method.as_str()) {
                    defined = true;
                } else {
                    self.warnings.push((
                        *start..start + method.len(),
                        format!("Invalid method name: {method}."),
                    ));
                }
            }
            if !defined {
                let hidden = self.wildcards.clone();
                self.service_variables(&allow.condition, &hidden);
            }
            calls_in(&allow.condition, &mut calls[usize::from(defined)]);
        }
        let [undefined, defined] = calls;
        self.reach(defined, true);
        self.reach(undefined, false);
        for child in &block.children {
            self.block(child);
        }
        self.wildcards.truncate(wildcards);
        self.functions.pop();
    }

    /// The function `name` resolves to where the checker is.
    fn resolve(&self, name: &str) -> Option<&'p Function> {
        self.functions
            .iter()
            .rev()
            .find_map(|functions| functions.get(name).copied())
    }

    /// Marks the functions `calls` names, and those they call, as reached,
    /// as the evaluator resolves them from the allow being checked.
    fn reach(&mut self, mut calls: BTreeSet<&'p str>, defined: bool) {
        let mut visited = BTreeSet::new();
        while let Some(name) = calls.pop_first() {
            let Some(function) = self.resolve(name) else {
                continue;
            };
            if !visited.insert(function.name_start) {
                continue;
            }
            self.reached
                .entry(function.name_start)
                .and_modify(|(_, reached)| *reached |= defined)
                .or_insert((function, defined));
            for (_, value) in &function.lets {
                calls_in(value, &mut calls);
            }
            calls_in(&function.result, &mut calls);
        }
    }

    /// A function's body, where the service's variables are not defined.
    fn function_body(&mut self, function: &Function) {
        let mut hidden = function
            .scope
            .iter()
            .map(String::as_str)
            .chain(function.parameters.iter().map(String::as_str))
            .collect::<Vec<_>>();
        for (name, value) in &function.lets {
            self.service_variables(value, &hidden);
            hidden.push(name);
        }
        self.service_variables(&function.result, &hidden);
    }

    /// Warns of each of the service's variables `expression` reads that no
    /// name in `hidden` hides.
    fn service_variables(&mut self, expression: &Expr, hidden: &[&str]) {
        let mut read = Vec::new();
        variables_in(expression, &mut read);
        for (name, span) in read {
            if SERVICE_VARIABLES.contains(&name) && !hidden.contains(&name) {
                self.warnings
                    .push((span, format!("Invalid variable name: {name}.")));
            }
        }
    }
}

fn visible(functions: &BTreeMap<String, Function>) -> BTreeMap<&str, &Function> {
    functions
        .iter()
        .map(|(name, function)| (name.as_str(), function))
        .collect()
}

fn collect_functions<'p>(block: &'p MatchBlock, functions: &mut Vec<&'p Function>) {
    functions.extend(block.functions.values());
    for child in &block.children {
        collect_functions(child, functions);
    }
}

/// Warns of each parameter and let of `function` that nothing reads before
/// another of its name hides it (production/duplicate-let).
fn unused_variables(function: &Function, warnings: &mut Vec<(Range<usize>, String)>) {
    let read = |expression| {
        let mut read = Vec::new();
        variables_in(expression, &mut read);
        read.into_iter()
            .map(|(name, _)| name)
            .collect::<BTreeSet<_>>()
    };
    let lets = function
        .lets
        .iter()
        .map(|(name, value)| (name.as_str(), read(value)))
        .collect::<Vec<_>>();
    let result = read(&function.result);
    // Whether `name`, bound before the let at `from`, is read by a value
    // from there on before another binding of it, or by the result.
    let is_read = |name: &str, from: usize| {
        for (bound, values) in &lets[from..] {
            if values.contains(name) {
                return true;
            }
            if *bound == name {
                return false;
            }
        }
        result.contains(name)
    };
    let bindings = function
        .parameters
        .iter()
        .zip(&function.parameter_starts)
        .map(|(name, start)| (name, *start, 0))
        .chain(
            function
                .lets
                .iter()
                .zip(&function.let_starts)
                .enumerate()
                .map(|(index, ((name, _), start))| (name, *start, index + 1)),
        );
    for (name, start, from) in bindings {
        if !name.is_empty() && !is_read(name, from) {
            warnings.push((
                start..start + name.len(),
                format!("Unused variable: {name}."),
            ));
        }
    }
}

/// The names of the functions `expression` calls.
fn calls_in<'e>(expression: &'e Expr, calls: &mut BTreeSet<&'e str>) {
    each_part(expression, &mut |part| {
        if let ExprKind::Call { callee, .. } = &part.kind
            && let ExprKind::Variable(name) = &callee.kind
        {
            calls.insert(name);
        }
    });
}

/// The variables `expression` reads, and where each is: a name called as a
/// function is not one.
fn variables_in<'e>(expression: &'e Expr, read: &mut Vec<(&'e str, Range<usize>)>) {
    match &expression.kind {
        ExprKind::Variable(name) => read.push((name, expression.span.clone())),
        ExprKind::Call { callee, arguments } => {
            if !matches!(callee.kind, ExprKind::Variable(_)) {
                variables_in(callee, read);
            }
            for argument in arguments {
                variables_in(argument, read);
            }
        }
        _ => children(expression, &mut |child| variables_in(child, read)),
    }
}

/// Visits `expression` and every expression in it.
fn each_part<'e>(expression: &'e Expr, visit: &mut impl FnMut(&'e Expr)) {
    visit(expression);
    children(expression, &mut |child| each_part(child, visit));
}

/// The expressions directly in `expression`.
fn children<'e>(expression: &'e Expr, visit: &mut impl FnMut(&'e Expr)) {
    match &expression.kind {
        ExprKind::Null
        | ExprKind::Bool(_)
        | ExprKind::Integer(_)
        | ExprKind::Float(_)
        | ExprKind::String(_)
        | ExprKind::Variable(_) => {}
        ExprKind::List(values) => values.iter().for_each(visit),
        ExprKind::Map(entries) => entries.iter().for_each(|(_, value)| visit(value)),
        ExprKind::Path(parts) => {
            for part in parts {
                if let PathPart::Interpolation(value) = part {
                    visit(value);
                }
            }
        }
        ExprKind::Field { base, .. } | ExprKind::Is { value: base, .. } => visit(base),
        ExprKind::Index { base, index } => {
            visit(base);
            visit(index);
        }
        ExprKind::Slice { base, start, end } => {
            visit(base);
            if let Some(start) = start {
                visit(start);
            }
            if let Some(end) = end {
                visit(end);
            }
        }
        ExprKind::Call { callee, arguments } => {
            visit(callee);
            arguments.iter().for_each(visit);
        }
        ExprKind::Unary { operand, .. } => visit(operand),
        ExprKind::Binary { left, right, .. } => {
            visit(left);
            visit(right);
        }
        ExprKind::Conditional {
            condition,
            then,
            otherwise,
        } => {
            visit(condition);
            visit(then);
            visit(otherwise);
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{EmptyDocumentAccess, EvaluationRequest, RequestOperation, Timestamp, compile};

    fn rules(service: &str, body: &str) -> String {
        format!(
            "rules_version = '2';\nservice {service} {{\n  match /databases/{{database}}/documents {{\n{body}  }}\n}}\n"
        )
    }

    /// Each answer as `L<line>:<column> <message>`: the warnings of a source
    /// that compiles, or the refusal with its warnings in it.
    fn answered(source: &str) -> Vec<String> {
        let shown = |diagnostics: &[crate::Diagnostic]| {
            diagnostics
                .iter()
                .map(|diagnostic| {
                    format!(
                        "L{}:{} {}",
                        diagnostic.line, diagnostic.column, diagnostic.message
                    )
                })
                .collect()
        };
        match compile(source) {
            Ok(rules) => shown(rules.issues()),
            Err(refused) => shown(&refused),
        }
    }

    /// `request` and `resource` are defined where an allow names a method
    /// that is one, and in what it calls; a parameter, let or wildcard of
    /// that name hides them.
    #[test]
    fn warns_of_request_and_resource_where_no_allow_defines_them() {
        let cases: [(String, &[&str]); 4] = [
            (
                rules(
                    "cloud.firestore",
                    "    function f() { return request.auth != null; }\n    match /a/{b} {\n      allow read: if f();\n      allow reads: if f();\n    }\n",
                ),
                &["L7:13 Invalid method name: reads."],
            ),
            (
                rules(
                    "cloud.firestore",
                    "    function g() { return request.auth != null; }\n    function f() { return g(); }\n    match /a/{b} {\n      allow reads: if f();\n    }\n",
                ),
                &[
                    "L4:27 Invalid variable name: request.",
                    "L7:13 Invalid method name: reads.",
                ],
            ),
            (
                rules(
                    "cloud.firestore",
                    "    match /a/{b} {\n      allow read, reads: if request.auth != null;\n      allow writes: if resource.data.x == 1 && request.auth != null && f(request.auth);\n    }\n    function f(x) { return x != null; }\n",
                ),
                &[
                    "L5:19 Invalid method name: reads.",
                    "L6:13 Invalid method name: writes.",
                    "L6:24 Invalid variable name: resource.",
                    "L6:48 Invalid variable name: request.",
                    "L6:74 Invalid variable name: request.",
                ],
            ),
            (
                rules(
                    "cloud.firestore",
                    "    function f(request) { let resource = request; return resource != null; }\n    match /{request}/{b} {\n      allow reads: if f(1) && request == 'a';\n    }\n",
                ),
                &["L6:13 Invalid method name: reads."],
            ),
        ];
        for (source, expected) in cases {
            assert_eq!(answered(&source), expected, "{source}");
        }
    }

    /// A service the official compiler does not know has no methods, and
    /// defines neither variable; its rules govern nothing.
    #[test]
    fn a_service_it_does_not_know_compiles_and_governs_nothing() {
        let source = rules(
            "cloud.firestor",
            "    function f() { return request.time != null; }\n    match /a/{b} {\n      allow get, list: if f() && resource == null;\n    }\n",
        );
        assert_eq!(
            answered(&source),
            [
                "L2:9 Invalid service name: cloud.firestor.",
                "L4:27 Invalid variable name: request.",
                "L6:13 Invalid method name: get.",
                "L6:18 Invalid method name: list.",
                "L6:34 Invalid variable name: resource.",
            ]
        );
        let open = rules(
            "cloud.firestor",
            "    match /{document=**} {\n      allow read: if true;\n    }\n",
        );
        let request = EvaluationRequest::new(
            RequestOperation::Get,
            "/databases/(default)/documents/a/b",
            Timestamp::new(1, 0),
        );
        let rules = compile(&open).expect("it compiles, with warnings");
        assert!(!rules.evaluate(&request, &EmptyDocumentAccess).allowed);
    }

    /// A parameter or let nothing reads before another of its name hides it
    /// is unused; beside what Firenook refuses, its warning is answered too.
    #[test]
    fn warns_of_parameters_and_lets_nothing_reads() {
        assert_eq!(
            answered(&rules(
                "cloud.firestore",
                "    function f(x, y) { let a = x; let b = a; return true; }\n    match /a/{b} {\n      allow read: if f(1, 2);\n    }\n",
            )),
            ["L4:19 Unused variable: y.", "L4:39 Unused variable: b."]
        );
        assert_eq!(
            answered(&rules(
                "cloud.firestore",
                "    function f() { let a = 1; let a = 2; return true; }\n    match /a/{b} {\n      allow read: if f();\n    }\n",
            )),
            [
                "L4:24 Unused variable: a.",
                "L4:35 The identifier [a] is already bound in the current scope.",
                "L4:35 Unused variable: a.",
            ]
        );
    }
}
