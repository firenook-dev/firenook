use std::collections::{BTreeMap, BTreeSet};
use std::mem::discriminant;
use std::ops::Range;

use crate::ast::{
    Allow, BinaryOperator, Expr, ExprKind, Function, MatchBlock, Operation, PathPart,
    PatternSegment, Program, TypeName, UnaryOperator, decode_path_text,
};
use crate::expression_depth::{REFUSED_LEVEL, TOO_COMPLEX};
use crate::lexer::{LexError, Token, TokenKind, lex};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParseError {
    pub(crate) message: String,
    pub(crate) offset: usize,
}

// The official parser's expected-token sets, each as recorded where it is
// used (`conformance/fixtures/developer-tools-compile-errors-v1`; the
// expression set also in rules-v2 production-parse-errors and
// storage-rules-v1). Nothing here is the official grammar: where no
// recording says what the official parser reports, Firenook's parser says it
// in its own words.

/// Where a ruleset starts (top/broken, top/whitespace-only).
const RULESET_START: &str = "{'function', 'import', 'service', 'rules_version'}";
/// After `rules_version` (top/match-outside-service, eof/after-rules-version).
const RULESET_ITEM: &str = "{'function', 'import', 'service'}";
/// Where an operand starts (conditions/not-equal-cut, conditions/not-cut,
/// functions/return-value-missing, let/value-missing, eof/after-return).
const EXPRESSION: &str = "{'--', '++', '{', '[', '(', '-', '!', '/', 'false', 'null', 'true', PATH_SEGMENT, IDENTIFIER, NUM_INT, NUM_FLOAT, UNPAIRED_DOUBLE_QUOTE, UNPAIRED_SINGLE_QUOTE, STRING, BYTES}";
/// After a match path with no block, and in a block before its first
/// declaration (braces/match-open-missing, eof/after-match-path,
/// eof/in-match, keywords/alow).
const MATCH_PATH: &str = "{'{', '/', PATH_SEGMENT}";
/// The end of the source after an allow's methods (eof/after-method).
const AFTER_METHODS: &str =
    "{':', ',', '}', ';', '/', 'allow', 'function', 'if', 'match', PATH_SEGMENT}";
/// ... after an `if` with no condition (eof/after-if).
const AFTER_MISSING_CONDITION: &str = "{'}', ';', '/', 'allow', 'function', 'match', PATH_SEGMENT}";
/// ... after a condition that ends with `)` or a string (eof/after-condition,
/// eof/in-string).
const AFTER_CONDITION: &str = "{'&&', '.', '==', '>', '>=', '[', '<', '<=', '-', '%', '!=', '||', '+', '}', ';', '/', '*', '?', 'allow', 'function', 'in', 'is', 'match', PATH_SEGMENT}";
/// A function's `}` after its lets and no return (let/without-return).
const AFTER_LET: &str = "{'&&', '.', '==', '>', '>=', '[', '<', '<=', '-', '%', '!=', '||', '+', ';', '/', '*', '?', 'in', 'is'}";
/// The type names the official parser takes after `is`, in its order
/// (conditions/is-type-unknown).
const OFFICIAL_TYPES: &str = "bool,bytes,constraint,duration,float,int,latlng,list,vector,set,number,map,string,timestamp,path,map_diff";

/// How many expressions deep the parser goes (#231). Every operand nested in
/// another (a bracket's content, the operand of `!` or `-`, a list or map
/// element, a call argument, an index, a branch of the conditional, a path
/// interpolation) is parsed one level down, each a frame of the parser's, so
/// a source of thousands of brackets overflowed its stack before anything
/// could refuse it. Past this the parser stops and answers what the depth
/// check would ([`crate::expression_depth`]): `Expression is too complex to
/// evaluate safely.` where the 100th level starts, which for brackets, unary
/// operators, lists, maps and calls is the node the depth check names.
///
/// Anything shallower is left to the depth check, so every recorded refusal
/// keeps its answer: the deepest recorded, 100 terms bracketed to the right
/// (`rules-v2/expression-size`), is parsed 200 levels deep. At 240 the
/// hungriest shapes (lists, maps, `!`) still parse on a 2 MiB thread in a
/// debug build, where they overflowed at 300.
const MAXIMUM_EXPRESSION_NESTING: usize = 240;

/// How many match blocks deep the parser goes (#231), for the same reason.
/// Production's limit is not recorded; rules nest a handful of blocks.
const MAXIMUM_MATCH_NESTING: usize = 128;

/// How a declaration in a match block ended, which decides what the
/// official parser says when the source ends after it.
#[derive(Clone, Copy)]
enum Ending {
    /// With a `;` or a `}`, or an allow with no operation.
    Closed,
    /// After an allow's methods, with no condition and no `;`.
    Methods,
    /// After an `if` with no condition, and no `;`.
    MissingCondition,
    /// After a condition ending with `)` or a string, and no `;`.
    Condition,
    /// After another condition, and no `;`: no recording says what the
    /// official parser expects there.
    OpenCondition,
}

/// Parses a ruleset. A source that does not parse is answered with its
/// syntax errors in source order, worded as the official emulator's parser
/// words them where a recording shows it (see "Rules compile errors" in
/// DESIGN.md): those the official parser goes on after, then the one it
/// stops at. One that parses is answered with the characters its lexer
/// skipped, if any, then with what Firenook refuses in it (a package name as
/// a binding, a duplicate, a version or service it does not serve).
pub(crate) fn parse(source: &str) -> Result<Program, Vec<ParseError>> {
    let (tokens, skipped) = lex(source);
    let mut parser = Parser::new(source, tokens);
    parser.take_skipped(skipped, 0);
    let program = parser.program();
    let Parser {
        mut reported,
        skipped,
        semantic,
        ..
    } = parser;
    match program {
        Err(error) => {
            reported.push(error);
            Err(reported)
        }
        Ok(_) if !reported.is_empty() => Err(reported),
        Ok(_) if !skipped.is_empty() => Err(skipped),
        Ok(_) if !semantic.is_empty() => Err(semantic),
        Ok(program) => Ok(program),
    }
}

struct Parser<'s> {
    source: &'s str,
    tokens: Vec<Token>,
    index: usize,
    line_starts: Vec<usize>,
    /// Wildcard names bound by the match blocks currently being parsed.
    scope: Vec<String>,
    /// Syntax errors the official parser reports and goes on after.
    reported: Vec<ParseError>,
    /// Characters the lexer skipped.
    skipped: Vec<ParseError>,
    /// What Firenook refuses in a source that parses.
    semantic: Vec<ParseError>,
    /// Where each expression being parsed starts, outermost first.
    expression_starts: Vec<usize>,
    /// How many match blocks are open.
    open_matches: usize,
}

impl<'s> Parser<'s> {
    fn new(source: &'s str, tokens: Vec<Token>) -> Self {
        let line_starts = std::iter::once(0)
            .chain(
                source
                    .bytes()
                    .enumerate()
                    .filter_map(|(offset, byte)| (byte == b'\n').then_some(offset + 1)),
            )
            .collect();
        Self {
            source,
            tokens,
            index: 0,
            line_starts,
            scope: Vec::new(),
            reported: Vec::new(),
            skipped: Vec::new(),
            semantic: Vec::new(),
            expression_starts: Vec::new(),
            open_matches: 0,
        }
    }

    fn take_skipped(&mut self, skipped: Vec<LexError>, base: usize) {
        self.skipped
            .extend(skipped.into_iter().map(|error| ParseError {
                message: error.message,
                offset: base + error.offset,
            }));
    }

    fn program(&mut self) -> Result<Program, ParseError> {
        self.entry(RULESET_START, |kind| {
            is_word(kind, "rules_version") || starts_item(kind)
        })?;
        // `rules_version = '2'` is required for Cloud Firestore. A Storage
        // ruleset may omit it: the official emulator loads such a source and
        // denies `list` with a warning (storage-rules-v1
        // method-rules-version-1), so the version is recorded for the caller.
        let mut declared_version = false;
        let mut version = None;
        if self.check_identifier("rules_version") {
            self.advance();
            declared_version = true;
            self.match_token(&TokenKind::Assign, "'='", |kind| {
                matches!(kind, TokenKind::String(_))
            })?;
            version = self.version()?;
            // The official `firebase init` templates write `rules_version='2'`
            // without a semicolon and the official runtime accepts it.
            self.consume(&TokenKind::Semicolon);
            self.entry(RULESET_ITEM, starts_item)?;
        }
        // Functions may also be declared outside the service block, before
        // or after it.
        let mut top_level = BTreeMap::new();
        let declared = self.declare_functions(&mut top_level)?;
        if !self.check_identifier("service") {
            // After a function, anything else is unwanted
            // (top/word-after-function); an import is not served.
            return Err(if declared {
                self.unexpected()
            } else {
                self.error("expected \"service\"")
            });
        }
        self.advance();
        let service = self.service_name()?;
        let rules_version = match (service, declared_version, version) {
            (_, true, Some((value, offset))) => {
                if value != "2" {
                    self.semantic_at(offset, "only rules_version = '2' is supported");
                }
                2
            }
            (_, true, None) => 2,
            (crate::RulesService::FirebaseStorage, false, _) => 1,
            (crate::RulesService::CloudFirestore, false, _) => {
                let offset = self.previous_offset();
                self.semantic_at(offset, "expected rules_version = '2' before service");
                2
            }
        };
        // After the service's name anything but its block is unwanted
        // (braces/service-open-missing, eof/after-service-name).
        if !self.check(&TokenKind::LeftBrace) {
            return Err(self.unexpected());
        }
        self.advance();
        let (functions, matches) = self.service_block()?;
        loop {
            if self.check(&TokenKind::Eof) {
                break;
            }
            if self.check_identifier("function") {
                self.declare_function(&mut top_level)?;
            } else if self.check_identifier("service") || self.check_identifier("import") {
                // The official parser takes a second service block
                // (top/two-services) and imports; Firenook serves neither.
                return Err(self.error("expected end of rules source"));
            } else {
                // Anything else is unwanted (top/word-after,
                // version/after-service, eof/in-block-comment).
                return Err(self.unexpected());
            }
        }
        if matches.is_empty() {
            let offset = self.previous_offset();
            self.semantic_at(offset, "service must contain at least one match");
        }
        // A function in the service block shadows a top-level one of the
        // same name.
        top_level.extend(functions);
        Ok(Program {
            service,
            rules_version,
            functions: top_level,
            matches,
        })
    }

    /// The version string after `rules_version =`, and where it is. The
    /// official parser's match of a `STRING`: an unwanted token before it is
    /// skipped, one missing before `;` or what starts a ruleset is supplied
    /// (version/value-missing), anything else is mismatched (version/number,
    /// version/unterminated).
    fn version(&mut self) -> Result<Option<(String, usize)>, ParseError> {
        if !matches!(self.current().kind, TokenKind::String(_))
            && matches!(self.next().kind, TokenKind::String(_))
        {
            self.skip_unexpected()?;
        }
        if let TokenKind::String(value) = self.current().kind.clone() {
            self.advance();
            return Ok(Some((value, self.previous_offset())));
        }
        if self.check(&TokenKind::Semicolon) || starts_item(&self.current().kind) {
            self.report_missing("STRING")?;
            return Ok(None);
        }
        Err(self.mismatched("STRING"))
    }

    /// The service's dotted name. The official parser takes any name
    /// (top/service-name-misspelled compiles, with a warning); Firenook
    /// serves `cloud.firestore` and `firebase.storage`.
    fn service_name(&mut self) -> Result<crate::RulesService, ParseError> {
        let offset = self.current().offset;
        let mut name = match self.current().kind.clone() {
            TokenKind::Identifier(word) => {
                self.advance();
                word
            }
            // eof/after-service
            TokenKind::Eof => return Err(self.unexpected()),
            _ => return Err(self.error("expected service name")),
        };
        while self.consume(&TokenKind::Dot) {
            name.push('.');
            if let TokenKind::Identifier(word) = self.current().kind.clone() {
                self.advance();
                name.push_str(&word);
            }
        }
        Ok(match name.as_str() {
            "cloud.firestore" => crate::RulesService::CloudFirestore,
            "firebase.storage" => crate::RulesService::FirebaseStorage,
            _ => {
                self.semantic_at(
                    offset,
                    format!(
                        "unsupported service {name:?}; expected cloud.firestore or firebase.storage"
                    ),
                );
                crate::RulesService::CloudFirestore
            }
        })
    }

    fn service_block(
        &mut self,
    ) -> Result<(BTreeMap<String, Function>, Vec<MatchBlock>), ParseError> {
        let mut functions = BTreeMap::new();
        let mut matches = Vec::new();
        let mut declared = false;
        loop {
            if self.check(&TokenKind::RightBrace) {
                self.advance();
                break;
            }
            if self.check_identifier("function") {
                self.declare_function(&mut functions)?;
            } else if self.check_identifier("match") {
                matches.push(self.match_block()?);
            } else if declared && self.check(&TokenKind::Eof) {
                // The source ends after a declaration: the official parser
                // reports the end and supplies the `}`
                // (braces/service-close-missing).
                let unexpected = self.unexpected();
                self.report(unexpected)?;
                self.report_missing("'}'")?;
                break;
            } else if matches!(self.current().kind, TokenKind::Path(_)) {
                return Err(self.error("expected a function or match declaration in service block"));
            } else {
                // Anything else is unwanted (braces/service-body-word,
                // braces/service-body-allow, eof/in-service).
                return Err(self.unexpected());
            }
            declared = true;
        }
        Ok((functions, matches))
    }

    fn declare_function(
        &mut self,
        functions: &mut BTreeMap<String, Function>,
    ) -> Result<(), ParseError> {
        let (name, function) = self.function()?;
        if functions.insert(name.clone(), function).is_some() {
            let offset = self.previous_offset();
            self.semantic_at(
                offset,
                format!("function {name:?} is declared more than once"),
            );
        }
        Ok(())
    }

    /// Declares the functions at the current token; answers whether there
    /// were any.
    fn declare_functions(
        &mut self,
        functions: &mut BTreeMap<String, Function>,
    ) -> Result<bool, ParseError> {
        let mut declared = false;
        while self.check_identifier("function") {
            self.declare_function(functions)?;
            declared = true;
        }
        Ok(declared)
    }

    fn match_block(&mut self) -> Result<MatchBlock, ParseError> {
        if self.open_matches == MAXIMUM_MATCH_NESTING {
            return Err(self.error(format!(
                "match blocks are nested more than {MAXIMUM_MATCH_NESTING} deep"
            )));
        }
        self.open_matches += 1;
        let block = self.match_block_within();
        self.open_matches -= 1;
        block
    }

    fn match_block_within(&mut self) -> Result<MatchBlock, ParseError> {
        let header_start = self.current().offset;
        self.advance();
        // After `match` anything but a path is unwanted (eof/after-match,
        // paths/missing).
        let TokenKind::Path(raw) = self.current().kind.clone() else {
            return Err(self.unexpected());
        };
        let path_offset = self.current().offset;
        self.advance();
        let header = header_start..self.previous_end();
        let pattern = self.pattern(&raw, path_offset)?;
        let scope_depth = self.scope.len();
        for segment in &pattern {
            if let PatternSegment::Wildcard(name) | PatternSegment::RecursiveWildcard(name) =
                segment
            {
                self.scope.push(name.clone());
            }
        }
        if !self.check(&TokenKind::LeftBrace) {
            return Err(self.no_block(path_offset));
        }
        self.advance();
        let mut functions = BTreeMap::new();
        let mut allows = Vec::new();
        let mut children = Vec::new();
        let mut last = None;
        loop {
            let ending = if self.check(&TokenKind::RightBrace) {
                if last.is_none() {
                    // At the `}` (top/two-services, paths/wildcard-empty).
                    self.report_here("The 'match' body must contain at least one declaration.")?;
                }
                break;
            } else if self.check_identifier("function") {
                let (name, function) = self.function()?;
                if functions.insert(name.clone(), function).is_some() {
                    let offset = self.previous_offset();
                    self.semantic_at(
                        offset,
                        format!("function {name:?} is declared more than once"),
                    );
                }
                Ending::Closed
            } else if self.check_identifier("allow") {
                let (allow, ending) = self.allow()?;
                allows.push(allow);
                ending
            } else if self.check_identifier("match") {
                children.push(self.match_block()?);
                Ending::Closed
            } else if matches!(self.current().kind, TokenKind::Path(_)) {
                return Err(self.error("expected function, allow, or nested match"));
            } else {
                return Err(match last {
                    // Before the first declaration the official parser reads
                    // the block's `{` as more of the path (keywords/alow,
                    // let/in-match, eof/in-match).
                    None => self.no_block(path_offset),
                    // The source ends after a declaration (eof/after-*).
                    Some(ending) if self.check(&TokenKind::Eof) => self.ended(ending),
                    // Anything else after a declaration is unwanted
                    // (semicolons/allow-doubled, conditions/single-equals).
                    Some(_) => self.unexpected(),
                });
            };
            last = Some(ending);
        }
        self.advance();
        self.scope.truncate(scope_depth);
        Ok(MatchBlock {
            header,
            pattern,
            functions,
            allows,
            children,
        })
    }

    /// A match path and no block, or a block and nothing it may hold: the
    /// official parser reports the path as a match without its keyword, the
    /// token as unwanted, then as mismatched where a path goes on.
    #[cold]
    fn no_block(&mut self, path_offset: usize) -> ParseError {
        if let Err(error) = self.reject_invalid() {
            return error;
        }
        self.reported.push(ParseError {
            message: "Missing 'match' keyword before path.".to_owned(),
            offset: path_offset,
        });
        let unexpected = self.unexpected();
        self.reported.push(unexpected);
        self.mismatched(MATCH_PATH)
    }

    /// The source ends after a declaration of a match block: the official
    /// parser reports the end as unwanted, then as mismatched with what
    /// could still have followed the declaration.
    #[cold]
    fn ended(&mut self, ending: Ending) -> ParseError {
        let expecting = match ending {
            // eof/after-declaration, eof/after-inner-match, eof/after-allow
            Ending::Closed => "'}'",
            Ending::Methods => AFTER_METHODS,
            Ending::MissingCondition => AFTER_MISSING_CONDITION,
            Ending::Condition => AFTER_CONDITION,
            Ending::OpenCondition => return self.unexpected(),
        };
        let unexpected = self.unexpected();
        self.reported.push(unexpected);
        self.mismatched(expecting)
    }

    fn function(&mut self) -> Result<(String, Function), ParseError> {
        self.advance();
        let name = match self.current().kind.clone() {
            TokenKind::Identifier(name) => {
                self.advance();
                name
            }
            // functions/name-missing
            TokenKind::LeftParen => {
                self.report_here("Missing 'function' id")?;
                String::new()
            }
            _ => return Err(self.error("expected function name")),
        };
        let name_start = if name.is_empty() {
            self.current().offset
        } else {
            self.previous_offset()
        };
        let parameters = self.parameters()?;
        // After the parameters anything but the body is unwanted
        // (braces/function-open-missing).
        if !self.check(&TokenKind::LeftBrace) {
            return Err(self.unexpected());
        }
        self.advance();
        let body_start = self.current().offset;
        if self.check(&TokenKind::RightBrace) {
            // functions/body-empty
            self.report_here("Missing 'function' body")?;
            self.advance();
            return Ok((
                name,
                Function {
                    name_start,
                    body_start,
                    scope: self.scope.clone(),
                    parameters,
                    lets: Vec::new(),
                    result: Expr::new(ExprKind::Bool(false), body_start, body_start),
                },
            ));
        }
        let lets = self.lets()?;
        if !self.check_identifier("return") {
            if !lets.is_empty() && self.check(&TokenKind::RightBrace) {
                // let/without-return
                let unexpected = self.unexpected();
                self.report(unexpected)?;
                return Err(self.mismatched(AFTER_LET));
            }
            // Anything but a let or the return is unwanted
            // (functions/return-missing, let/then-word, eof/in-function).
            return Err(self.unexpected());
        }
        self.advance();
        let result = self.operand(0)?;
        // The official emulator and production accept a return without `;`.
        let terminated = self.consume(&TokenKind::Semicolon);
        if self.check(&TokenKind::RightBrace) {
            self.advance();
        } else if !terminated {
            return Err(self.error("expected '}' after function body"));
        } else if self.next().kind == TokenKind::RightBrace {
            self.skip_unexpected()?;
            self.advance();
        } else if self.check_identifier("allow")
            || self.check_identifier("function")
            || self.check_identifier("match")
        {
            // Supplied before the next declaration (braces/function-close-missing).
            self.report_missing("'}'")?;
        } else {
            // functions/two-returns
            return Err(self.mismatched("'}'"));
        }
        Ok((
            name,
            Function {
                name_start,
                body_start,
                scope: self.scope.clone(),
                parameters,
                lets,
                result,
            },
        ))
    }

    /// A function's parameter list, from its `(`.
    fn parameters(&mut self) -> Result<Vec<String>, ParseError> {
        let mut parameters = Vec::new();
        if self.consume(&TokenKind::LeftParen) {
            if !self.check(&TokenKind::RightParen) {
                loop {
                    // Anything but a name where a parameter goes, or after
                    // one anything but `,` or `)`, is unwanted
                    // (parens/parameters-close-missing,
                    // functions/parameter-comma-missing, eof/in-parameters).
                    let TokenKind::Identifier(parameter) = self.current().kind.clone() else {
                        return Err(self.unexpected());
                    };
                    self.advance();
                    let offset = self.previous_offset();
                    self.binding(&parameter, offset);
                    if parameters.contains(&parameter) {
                        self.semantic_at(
                            offset,
                            format!("function parameter {parameter:?} is duplicated"),
                        );
                    }
                    parameters.push(parameter);
                    if self.check(&TokenKind::RightParen) {
                        break;
                    }
                    if !self.consume(&TokenKind::Comma) {
                        return Err(self.unexpected());
                    }
                }
            }
            self.advance();
        } else if self.check(&TokenKind::LeftBrace) {
            // parens/parameters-missing
            self.report_here("Missing 'function' signature")?;
        } else {
            return Err(self.error("expected '(' after function name"));
        }
        Ok(parameters)
    }

    /// A function body's lets.
    fn lets(&mut self) -> Result<Vec<(String, Expr)>, ParseError> {
        let mut lets = Vec::new();
        let mut names = BTreeSet::new();
        while self.check_identifier("let") {
            self.advance();
            // An unwanted token before the name is skipped (let/name-missing).
            if !matches!(self.current().kind, TokenKind::Identifier(_))
                && matches!(self.next().kind, TokenKind::Identifier(_))
            {
                self.skip_unexpected()?;
            }
            let binding = self.take_identifier("let binding")?;
            let offset = self.previous_offset();
            self.binding(&binding, offset);
            if !names.insert(binding.clone()) {
                // Worded as production and the official emulator word it
                // (rules-v2 production-parse-errors duplicate-let).
                self.semantic_at(
                    offset,
                    format!("The identifier [{binding}] is already bound in the current scope."),
                );
            }
            // let/equals-missing
            self.match_token(&TokenKind::Assign, "'='", starts_expression)?;
            let value = self.operand(0)?;
            if !self.consume(&TokenKind::Semicolon) {
                if self.check_identifier("let") || self.check_identifier("return") {
                    // Supplied before the next statement (semicolons/let-missing).
                    self.report_missing("';'")?;
                } else {
                    return Err(self.error("expected ';' after let binding"));
                }
            }
            lets.push((binding, value));
        }
        Ok(lets)
    }

    fn allow(&mut self) -> Result<(Allow, Ending), ParseError> {
        self.advance();
        let byte_offset = self.previous_offset();
        let location = crate::AllowLocation {
            line: self
                .line_starts
                .partition_point(|start| *start <= byte_offset),
            byte_offset,
        };
        if !matches!(self.current().kind, TokenKind::Identifier(_)) {
            // Reported at the next token, where the allow ends
            // (conditions/method-missing, eof/after-allow).
            self.report_here("Expected at least one 'operation' after 'allow'.")?;
            let end = self.previous_end();
            let allow = Allow {
                location,
                statement: byte_offset..end,
                condition_span: end..end,
                operations: Vec::new(),
                condition: Expr::new(ExprKind::Bool(false), end, end),
            };
            return Ok((allow, Ending::Closed));
        }
        let mut operations = Vec::new();
        loop {
            let method = self.take_identifier("allow method")?;
            let expanded: &[Operation] = match method.as_str() {
                "get" => &[Operation::Get],
                "list" => &[Operation::List],
                "read" => &[Operation::Get, Operation::List],
                "create" => &[Operation::Create],
                "update" => &[Operation::Update],
                "delete" => &[Operation::Delete],
                "write" => &[Operation::Create, Operation::Update, Operation::Delete],
                _ => {
                    // The official emulator compiles it with a warning
                    // (conditions/method-unknown).
                    let offset = self.previous_offset();
                    self.semantic_at(offset, format!("unsupported allow method {method:?}"));
                    &[]
                }
            };
            for operation in expanded {
                if !operations.contains(operation) {
                    operations.push(*operation);
                }
            }
            if !self.consume(&TokenKind::Comma) {
                break;
            }
        }
        let (condition, condition_span, mut ending) = if self.consume(&TokenKind::Colon) {
            if self.check_identifier("if") {
                self.advance();
                self.condition()?
            } else if starts_expression(&self.current().kind) {
                // conditions/if-missing
                self.report_here("Missing 'if' before conditional expression.")?;
                self.condition_expression()?
            } else {
                // conditions/colon-alone
                return Err(self.unexpected());
            }
        } else if self.check_identifier("if") {
            // conditions/colon-missing
            self.report_here("Missing ':' before 'if' condition.")?;
            self.advance();
            self.condition()?
        } else {
            // `allow read, write;` (no condition) is an unconditional grant:
            // the official `templates/emulators/default_storage.rules` and
            // the Firebase rules reference both use it.
            let end = self.previous_end();
            (
                Expr::new(ExprKind::Bool(true), end, end),
                end..end,
                Ending::Methods,
            )
        };
        // The official parser takes an allow without its `;`, before another
        // declaration as at the end of its block
        // (developer-tools-compile-errors-v1 semicolons/allow-missing,
        // storage-rules-v1 set-rules-missing-semicolon-accepted).
        if self.consume(&TokenKind::Semicolon) {
            ending = Ending::Closed;
        }
        let allow = Allow {
            location,
            statement: byte_offset..self.previous_end(),
            condition_span,
            operations,
            condition,
        };
        Ok((allow, ending))
    }

    /// The condition after `if`. A token no expression starts with is
    /// reported there, and the allow goes on without a condition
    /// (conditions/if-*, conditions/bad-character-at, eof/after-if).
    fn condition(&mut self) -> Result<(Expr, Range<usize>, Ending), ParseError> {
        if !starts_expression(&self.current().kind) {
            self.report_here("Missing conditional expression after 'if'.")?;
            let end = self.previous_end();
            return Ok((
                Expr::new(ExprKind::Bool(false), end, end),
                end..end,
                Ending::MissingCondition,
            ));
        }
        self.condition_expression()
    }

    fn condition_expression(&mut self) -> Result<(Expr, Range<usize>, Ending), ParseError> {
        let start = self.current().offset;
        let condition = self.expression(0)?;
        let ending = if matches!(
            self.tokens[self.index - 1].kind,
            TokenKind::RightParen | TokenKind::String(_) | TokenKind::UnpairedQuote(_)
        ) {
            Ending::Condition
        } else {
            Ending::OpenCondition
        };
        Ok((condition, start..self.previous_end(), ending))
    }

    /// An operand where the official parser expects an expression: after an
    /// operator, `return`, or a let's `=`. A token no expression starts with
    /// is skipped as unwanted when the next one starts one
    /// (conditions/triple-equals), and is otherwise mismatched.
    fn operand(&mut self, binding_power: u8) -> Result<Expr, ParseError> {
        if !starts_expression(&self.current().kind) {
            if starts_expression(&self.next().kind) {
                self.skip_unexpected()?;
            } else {
                return Err(self.mismatched(EXPRESSION));
            }
        }
        self.expression(binding_power)
    }

    fn expression(&mut self, minimum_binding_power: u8) -> Result<Expr, ParseError> {
        if self.expression_starts.len() == MAXIMUM_EXPRESSION_NESTING {
            return Err(ParseError {
                message: TOO_COMPLEX.to_owned(),
                offset: self.expression_starts[REFUSED_LEVEL - 1],
            });
        }
        self.expression_starts.push(self.current().offset);
        let expression = self.expression_within(minimum_binding_power);
        self.expression_starts.pop();
        expression
    }

    fn expression_within(&mut self, minimum_binding_power: u8) -> Result<Expr, ParseError> {
        let mut left = self.prefix()?;
        loop {
            let start = left.span.start;
            if 30 >= minimum_binding_power && self.consume(&TokenKind::Dot) {
                // After `.` anything but a name is unwanted
                // (conditions/trailing-dot).
                let TokenKind::Identifier(name) = self.current().kind.clone() else {
                    return Err(self.unexpected());
                };
                self.advance();
                left = Expr::new(
                    ExprKind::Field {
                        base: Box::new(left),
                        name,
                    },
                    start,
                    self.previous_end(),
                );
                continue;
            }
            if 30 >= minimum_binding_power && self.consume(&TokenKind::LeftParen) {
                let arguments = self.arguments()?;
                left = Expr::new(
                    ExprKind::Call {
                        callee: Box::new(left),
                        arguments,
                    },
                    start,
                    self.previous_end(),
                );
                continue;
            }
            if 30 >= minimum_binding_power && self.consume(&TokenKind::LeftBracket) {
                left = self.index_or_slice(left)?;
                continue;
            }

            if self.check_identifier("is") {
                let (left_binding_power, right_binding_power) = (8, 9);
                if left_binding_power < minimum_binding_power {
                    break;
                }
                self.advance();
                let expected = self.type_name()?;
                let _ = right_binding_power;
                left = Expr::new(
                    ExprKind::Is {
                        value: Box::new(left),
                        expected,
                    },
                    start,
                    self.previous_end(),
                );
                continue;
            }

            // `c ? a : b` binds looser than `||` and groups to the right, as
            // in the official emulator.
            if minimum_binding_power == 0 && self.consume(&TokenKind::Question) {
                let then = self.expression(0)?;
                self.expect(&TokenKind::Colon, "':' in conditional expression")?;
                let otherwise = self.expression(0)?;
                left = Expr::new(
                    ExprKind::Conditional {
                        condition: Box::new(left),
                        then: Box::new(then),
                        otherwise: Box::new(otherwise),
                    },
                    start,
                    self.previous_end(),
                );
                continue;
            }

            let Some((operator, left_binding_power, right_binding_power)) = self.binary_operator()
            else {
                break;
            };
            if left_binding_power < minimum_binding_power {
                break;
            }
            let operator_at = self.current().offset;
            self.advance();
            let right = self.operand(right_binding_power)?;
            left = Expr::new(
                ExprKind::Binary {
                    operator,
                    operator_at,
                    left: Box::new(left),
                    right: Box::new(right),
                },
                start,
                self.previous_end(),
            );
        }
        Ok(left)
    }

    /// The type name after `is`.
    fn type_name(&mut self) -> Result<TypeName, ParseError> {
        let name = self.take_identifier("type name after 'is'")?;
        Ok(match parse_type_name(&name) {
            Some(expected) => expected,
            None if OFFICIAL_TYPES.split(',').any(|official| official == name) => {
                let offset = self.previous_offset();
                self.semantic_at(offset, format!("unsupported rules type {name:?}"));
                TypeName::Null
            }
            None => {
                // At the token after the name (conditions/is-type-unknown).
                self.report_here(format!(
                    "An unsupported type identifier was used with the 'is' operator. Received {name}. Expected one of {OFFICIAL_TYPES}"
                ))?;
                TypeName::Null
            }
        })
    }

    fn prefix(&mut self) -> Result<Expr, ParseError> {
        let token = self.advance().clone();
        let kind = match token.kind {
            TokenKind::Identifier(value) if value == "true" => Ok(ExprKind::Bool(true)),
            TokenKind::Identifier(value) if value == "false" => Ok(ExprKind::Bool(false)),
            TokenKind::Identifier(value) if value == "null" => Ok(ExprKind::Null),
            TokenKind::Identifier(value) if !is_keyword(&value) => Ok(ExprKind::Variable(value)),
            TokenKind::String(value) => Ok(ExprKind::String(value)),
            TokenKind::UnpairedQuote(quote) => {
                // Reported at the token after it, and taken as closed
                // (strings/*, eof/in-string).
                self.report_here(format!("Missing a closing {quote}"))?;
                Ok(ExprKind::String(
                    self.source[token.offset + 1..token.end_offset].to_owned(),
                ))
            }
            TokenKind::Integer(value) => Ok(ExprKind::Integer(value)),
            TokenKind::Float(value) => Ok(ExprKind::Float(value)),
            TokenKind::Path(value) => self.expression_path(&value, token.offset),
            TokenKind::Bang => Ok(ExprKind::Unary {
                operator: UnaryOperator::Not,
                operand: Box::new(self.operand(20)?),
            }),
            TokenKind::Minus => Ok(ExprKind::Unary {
                operator: UnaryOperator::Negate,
                operand: Box::new(self.operand(20)?),
            }),
            TokenKind::LeftParen => {
                // After `(`, and after its expression, a token that does not
                // go on is unwanted (conditions/group-cut,
                // parens/condition-close-missing).
                if !starts_expression(&self.current().kind) {
                    return Err(self.unexpected());
                }
                let mut expression = self.expression(0)?;
                if !self.check(&TokenKind::RightParen) {
                    return Err(self.unexpected());
                }
                self.advance();
                // Coverage includes the opening grouping token, but not its
                // closing token. Keep the child expressions' own positions.
                expression.span.start = token.offset;
                return Ok(expression);
            }
            TokenKind::LeftBracket => self.list(),
            TokenKind::LeftBrace => self.map(),
            TokenKind::Invalid(error) => Err(ParseError {
                message: error.message,
                offset: error.offset,
            }),
            _ => Err(ParseError {
                message: "expected a rules expression".to_owned(),
                offset: token.offset,
            }),
        }?;
        Ok(Expr::new(kind, token.offset, self.previous_end()))
    }

    fn list(&mut self) -> Result<ExprKind, ParseError> {
        let mut values = Vec::new();
        if !self.check(&TokenKind::RightBracket) {
            loop {
                values.push(self.expression(0)?);
                if !self.consume(&TokenKind::Comma) {
                    break;
                }
                if self.check(&TokenKind::RightBracket) {
                    break;
                }
            }
        }
        self.expect(&TokenKind::RightBracket, "']' after list literal")?;
        Ok(ExprKind::List(values))
    }

    fn map(&mut self) -> Result<ExprKind, ParseError> {
        let mut entries = Vec::new();
        if !self.check(&TokenKind::RightBrace) {
            loop {
                let (TokenKind::String(key) | TokenKind::Identifier(key)) =
                    self.advance().kind.clone()
                else {
                    return Err(self.error_at_previous("map keys must be strings"));
                };
                self.expect(&TokenKind::Colon, "':' after map key")?;
                entries.push((key, self.expression(0)?));
                if !self.consume(&TokenKind::Comma) {
                    break;
                }
                if self.check(&TokenKind::RightBrace) {
                    break;
                }
            }
        }
        self.expect(&TokenKind::RightBrace, "'}' after map literal")?;
        Ok(ExprKind::Map(entries))
    }

    fn arguments(&mut self) -> Result<Vec<Expr>, ParseError> {
        let mut arguments = Vec::new();
        if !self.check(&TokenKind::RightParen) {
            // After `(` anything no argument starts with is unwanted
            // (parens/call-close-missing, eof/in-arguments).
            if !starts_expression(&self.current().kind) {
                return Err(self.unexpected());
            }
            loop {
                arguments.push(self.expression(0)?);
                if !self.consume(&TokenKind::Comma) {
                    break;
                }
            }
        }
        self.expect(&TokenKind::RightParen, "')' after call arguments")?;
        Ok(arguments)
    }

    fn index_or_slice(&mut self, base: Expr) -> Result<Expr, ParseError> {
        let begin = base.span.start;
        let start = if self.check(&TokenKind::Colon) {
            None
        } else {
            Some(Box::new(self.expression(0)?))
        };
        if self.consume(&TokenKind::Colon) {
            let end = if self.check(&TokenKind::RightBracket) {
                None
            } else {
                Some(Box::new(self.expression(0)?))
            };
            self.expect(&TokenKind::RightBracket, "']' after slice")?;
            return Ok(Expr::new(
                ExprKind::Slice {
                    base: Box::new(base),
                    start,
                    end,
                },
                begin,
                self.previous_end(),
            ));
        }
        let index = start.ok_or_else(|| self.error("index expression is missing"))?;
        self.expect(&TokenKind::RightBracket, "']' after index")?;
        Ok(Expr::new(
            ExprKind::Index {
                base: Box::new(base),
                index,
            },
            begin,
            self.previous_end(),
        ))
    }

    /// A match path's segments. The official parser reports a `/` with no
    /// segment after it, at the `/`, and goes on (paths/trailing-slash,
    /// paths/wildcard-empty); two globs it refuses once the source parses
    /// (production-parse-errors invalid-recursive-wildcard).
    fn pattern(&mut self, raw: &str, offset: usize) -> Result<Vec<PatternSegment>, ParseError> {
        const NO_SEGMENT: &str = "Forward slash '/' found where identifier or binding expected.";
        if !raw.starts_with('/') {
            return Err(ParseError {
                message: "match path must begin with '/'".to_owned(),
                offset,
            });
        }
        let mut recursive_wildcards = 0_usize;
        let mut pattern = Vec::new();
        let mut segment_offset = offset + 1;
        let mut segments = raw[1..].split('/').peekable();
        while let Some(segment) = segments.next() {
            let slash = segment_offset - 1;
            if segment.is_empty() {
                if segments.peek().is_none() {
                    self.reported.push(ParseError {
                        message: NO_SEGMENT.to_owned(),
                        offset: slash,
                    });
                    break;
                }
                return Err(ParseError {
                    message: "match path contains an empty segment".to_owned(),
                    offset,
                });
            }
            let parsed = if let Some(wildcard) = segment
                .strip_prefix('{')
                .and_then(|segment| segment.strip_suffix('}'))
            {
                let name = wildcard.strip_suffix("=**").unwrap_or(wildcard);
                if wildcard.is_empty() {
                    self.reported.push(ParseError {
                        message: NO_SEGMENT.to_owned(),
                        offset: slash,
                    });
                } else if name.is_empty() {
                    return Err(ParseError {
                        message: "match wildcard name cannot be empty".to_owned(),
                        offset,
                    });
                } else {
                    self.binding(name, segment_offset + 1);
                }
                if let Some(name) = wildcard.strip_suffix("=**") {
                    recursive_wildcards += 1;
                    if recursive_wildcards == 2 {
                        self.semantic_at(
                            slash,
                            "Invalid glob match expression. Only one glob match is permitted in a match declaration path.",
                        );
                    }
                    PatternSegment::RecursiveWildcard(name.to_owned())
                } else {
                    PatternSegment::Wildcard(wildcard.to_owned())
                }
            } else {
                PatternSegment::Literal(segment.to_owned())
            };
            pattern.push(parsed);
            segment_offset += segment.len() + 1;
        }
        Ok(pattern)
    }

    fn expression_path(&mut self, raw: &str, offset: usize) -> Result<ExprKind, ParseError> {
        let mut parts = Vec::new();
        let mut cursor = 0_usize;
        while let Some(relative) = raw[cursor..].find("$(") {
            let start = cursor + relative;
            if !raw[..start].ends_with('/') {
                return Err(interpolation_within_a_segment(offset));
            }
            if start > cursor {
                parts.push(path_literal(&raw[cursor..start], offset)?);
            }
            let expression_start = start + 2;
            let mut depth = 1_usize;
            let mut expression_end = None;
            for (relative, character) in raw[expression_start..].char_indices() {
                match character {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            expression_end = Some(expression_start + relative);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let expression_end = expression_end.ok_or_else(|| ParseError {
                message: "unterminated path interpolation".to_owned(),
                offset,
            })?;
            // The interpolation's own tokens, placed in the whole source,
            // parsed in place of the ruleset's.
            let base = offset + expression_start;
            let (mut tokens, skipped) = lex(&raw[expression_start..expression_end]);
            for token in &mut tokens {
                token.offset += base;
                token.end_offset += base;
                if let TokenKind::Invalid(error) = &mut token.kind {
                    error.offset += base;
                }
            }
            self.take_skipped(skipped, base);
            let tokens = std::mem::replace(&mut self.tokens, tokens);
            let index = std::mem::replace(&mut self.index, 0);
            let expression = self.expression(0).and_then(|expression| {
                self.expect(&TokenKind::Eof, "end of path interpolation")?;
                Ok(expression)
            });
            self.tokens = tokens;
            self.index = index;
            parts.push(PathPart::Interpolation(expression?));
            cursor = expression_end + 1;
            if !(raw[cursor..].is_empty() || raw[cursor..].starts_with('/')) {
                return Err(interpolation_within_a_segment(offset));
            }
        }
        if cursor < raw.len() {
            parts.push(path_literal(&raw[cursor..], offset)?);
        }
        Ok(ExprKind::Path(parts))
    }

    fn previous_end(&self) -> usize {
        self.tokens[self.index.saturating_sub(1)].end_offset
    }

    fn binary_operator(&self) -> Option<(BinaryOperator, u8, u8)> {
        let operator = match &self.current().kind {
            TokenKind::Or => (BinaryOperator::Or, 1, 2),
            TokenKind::And => (BinaryOperator::And, 3, 4),
            TokenKind::Identifier(value) if value == "in" => (BinaryOperator::In, 7, 8),
            TokenKind::Equal => (BinaryOperator::Equal, 7, 8),
            TokenKind::NotEqual => (BinaryOperator::NotEqual, 7, 8),
            TokenKind::Less => (BinaryOperator::Less, 9, 10),
            TokenKind::LessEqual => (BinaryOperator::LessEqual, 9, 10),
            TokenKind::Greater => (BinaryOperator::Greater, 9, 10),
            TokenKind::GreaterEqual => (BinaryOperator::GreaterEqual, 9, 10),
            TokenKind::Plus => (BinaryOperator::Add, 11, 12),
            TokenKind::Minus => (BinaryOperator::Subtract, 11, 12),
            TokenKind::Star => (BinaryOperator::Multiply, 13, 14),
            TokenKind::Slash => (BinaryOperator::Divide, 13, 14),
            TokenKind::Percent => (BinaryOperator::Remainder, 13, 14),
            _ => return None,
        };
        Some(operator)
    }

    /// Where the official parser chooses among `expecting`: a token that
    /// fits none is skipped as unwanted when the one after it fits
    /// (top/word-before), and is otherwise mismatched (top/broken).
    fn entry(&mut self, expecting: &str, fits: fn(&TokenKind) -> bool) -> Result<(), ParseError> {
        if fits(&self.current().kind) {
            return Ok(());
        }
        if fits(&self.next().kind) {
            return self.skip_unexpected();
        }
        Err(self.mismatched(expecting))
    }

    /// The official parser's match of one token: an unwanted token before it
    /// is skipped, one missing before a token that may follow it is supplied
    /// (version/equals-missing), anything else is mismatched
    /// (version/colon).
    fn match_token(
        &mut self,
        expected: &TokenKind,
        shown: &str,
        follows: fn(&TokenKind) -> bool,
    ) -> Result<(), ParseError> {
        if self.check(expected) {
            self.advance();
            return Ok(());
        }
        if discriminant(&self.next().kind) == discriminant(expected) {
            self.skip_unexpected()?;
            self.advance();
            return Ok(());
        }
        if follows(&self.current().kind) {
            return self.report_missing(shown);
        }
        Err(self.mismatched(shown))
    }

    /// The current token as the official parser shows it in a message.
    #[cold]
    fn shown(&self) -> String {
        let token = self.current();
        let text = match &token.kind {
            TokenKind::Eof => return "<EOF>".to_owned(),
            // The official lexer reads a path as its segments: `/name`, or
            // `/` before a wildcard or an interpolation.
            TokenKind::Path(path) => {
                let end = path[1..]
                    .find(['/', '{', '}', '$'])
                    .map_or(path.len(), |end| end + 1);
                &path[..end]
            }
            _ => &self.source[token.offset..token.end_offset],
        };
        text.replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t")
    }

    #[cold]
    fn unexpected(&self) -> ParseError {
        self.error(format!("Unexpected '{}'.", self.shown()))
    }

    #[cold]
    fn mismatched(&self, expecting: &str) -> ParseError {
        self.error(format!(
            "mismatched input '{}' expecting {expecting}",
            self.shown()
        ))
    }

    /// Reports an error the official parser goes on after. At a token
    /// Firenook could not read, the parse ends with that token's error.
    #[cold]
    fn report(&mut self, error: ParseError) -> Result<(), ParseError> {
        self.reject_invalid()?;
        self.reported.push(error);
        Ok(())
    }

    #[cold]
    fn report_here(&mut self, message: impl Into<String>) -> Result<(), ParseError> {
        let error = ParseError {
            message: message.into(),
            offset: self.current().offset,
        };
        self.report(error)
    }

    /// The official parser's single-token deletion: the current token is
    /// reported as unwanted, and skipped.
    #[cold]
    fn skip_unexpected(&mut self) -> Result<(), ParseError> {
        let unexpected = self.unexpected();
        self.report(unexpected)?;
        self.advance();
        Ok(())
    }

    /// The official parser's single-token insertion: `shown` is reported as
    /// missing at the current token, and taken as there.
    #[cold]
    fn report_missing(&mut self, shown: &str) -> Result<(), ParseError> {
        let missing = self.error(format!("missing {shown} at '{}'", self.shown()));
        self.report(missing)
    }

    #[cold]
    fn reject_invalid(&self) -> Result<(), ParseError> {
        match &self.current().kind {
            TokenKind::Invalid(error) => Err(ParseError {
                message: error.message.clone(),
                offset: error.offset,
            }),
            _ => Ok(()),
        }
    }

    #[cold]
    fn semantic_at(&mut self, offset: usize, message: impl Into<String>) {
        self.semantic.push(ParseError {
            message: message.into(),
            offset,
        });
    }

    /// A package's name as a parameter, let or wildcard, which the official
    /// emulator refuses once the source parses (rule-bindings-v1;
    /// developer-tools-compile-errors-v1 two/package-and-syntax).
    fn binding(&mut self, name: &str, offset: usize) {
        if matches!(
            name,
            "duration" | "hashing" | "latlng" | "math" | "timestamp"
        ) {
            self.semantic_at(
                offset,
                format!("{name} is a package and cannot be used as variable name."),
            );
        }
    }

    fn take_identifier(&mut self, description: &str) -> Result<String, ParseError> {
        match self.advance().kind.clone() {
            TokenKind::Identifier(value) => Ok(value),
            _ => Err(self.error_at_previous(format!("expected {description}"))),
        }
    }

    fn expect(&mut self, expected: &TokenKind, description: &str) -> Result<(), ParseError> {
        if self.check(expected) {
            self.advance();
            Ok(())
        } else {
            Err(self.error(format!("expected {description}")))
        }
    }

    fn consume(&mut self, expected: &TokenKind) -> bool {
        if self.check(expected) {
            self.advance();
            true
        } else {
            false
        }
    }

    fn check(&self, expected: &TokenKind) -> bool {
        discriminant(&self.current().kind) == discriminant(expected)
    }

    fn check_identifier(&self, expected: &str) -> bool {
        is_word(&self.current().kind, expected)
    }

    fn current(&self) -> &Token {
        &self.tokens[self.index]
    }

    /// The token after the current one: the official parser's second token
    /// of lookahead.
    fn next(&self) -> &Token {
        &self.tokens[(self.index + 1).min(self.tokens.len() - 1)]
    }

    fn advance(&mut self) -> &Token {
        let index = self.index;
        if !matches!(self.tokens[index].kind, TokenKind::Eof) {
            self.index += 1;
        }
        &self.tokens[index]
    }

    fn previous_offset(&self) -> usize {
        self.tokens[self.index.saturating_sub(1)].offset
    }

    /// An error at the current token; at a token Firenook could not read,
    /// that token's own error.
    #[cold]
    fn error(&self, message: impl Into<String>) -> ParseError {
        Self::at(self.current(), message)
    }

    #[cold]
    fn error_at_previous(&self, message: impl Into<String>) -> ParseError {
        Self::at(&self.tokens[self.index.saturating_sub(1)], message)
    }

    #[cold]
    fn at(token: &Token, message: impl Into<String>) -> ParseError {
        match &token.kind {
            TokenKind::Invalid(error) => ParseError {
                message: error.message.clone(),
                offset: error.offset,
            },
            _ => ParseError {
                message: message.into(),
                offset: token.offset,
            },
        }
    }
}

fn is_word(kind: &TokenKind, word: &str) -> bool {
    matches!(kind, TokenKind::Identifier(value) if value == word)
}

/// A word the official lexer makes a keyword of, so never an operand.
fn is_keyword(word: &str) -> bool {
    matches!(
        word,
        "allow"
            | "function"
            | "if"
            | "import"
            | "in"
            | "is"
            | "let"
            | "match"
            | "return"
            | "rules_version"
            | "service"
    )
}

/// What may begin a ruleset's item: a function, an import or the service.
fn starts_item(kind: &TokenKind) -> bool {
    is_word(kind, "function") || is_word(kind, "import") || is_word(kind, "service")
}

/// A token in the official parser's set of what starts an expression
/// ([`EXPRESSION`]).
fn starts_expression(kind: &TokenKind) -> bool {
    match kind {
        TokenKind::Identifier(word) => !is_keyword(word),
        TokenKind::String(_)
        | TokenKind::UnpairedQuote(_)
        | TokenKind::Integer(_)
        | TokenKind::Float(_)
        | TokenKind::Path(_)
        | TokenKind::LeftBrace
        | TokenKind::LeftBracket
        | TokenKind::LeftParen
        | TokenKind::Minus
        | TokenKind::Bang => true,
        _ => false,
    }
}

fn path_literal(raw: &str, offset: usize) -> Result<PathPart, ParseError> {
    decode_path_text(raw)
        .map(PathPart::Literal)
        .ok_or_else(|| ParseError {
            message: format!("path {raw:?} has an invalid percent escape"),
            offset,
        })
}

fn interpolation_within_a_segment(offset: usize) -> ParseError {
    ParseError {
        message: "a path interpolation must be a whole segment".to_owned(),
        offset,
    }
}

fn parse_type_name(name: &str) -> Option<TypeName> {
    match name {
        "null" => Some(TypeName::Null),
        "bool" => Some(TypeName::Bool),
        "int" => Some(TypeName::Int),
        "float" => Some(TypeName::Float),
        "number" => Some(TypeName::Number),
        "string" => Some(TypeName::String),
        "list" => Some(TypeName::List),
        "map" => Some(TypeName::Map),
        "timestamp" => Some(TypeName::Timestamp),
        "duration" => Some(TypeName::Duration),
        "path" => Some(TypeName::Path),
        "bytes" => Some(TypeName::Bytes),
        "latlng" => Some(TypeName::LatLng),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_matches_functions_and_precedence() {
        let source = r"
            rules_version = '2';
            service cloud.firestore {
              match /databases/{database}/documents {
                function signedIn() { return request.auth != null; }
                match /items/{item} {
                  allow read: if signedIn() && 2 + 3 * 4 == 14;
                }
              }
            }
        ";
        let program = parse(source).expect("rules should parse");
        assert_eq!(program.match_count(), 2);
        assert_eq!(program.allow_count(), 1);
        assert_eq!(program.function_count(), 1);
    }

    #[test]
    fn rules_version_needs_no_semicolon() {
        // The official `firebase init` firestore.rules template.
        let source = "rules_version='2'\n\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if\n          request.time < timestamp.date(2026, 10, 19);\n    }\n  }\n}\n";
        let program = parse(source).expect("the init template parses");
        assert_eq!(program.allow_count(), 1);
        assert!(parse("rules_version = '3'; service cloud.firestore {}").is_err());
    }

    #[test]
    fn unconditional_allow_is_an_implicit_true() {
        // The official emulator's default_storage.rules for demo projects.
        let source = "rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{allPaths=**} {\n      allow read, write;\n    }\n  }\n}\n";
        let program = parse(source).expect("an allow without a condition parses");
        assert_eq!(program.allow_count(), 1);
        assert!(crate::compile(source).is_ok());
        assert!(parse("service cloud.firestore { match /x/{y} { allow read: ; } }").is_err());
    }

    #[test]
    fn rejects_two_recursive_wildcards() {
        let source = "rules_version = '2'; service cloud.firestore { match /{a=**}/{b=**} { allow read: if true; } }";
        let errors = parse(source).expect_err("two recursive wildcards must fail");
        // At the `/` before the second, as production words it.
        assert_eq!(
            errors,
            [ParseError {
                message: "Invalid glob match expression. Only one glob match is permitted in a match declaration path.".to_owned(),
                offset: source.find("/{b=**}").unwrap(),
            }]
        );
    }

    /// Each error as `L<line>:<column> <message>`, the official framing.
    fn answered(source: &str) -> Vec<String> {
        parse(source)
            .expect_err("the source is refused")
            .into_iter()
            .map(|error| {
                let before = &source[..error.offset];
                let line = before.matches('\n').count() + 1;
                let column = before.rsplit('\n').next().unwrap_or(before).chars().count() + 1;
                format!("L{line}:{column} {}", error.message)
            })
            .collect()
    }

    /// The official parser's recovery where developer-tools-compile-errors-v1
    /// records it: a token skipped as unwanted, one supplied as missing, a
    /// condition missing, a string left open, each parsed on after; a
    /// mismatch, and the end of the source, parsed no further.
    #[test]
    fn words_and_recovers_as_the_official_parser_where_recorded() {
        let rules = |body: &str| {
            format!(
                "rules_version = '2';\nservice cloud.firestore {{\n  match /c/{{id}} {{\n{body}"
            )
        };
        let cases: [(String, &[&str]); 8] = [
            (
                rules("    allow read: if 1 === 1;\n  }\n}\n"),
                &["L4:24 Unexpected '='."],
            ),
            (
                rules("    function f() { let x 1; return x; }\n    allow read: if f();\n  }\n}\n"),
                &["L4:26 missing '=' at '1'"],
            ),
            (
                rules("    allow read: if ;\n    allow write: if\n  }\n}\n"),
                &[
                    "L4:20 Missing conditional expression after 'if'.",
                    "L6:3 Missing conditional expression after 'if'.",
                ],
            ),
            (
                rules("    allow read: if 'a\n    allow write: if true &&;\n  }\n}\n"),
                &[
                    "L5:5 Missing a closing '",
                    "L5:28 mismatched input ';' expecting {'--', '++', '{', '[', '(', '-', '!', '/', 'false', 'null', 'true', PATH_SEGMENT, IDENTIFIER, NUM_INT, NUM_FLOAT, UNPAIRED_DOUBLE_QUOTE, UNPAIRED_SINGLE_QUOTE, STRING, BYTES}",
                ],
            ),
            (
                rules("    allow read: if true;"),
                &[
                    "L4:25 Unexpected '<EOF>'.",
                    "L4:25 mismatched input '<EOF>' expecting '}'",
                ],
            ),
            (
                rules("    alow read: if true;\n  }\n}\n"),
                &[
                    "L3:9 Missing 'match' keyword before path.",
                    "L4:5 Unexpected 'alow'.",
                    "L4:5 mismatched input 'alow' expecting {'{', '/', PATH_SEGMENT}",
                ],
            ),
            (
                rules("    allow read: if true;\n  }\n"),
                &["L6:1 Unexpected '<EOF>'.", "L6:1 missing '}' at '<EOF>'"],
            ),
            (
                "broken".to_owned(),
                &[
                    "L1:1 mismatched input 'broken' expecting {'function', 'import', 'service', 'rules_version'}",
                ],
            ),
        ];
        for (source, expected) in cases {
            assert_eq!(answered(&source), expected, "{source}");
        }
    }

    /// Syntax errors are answered first, then the characters the lexer
    /// skipped, then what Firenook refuses in a source that parses
    /// (developer-tools-compile-errors-v1 conditions/tilde,
    /// conditions/bad-character-hash, two/package-and-syntax).
    #[test]
    fn answers_syntax_then_skipped_characters_then_the_rest() {
        let rules = |function: &str, condition: &str| {
            format!(
                "rules_version = '2';\nservice cloud.firestore {{\n  match /c/{{id}} {{\n    function {function} {{ return true; }}\n    allow read: if {condition};\n  }}\n}}\n"
            )
        };
        assert_eq!(
            answered(&rules("f(duration)", "f(1)")),
            ["L4:16 duration is a package and cannot be used as variable name."]
        );
        assert_eq!(
            answered(&rules("f(duration)", "~f(1)")),
            ["L5:20 token recognition error at: '~'"]
        );
        assert_eq!(
            answered(&rules("f(duration)", "~f(1) # x")),
            ["L5:28 Unexpected 'x'."]
        );
    }
}
