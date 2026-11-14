use std::collections::{BTreeMap, BTreeSet};
use std::mem::discriminant;
use std::ops::Range;

use crate::ast::{
    Allow, BinaryOperator, Expr, ExprKind, Function, MatchBlock, Operation, PathPart,
    PatternSegment, Program, TypeName, UnaryOperator, decode_path_text,
};
use crate::expression_depth::{REFUSED_LEVEL, TOO_COMPLEX};
use crate::lexer::{
    LexError, Token, TokenKind, lex, lex_expression, lex_match_path, segment_length,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParseError {
    pub(crate) message: String,
    pub(crate) offset: usize,
}

// The official parser's expected-token sets, each as recorded where it is
// used (`conformance/fixtures/developer-tools-compile-errors-v1`; the
// expression set also in rules-v2 production-parse-errors and
// storage-rules-v1), or where marked as the official emulator answers a
// source no recording holds. Nothing here is the official grammar: where
// neither says what the official parser reports, Firenook's parser says it
// in its own words.

/// Where a ruleset starts (top/broken, top/whitespace-only).
const RULESET_START: &str = "{'function', 'import', 'service', 'rules_version'}";
/// After `rules_version` (top/match-outside-service, eof/after-rules-version).
const RULESET_ITEM: &str = "{'function', 'import', 'service'}";
/// Where an operand starts (conditions/not-equal-cut, conditions/not-cut,
/// functions/return-value-missing, let/value-missing, eof/after-return).
const EXPRESSION: &str = "{'--', '++', '{', '[', '(', '-', '!', '/', 'false', 'null', 'true', PATH_SEGMENT, IDENTIFIER, NUM_INT, NUM_FLOAT, UNPAIRED_DOUBLE_QUOTE, UNPAIRED_SINGLE_QUOTE, STRING, BYTES}";
/// After a match path (braces/match-open-missing, eof/after-match-path,
/// eof/in-match, keywords/alow).
const MATCH_PATH: &str = "{'{', '/', PATH_SEGMENT}";
/// After an allow's methods (eof/after-method).
const AFTER_METHODS: &str =
    "{':', ',', '}', ';', '/', 'allow', 'function', 'if', 'match', PATH_SEGMENT}";
/// ... after an `if` with no condition (eof/after-if).
const AFTER_MISSING_CONDITION: &str = "{'}', ';', '/', 'allow', 'function', 'match', PATH_SEGMENT}";
/// ... after a condition (eof/after-condition, eof/in-string).
const AFTER_CONDITION: &str = "{'&&', '.', '==', '>', '>=', '[', '<', '<=', '-', '%', '!=', '||', '+', '}', ';', '/', '*', '?', 'allow', 'function', 'in', 'is', 'match', PATH_SEGMENT}";
/// After a let's value (let/without-return, let/then-word).
const AFTER_LET: &str = "{'&&', '.', '==', '>', '>=', '[', '<', '<=', '-', '%', '!=', '||', '+', ';', '/', '*', '?', 'in', 'is'}";
/// After a function's result with no `;`: what goes on with the result, the
/// `;` and the body's `}`, in the two sets' order above (the official
/// emulator, unrecorded: `return a b`).
const AFTER_RESULT: &str = "{'&&', '.', '==', '>', '>=', '[', '<', '<=', '-', '%', '!=', '||', '+', '}', ';', '/', '*', '?', 'in', 'is'}";
/// Where a function body starts (the official emulator, unrecorded:
/// `function f {}`).
const FUNCTION_BODY: &str = "{'let', 'return'}";
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

/// Tokens as the official grammar's follow sets tell them apart: a set of
/// them is what may come after a rule, where the official parser's recovery
/// stops skipping.
type Tokens = u16;
const FUNCTION: Tokens = 1;
const ALLOW: Tokens = 1 << 1;
const MATCH: Tokens = 1 << 2;
const SERVICE: Tokens = 1 << 3;
const IMPORT: Tokens = 1 << 4;
const LET: Tokens = 1 << 5;
const RETURN: Tokens = 1 << 6;
const OPEN: Tokens = 1 << 7;
const CLOSE: Tokens = 1 << 8;
/// `/` or a path segment: where a path, and so a match without its keyword,
/// starts.
const PATH: Tokens = 1 << 9;
const SEMICOLON: Tokens = 1 << 10;
const END: Tokens = 1 << 11;

/// What may start a declaration of a service block, and of a match block.
const SERVICE_DECLARATION: Tokens = FUNCTION | MATCH | PATH;
const MATCH_DECLARATION: Tokens = FUNCTION | ALLOW | MATCH | PATH;

/// What may follow a rule where it is used: the tokens, and whether the rule
/// using it may end there, so that what follows that rule may come too.
#[derive(Clone, Copy)]
struct Follow {
    tokens: Tokens,
    nullable: bool,
}

/// A function or a service at the top of the ruleset.
const TOP_LEVEL: Follow = Follow {
    tokens: FUNCTION | SERVICE | END,
    nullable: false,
};
/// `rules_version`.
const AFTER_VERSION: Follow = Follow {
    tokens: FUNCTION | IMPORT | SERVICE,
    nullable: false,
};
/// A declaration in a service block.
const IN_SERVICE: Follow = Follow {
    tokens: SERVICE_DECLARATION | CLOSE,
    nullable: false,
};
/// A declaration in a match block.
const IN_MATCH: Follow = Follow {
    tokens: MATCH_DECLARATION | CLOSE,
    nullable: false,
};
/// A function's body.
const IN_FUNCTION: Follow = Follow {
    tokens: CLOSE,
    nullable: false,
};
/// A let in a function's body.
const IN_BODY: Follow = Follow {
    tokens: LET | RETURN,
    nullable: false,
};
/// An allow's condition and a function's result, which a `;` may end.
const STATEMENT: Follow = Follow {
    tokens: SEMICOLON,
    nullable: true,
};
/// A let's value, which a `;` ends.
const LET_VALUE: Follow = Follow {
    tokens: SEMICOLON,
    nullable: false,
};
/// A match path.
const IN_PATH: Follow = Follow {
    tokens: OPEN,
    nullable: false,
};

/// Where in the grammar the official parser reported an error. Its recovery
/// skips a token when it recovers twice at the same token in the same state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum State {
    Version,
    Service,
    ServiceClose,
    Function,
    Parameters,
    FunctionOpen,
    FunctionBody,
    Return,
    FunctionClose,
    Let,
    Allow,
    Match,
    MatchOpen,
    MatchClose,
    Segment,
    Expression,
}

/// Why a rule did not finish.
enum Failure {
    /// A syntax error the official parser reports and recovers from in the
    /// rule it is in.
    Syntax(ParseError, State),
    /// What ends the parse: a token Firenook could not read, or a source
    /// nested deeper than the parser goes.
    Fatal(ParseError),
}

type Parsed<T> = Result<T, Failure>;

/// The official alternatives of a function declaration, which the official
/// parser chooses between by looking ahead: in full, with no body, with no
/// parameter list, with no name.
#[derive(Clone, Copy, Eq, PartialEq)]
enum FunctionForm {
    Full,
    NoBody,
    NoSignature,
    NoName,
}

/// The official alternatives of a match path's segment after a `/`: a
/// wildcard (`{name}`, `{name=**}`, `{name=*}`), each also closed twice, or
/// the `/` alone.
#[derive(Clone, Copy, Eq, PartialEq)]
enum SegmentForm {
    Wildcard {
        star: Option<Star>,
        closed_twice: bool,
    },
    Slash,
}

/// A wildcard's `=**` or `=*`.
#[derive(Clone, Copy, Eq, PartialEq)]
enum Star {
    Double,
    Single,
}

/// A token as the official grammar of a match path sees it.
#[derive(Clone, Copy, Eq, PartialEq)]
enum PathToken {
    /// `/` and a segment, one token.
    Segment,
    Slash,
    Open,
    Close,
    Name,
    Assign,
    Star,
    Other,
}

/// A function's body as parsed: its lets, where each let's name is, and its
/// result.
type Body = (Vec<(String, Expr)>, Vec<usize>, Expr);

/// A service block as parsed.
struct Service {
    kind: crate::RulesService,
    name: String,
    name_span: Range<usize>,
    functions: BTreeMap<String, Function>,
    matches: Vec<MatchBlock>,
}

/// Parses a ruleset. A source that does not parse is answered with its
/// syntax errors in source order, worded as the official emulator's parser
/// words them where a recording shows it (see "Rules compile errors" in
/// DESIGN.md). One that parses is answered with the characters its lexer
/// skipped, if any, then with what Firenook refuses in it (a package name as
/// a binding, a duplicate, a version it does not serve).
#[cfg(test)]
pub(crate) fn parse(source: &str) -> Result<Program, Vec<ParseError>> {
    let (program, refused) = parse_program(source)?;
    if refused.is_empty() {
        Ok(program)
    } else {
        Err(refused)
    }
}

/// [`parse`]'s program, with what Firenook refuses in it rather than in
/// place of it, so that the official compiler's warnings can be answered
/// beside the refusal.
pub(crate) fn parse_program(source: &str) -> Result<(Program, Vec<ParseError>), Vec<ParseError>> {
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
    if let Err(error) = &program {
        reported.push(error.clone());
    }
    // The official emulator answers its parser's errors in source order,
    // not in the order its recovery came to them (braces/match-open-missing),
    // and those at one place in the order of their text (eof/after-allow,
    // strings/newline-inside).
    reported
        .sort_by(|left, right| (left.offset, &left.message).cmp(&(right.offset, &right.message)));
    match program {
        Err(_) => Err(reported),
        Ok(_) if !reported.is_empty() => Err(reported),
        Ok(_) if !skipped.is_empty() => Err(skipped),
        Ok(program) => Ok((program, semantic)),
    }
}

struct Parser<'s> {
    source: &'s str,
    tokens: Vec<Token>,
    index: usize,
    line_starts: Vec<usize>,
    /// Wildcard names bound by the match blocks currently being parsed.
    scope: Vec<String>,
    /// Syntax errors the official parser reports.
    reported: Vec<ParseError>,
    /// Characters the lexer skipped.
    skipped: Vec<ParseError>,
    /// What Firenook refuses in a source that parses.
    semantic: Vec<ParseError>,
    /// Where each expression being parsed starts, outermost first.
    expression_starts: Vec<usize>,
    /// How many match blocks are open.
    open_matches: usize,
    /// What may follow each rule being parsed, outermost first.
    follows: Vec<Follow>,
    /// The official parser's error recovery mode: after an error, until a
    /// token is matched, it reports no other error but the grammar's own
    /// messages, and does not check what comes before a loop goes on.
    recovering: bool,
    /// The token where the official parser last recovered.
    last_recovery: Option<usize>,
    /// The states it recovered in since a token was last matched.
    recovery_states: Vec<State>,
    /// What the official parser expects where a token it matches is missing,
    /// if not that token: the set at the first place, since its lookahead
    /// last fitted, where a rule could end and the token did not fit there.
    stale: Option<&'static str>,
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
            follows: Vec::new(),
            recovering: false,
            last_recovery: None,
            recovery_states: Vec::new(),
            stale: None,
        }
    }

    fn take_skipped(&mut self, skipped: Vec<LexError>, base: usize) {
        self.skipped
            .extend(skipped.into_iter().map(|error| ParseError {
                message: error.message,
                offset: base + error.offset,
            }));
    }

    /// The ruleset, the official grammar's top rule. A syntax error in the
    /// rule itself ends it: nothing follows the top rule, so the official
    /// parser skips the rest of the source.
    fn program(&mut self) -> Result<Program, ParseError> {
        match self.ruleset() {
            Ok(program) => Ok(program),
            Err(Failure::Fatal(error)) => Err(error),
            Err(Failure::Syntax(error, _)) => {
                self.report_error(error);
                Ok(Program {
                    service: crate::RulesService::CloudFirestore,
                    service_name: (String::new(), 0..0),
                    rules_version: 2,
                    functions: BTreeMap::new(),
                    matches: Vec::new(),
                })
            }
        }
    }

    fn ruleset(&mut self) -> Parsed<Program> {
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
            declared_version = true;
            version = self.rule(AFTER_VERSION, Self::version)?.flatten();
            self.entry(RULESET_ITEM, starts_item)?;
        }
        if self.check_identifier("import") {
            // The official grammar takes imports; Firenook serves none.
            return Err(self.fail_here("expected \"service\""));
        }
        // Functions may also be declared outside the service block, before
        // or after it, and the official parser takes more than one service
        // block (top/two-services).
        let mut top_level = BTreeMap::new();
        let mut service = None;
        loop {
            if self.check_identifier("function") {
                if let Some((name, function)) = self.rule(TOP_LEVEL, Self::function)? {
                    self.declare(&mut top_level, name, function);
                }
            } else {
                let offset = self.current().offset;
                if let Some(parsed) = self.rule(TOP_LEVEL, Self::service)? {
                    if service.is_none() {
                        service = Some(parsed);
                    } else {
                        // Firenook serves one.
                        self.semantic_at(offset, "expected end of rules source");
                    }
                }
            }
            // After an item anything but another or the end is unwanted,
            // and skipped to one (top/word-after, top/word-after-function,
            // version/after-service, eof/in-block-comment).
            if !self.recovering && !self.at(TOP_LEVEL.tokens) {
                self.report_unwanted()?;
                self.consume_until(TOP_LEVEL.tokens);
            }
            if !self.at(FUNCTION | SERVICE) {
                break;
            }
        }
        if !self.check(&TokenKind::Eof) {
            self.end()?;
        }
        let Some(Service {
            kind: service,
            name,
            name_span,
            functions,
            matches,
        }) = service
        else {
            let offset = self.current().offset;
            self.semantic_at(offset, "expected \"service\"");
            return Ok(Program {
                service: crate::RulesService::CloudFirestore,
                service_name: (String::new(), offset..offset),
                rules_version: 2,
                functions: top_level,
                matches: Vec::new(),
            });
        };
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
                self.semantic_at(
                    name_span.start,
                    "expected rules_version = '2' before service",
                );
                2
            }
        };
        if matches.is_empty() {
            let offset = self.previous_offset();
            self.semantic_at(offset, "service must contain at least one match");
        }
        // A function in the service block shadows a top-level one of the
        // same name.
        top_level.extend(functions);
        Ok(Program {
            service,
            service_name: (name, name_span),
            rules_version,
            functions: top_level,
            matches,
        })
    }

    /// The end of the source, where something else is: the official parser
    /// skips one unwanted token before it, or reports what is there.
    #[cold]
    fn end(&mut self) -> Parsed<()> {
        if matches!(self.next().kind, TokenKind::Eof) {
            self.skip_unexpected()?;
            return Ok(());
        }
        Err(self.mismatched_here("<EOF>", State::Expression))
    }

    /// `rules_version`, its `=` and its version string, and where that is.
    fn version(&mut self) -> Parsed<Option<(String, usize)>> {
        self.advance();
        self.match_token(&TokenKind::Assign, "'='", |kind| {
            matches!(kind, TokenKind::String(_))
        })?;
        let version = self.version_string()?;
        // The official `firebase init` templates write `rules_version='2'`
        // without a semicolon and the official runtime accepts it.
        self.consume(&TokenKind::Semicolon);
        Ok(version)
    }

    /// The version string after `rules_version =`, and where it is. The
    /// official parser's match of a `STRING`: an unwanted token before it is
    /// skipped, one missing before `;` or what starts a ruleset is supplied
    /// (version/value-missing), anything else is mismatched (version/number,
    /// version/unterminated).
    fn version_string(&mut self) -> Parsed<Option<(String, usize)>> {
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
        Err(self.mismatched_here("STRING", State::Version))
    }

    /// A service block. The official parser chooses between a block with
    /// declarations and an empty one by looking ahead to the first token in
    /// it, and reports the first token neither may have as unwanted
    /// (braces/service-open-missing, braces/service-body-word,
    /// top/service-name-missing, eof/after-service, eof/in-service).
    fn service(&mut self) -> Parsed<Service> {
        let empty = self
            .predict_service()
            .map_err(|at| self.no_viable_alternative(at, State::Service))?;
        self.advance();
        let name_token = self.advance().clone();
        let TokenKind::ServiceName(name) = name_token.kind else {
            unreachable!("the prediction saw the service's name");
        };
        let name_span = name_token.offset..name_token.end_offset;
        // The official parser takes any name, and the official compiler a
        // service it does not know with a warning, its rules then governing
        // nothing (top/service-name-misspelled; see `crate::issues`).
        let service = if name == "firebase.storage" {
            crate::RulesService::FirebaseStorage
        } else {
            crate::RulesService::CloudFirestore
        };
        self.advance();
        let mut functions = BTreeMap::new();
        let mut matches = Vec::new();
        if empty {
            self.notify_here("The 'service' body must contain at least one declaration.")?;
            self.advance();
            return Ok(Service {
                kind: service,
                name,
                name_span,
                functions,
                matches,
            });
        }
        // The block's first declaration, which the lookahead saw.
        self.declarations_start();
        loop {
            if self.check_identifier("function") {
                if let Some((name, function)) = self.rule(IN_SERVICE, Self::function)? {
                    self.declare(&mut functions, name, function);
                }
            } else if let Some(block) = self.rule(IN_SERVICE, Self::match_block)? {
                matches.push(block);
            }
            // braces/service-body-allow, braces/service-close-missing
            self.declarations_go_on(SERVICE_DECLARATION)?;
            if !self.at(SERVICE_DECLARATION) {
                break;
            }
        }
        self.close(State::ServiceClose)?;
        Ok(Service {
            kind: service,
            name,
            name_span,
            functions,
            matches,
        })
    }

    /// Where a block's declarations start, at one: the official parser's
    /// check before its loop sees what it expects.
    fn declarations_start(&mut self) {
        if !self.recovering {
            self.stale = None;
        }
    }

    /// Where a service's or match's declaration may follow another: the
    /// official parser's check before its loop goes on. Anything but another
    /// declaration or the block's `}` is unwanted, and skipped to one of them
    /// or to what may follow a rule being parsed.
    fn declarations_go_on(&mut self, starts: Tokens) -> Parsed<()> {
        if self.recovering {
            return Ok(());
        }
        if self.at(starts | CLOSE) {
            self.stale = None;
            return Ok(());
        }
        self.report_unwanted()?;
        let until = starts | CLOSE | self.recovery_set();
        self.consume_until(until);
        Ok(())
    }

    fn declare(
        &mut self,
        functions: &mut BTreeMap<String, Function>,
        name: String,
        function: Function,
    ) {
        if functions.contains_key(&name) {
            let offset = self.previous_offset();
            self.semantic_at(
                offset,
                format!("function {name:?} is declared more than once"),
            );
        }
        functions.insert(name, function);
    }

    fn match_block(&mut self) -> Parsed<MatchBlock> {
        if self.open_matches == MAXIMUM_MATCH_NESTING {
            return Err(Failure::Fatal(self.error(format!(
                "match blocks are nested more than {MAXIMUM_MATCH_NESTING} deep"
            ))));
        }
        self.open_matches += 1;
        let scope_depth = self.scope.len();
        let block = self.match_block_within();
        self.scope.truncate(scope_depth);
        self.open_matches -= 1;
        block
    }

    /// A match block. The official parser chooses between a block with
    /// declarations and an empty one by looking ahead through the path to
    /// the first token in the block, and reports the first token neither may
    /// have as unwanted (keywords/alow, paths/missing). A path with no
    /// `match` before it is a match block missing its keyword, which the
    /// official grammar takes with an empty block (keywords/fucntion,
    /// paths/leading-slash-missing).
    fn match_block_within(&mut self) -> Parsed<MatchBlock> {
        let header_start = self.current().offset;
        if !self.check_identifier("match") {
            self.split_path();
            self.notify_here("Missing 'match' keyword before path.")?;
            self.rule(IN_PATH, Self::match_path)?;
            let header = header_start..self.previous_end();
            self.match_token_in(
                |kind| matches!(kind, TokenKind::LeftBrace),
                "'{'",
                |kind| matches!(kind, TokenKind::RightBrace),
                State::MatchOpen,
            )?;
            self.close(State::MatchClose)?;
            return Ok(MatchBlock {
                header,
                pattern: Vec::new(),
                functions: BTreeMap::new(),
                allows: Vec::new(),
                children: Vec::new(),
            });
        }
        let empty = self
            .predict_match()
            .map_err(|at| self.no_viable_alternative(at, State::Match))?;
        self.advance();
        let pattern = self.rule(IN_PATH, Self::match_path)?.unwrap_or_default();
        let header = header_start..self.previous_end();
        for segment in &pattern {
            if let PatternSegment::Wildcard(name) | PatternSegment::RecursiveWildcard(name) =
                segment
            {
                self.scope.push(name.clone());
            }
        }
        self.match_token_in(
            |kind| matches!(kind, TokenKind::LeftBrace),
            "'{'",
            |kind| tokens(kind) & (MATCH_DECLARATION | CLOSE) != 0,
            State::MatchOpen,
        )?;
        let mut functions = BTreeMap::new();
        let mut allows = Vec::new();
        let mut children = Vec::new();
        if empty {
            // At the `}` (top/two-services, paths/wildcard-empty).
            self.notify_here("The 'match' body must contain at least one declaration.")?;
        } else {
            self.declarations_start();
            loop {
                if self.check_identifier("function") {
                    if let Some((name, function)) = self.rule(IN_MATCH, Self::function)? {
                        self.declare(&mut functions, name, function);
                    }
                } else if self.check_identifier("allow") {
                    if let Some(allow) = self.rule(IN_MATCH, Self::allow)? {
                        allows.push(allow);
                    }
                } else if let Some(child) = self.rule(IN_MATCH, Self::match_block)? {
                    children.push(child);
                }
                // semicolons/allow-doubled, conditions/single-equals,
                // eof/after-declaration
                self.declarations_go_on(MATCH_DECLARATION)?;
                if !self.at(MATCH_DECLARATION) {
                    break;
                }
            }
        }
        self.close(State::MatchClose)?;
        Ok(MatchBlock {
            header,
            pattern,
            functions,
            allows,
            children,
        })
    }

    /// A match path's segments, from its first. The official parser reports
    /// a `/` with no segment after it, at the `/`, and goes on
    /// (paths/trailing-slash, paths/wildcard-empty); a wildcard closed twice
    /// it reports at the second `}`; two globs it refuses once the source
    /// parses (production-parse-errors invalid-recursive-wildcard).
    fn match_path(&mut self) -> Parsed<Vec<PatternSegment>> {
        let mut recursive_wildcards = 0_usize;
        let mut pattern = Vec::new();
        loop {
            self.split_path();
            if let Some((text, width)) = self.segment_at(self.index) {
                for _ in 0..width {
                    self.advance();
                }
                pattern.push(PatternSegment::Literal(text));
            } else {
                let form = self
                    .predict_segment()
                    .map_err(|at| self.no_viable_alternative(at, State::Segment))?;
                let slash = self.current().offset;
                self.advance();
                if let SegmentForm::Wildcard { star, closed_twice } = form {
                    self.advance();
                    let name_offset = self.current().offset;
                    let TokenKind::Identifier(name) = self.advance().kind.clone() else {
                        unreachable!("the prediction saw the wildcard's name");
                    };
                    if star.is_some() {
                        self.advance();
                        self.advance();
                    }
                    self.advance();
                    if closed_twice {
                        // The official message, misspelled after `=**`.
                        self.notify_here(if star == Some(Star::Double) {
                            "Exra closing '}' in path."
                        } else {
                            "Extra closing '}' in path."
                        })?;
                        self.advance();
                    }
                    self.binding(&name, name_offset);
                    pattern.push(match star {
                        Some(Star::Double) => {
                            recursive_wildcards += 1;
                            if recursive_wildcards == 2 {
                                self.semantic_at(
                                    slash,
                                    "Invalid glob match expression. Only one glob match is permitted in a match declaration path.",
                                );
                            }
                            PatternSegment::RecursiveWildcard(name)
                        }
                        // As Firenook read `{name=*}` before.
                        Some(Star::Single) => PatternSegment::Wildcard(format!("{name}=*")),
                        None => PatternSegment::Wildcard(name),
                    });
                } else {
                    self.notify_at(
                        slash,
                        "Forward slash '/' found where identifier or binding expected.",
                    );
                }
            }
            // The official parser's check before its loop goes on: a path
            // could end here, so what it expects past the path is what
            // decides a missing `{` (braces/match-open-missing).
            let goes_on = self.at(PATH);
            if !self.recovering {
                if goes_on {
                    self.stale = None;
                } else {
                    self.stale.get_or_insert(MATCH_PATH);
                }
            }
            if !goes_on {
                break;
            }
        }
        Ok(pattern)
    }

    /// A function declaration. The official parser chooses between its
    /// forms by looking ahead to the first token in the body, and reports the
    /// first token none may have as unwanted (braces/function-open-missing,
    /// parens/parameters-close-missing, functions/parameter-comma-missing,
    /// functions/return-missing, keywords/retrun, eof/in-function).
    fn function(&mut self) -> Parsed<(String, Function)> {
        let form = self
            .predict_function()
            .map_err(|at| self.no_viable_alternative(at, State::Function))?;
        self.advance();
        let (name, name_start) = if form == FunctionForm::NoName {
            // functions/name-missing
            self.notify_here("Missing 'function' id")?;
            (String::new(), self.current().offset)
        } else {
            let offset = self.current().offset;
            let TokenKind::Identifier(name) = self.advance().kind.clone() else {
                unreachable!("the prediction saw the function's name");
            };
            (name, offset)
        };
        let (parameters, parameter_starts) = if form == FunctionForm::NoSignature {
            // parens/parameters-missing
            self.notify_here("Missing 'function' signature")?;
            (Vec::new(), Vec::new())
        } else {
            self.parameters()?
        };
        self.match_token_in(
            |kind| matches!(kind, TokenKind::LeftBrace),
            "'{'",
            |kind| tokens(kind) & (LET | RETURN) != 0,
            State::FunctionOpen,
        )?;
        let body_start = self.current().offset;
        if form == FunctionForm::NoBody {
            // functions/body-empty
            self.notify_here("Missing 'function' body")?;
            self.advance();
            return Ok((
                name,
                Function {
                    name_start,
                    body_start,
                    scope: self.scope.clone(),
                    parameters,
                    parameter_starts,
                    lets: Vec::new(),
                    let_starts: Vec::new(),
                    result: Expr::new(ExprKind::Bool(false), body_start, body_start),
                },
            ));
        }
        let (lets, let_starts, result) = self
            .rule(IN_FUNCTION, Self::function_body)?
            .unwrap_or_else(|| {
                (
                    Vec::new(),
                    Vec::new(),
                    Expr::new(ExprKind::Bool(false), body_start, body_start),
                )
            });
        // functions/two-returns, braces/function-close-missing
        self.close(State::FunctionClose)?;
        Ok((
            name,
            Function {
                name_start,
                body_start,
                scope: self.scope.clone(),
                parameters,
                parameter_starts,
                lets,
                let_starts,
                result,
            },
        ))
    }

    /// A function's parameter list, from its `(`. Where the official parser
    /// did not look ahead through it (a function with no name), a token
    /// before a name or `)` that does not fit is skipped as unwanted. The
    /// official grammar takes a second `)` after the list, and reports it.
    fn parameters(&mut self) -> Parsed<(Vec<String>, Vec<usize>)> {
        let goes_on = |kind: &TokenKind, separator: bool| match kind {
            TokenKind::Identifier(name) => !separator && is_name(name),
            TokenKind::Comma => separator,
            TokenKind::RightParen => true,
            _ => false,
        };
        let mut parameters = Vec::new();
        let mut starts = Vec::new();
        self.advance();
        let mut separator = false;
        loop {
            if !self.recovering
                && !goes_on(&self.current().kind, separator)
                && goes_on(&self.next().kind, separator)
            {
                self.skip_unexpected()?;
            }
            match self.current().kind.clone() {
                TokenKind::RightParen => break,
                TokenKind::Comma if separator => {
                    self.advance();
                    separator = false;
                }
                TokenKind::Identifier(parameter) if !separator && is_name(&parameter) => {
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
                    starts.push(offset);
                    separator = true;
                }
                _ => return Err(self.unexpected_here(State::Parameters)),
            }
        }
        self.advance();
        if self.check(&TokenKind::RightParen) {
            self.notify_here("Extra closing ')' at the end of parameter list.")?;
            self.advance();
        }
        Ok((parameters, starts))
    }

    /// A function's body: its lets, where their names are, and its result.
    fn function_body(&mut self) -> Parsed<Body> {
        // Before the lets: an unwanted token is skipped, anything else is
        // mismatched.
        if !self.recovering {
            if self.at(LET | RETURN) {
                self.stale = None;
            } else if tokens(&self.next().kind) & (LET | RETURN) != 0 {
                self.skip_unexpected()?;
            } else {
                return Err(self.mismatched_here(FUNCTION_BODY, State::FunctionBody));
            }
        }
        let mut lets = Vec::new();
        let mut starts = Vec::new();
        let mut names = BTreeSet::new();
        while self.check_identifier("let") {
            if let Some((binding, offset, value)) = self.rule(IN_BODY, Self::let_statement)? {
                if !names.insert(binding.clone()) {
                    // Worded as production and the official emulator word it
                    // (rules-v2 production-parse-errors duplicate-let).
                    self.semantic_at(
                        offset,
                        format!(
                            "The identifier [{binding}] is already bound in the current scope."
                        ),
                    );
                }
                lets.push((binding, value));
                starts.push(offset);
            }
            // After a let anything but another or the return is unwanted, and
            // skipped to one of them or to what may follow a rule being
            // parsed (let/then-word).
            if !self.recovering {
                if self.at(LET | RETURN) {
                    self.stale = None;
                } else {
                    self.report_unwanted()?;
                    let until = LET | RETURN | self.recovery_set();
                    self.consume_until(until);
                }
            }
        }
        // let/without-return, let/then-word
        self.match_token_in(
            |kind| is_word(kind, "return"),
            "'return'",
            starts_expression,
            State::Return,
        )?;
        let start = self.current().offset;
        let result = self
            .operand_of(STATEMENT, |parser| parser.operand(0))?
            .unwrap_or_else(|| Expr::new(ExprKind::Bool(false), start, start));
        // The official emulator and production accept a return without `;`.
        if self.check(&TokenKind::Semicolon) {
            if !self.recovering {
                self.stale = None;
            }
            self.advance();
        } else if !self.recovering {
            self.stale.get_or_insert(AFTER_RESULT);
        }
        Ok((lets, starts, result))
    }

    /// A let: its name, where that is, and its value.
    fn let_statement(&mut self) -> Parsed<(String, usize, Expr)> {
        self.advance();
        // An unwanted token before the name is skipped (let/name-missing),
        // and a name missing before `=` is supplied.
        if !matches!(self.current().kind, TokenKind::Identifier(_))
            && matches!(self.next().kind, TokenKind::Identifier(_))
        {
            self.skip_unexpected()?;
        }
        let offset = self.current().offset;
        let binding = match self.current().kind.clone() {
            TokenKind::Identifier(binding) if is_name(&binding) => {
                self.advance();
                binding
            }
            TokenKind::Assign => {
                self.report_missing("IDENTIFIER")?;
                String::new()
            }
            _ => return Err(self.mismatched_here("IDENTIFIER", State::Let)),
        };
        self.binding(&binding, offset);
        // let/equals-missing
        self.match_token(&TokenKind::Assign, "'='", starts_expression)?;
        let start = self.current().offset;
        let value = self
            .operand_of(LET_VALUE, |parser| parser.operand(0))?
            .unwrap_or_else(|| Expr::new(ExprKind::Bool(false), start, start));
        if !self.recovering {
            self.stale.get_or_insert(AFTER_LET);
        }
        // Supplied before the next statement (semicolons/let-missing).
        self.match_token_in(
            |kind| matches!(kind, TokenKind::Semicolon),
            "';'",
            |kind| tokens(kind) & (LET | RETURN) != 0,
            State::Let,
        )?;
        Ok((binding, offset, value))
    }

    fn allow(&mut self) -> Parsed<Allow> {
        self.advance();
        let byte_offset = self.previous_offset();
        let location = crate::AllowLocation {
            line: self
                .line_starts
                .partition_point(|start| *start <= byte_offset),
            byte_offset,
        };
        if !matches!(&self.current().kind, TokenKind::Identifier(method) if is_name(method)) {
            // Reported at the next token, where the allow ends
            // (conditions/method-missing, eof/after-allow); a keyword is not
            // a method.
            self.notify_here("Expected at least one 'operation' after 'allow'.")?;
            let end = self.previous_end();
            return Ok(Allow {
                location,
                statement: byte_offset..end,
                condition_span: end..end,
                methods: Vec::new(),
                operations: Vec::new(),
                condition: Expr::new(ExprKind::Bool(false), end, end),
            });
        }
        let mut methods = Vec::new();
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
                // The official compiler takes it with a warning, and it
                // grants nothing (conditions/method-unknown; see
                // `crate::issues`).
                _ => &[],
            };
            methods.push((method, self.previous_offset()));
            for operation in expanded {
                if !operations.contains(operation) {
                    operations.push(*operation);
                }
            }
            // An allow could end after its methods (eof/after-method).
            if !self.recovering {
                if matches!(
                    self.current().kind,
                    TokenKind::Comma | TokenKind::Colon | TokenKind::Semicolon
                ) || self.check_identifier("if")
                {
                    self.stale = None;
                } else {
                    self.stale.get_or_insert(AFTER_METHODS);
                }
            }
            if !self.consume(&TokenKind::Comma) {
                break;
            }
        }
        let end = self.previous_end();
        let (condition, condition_span) =
            if self.check(&TokenKind::Colon) || self.check_identifier("if") {
                self.rule(STATEMENT, Self::allow_condition)?
                    .unwrap_or_else(|| (Expr::new(ExprKind::Bool(false), end, end), end..end))
            } else {
                // `allow read, write;` (no condition) is an unconditional grant:
                // the official `templates/emulators/default_storage.rules` and
                // the Firebase rules reference both use it.
                (Expr::new(ExprKind::Bool(true), end, end), end..end)
            };
        // The official parser takes an allow without its `;`, before another
        // declaration as at the end of its block
        // (developer-tools-compile-errors-v1 semicolons/allow-missing,
        // storage-rules-v1 set-rules-missing-semicolon-accepted).
        if self.check(&TokenKind::Semicolon) {
            if !self.recovering {
                self.stale = None;
            }
            self.advance();
        }
        let allow = Allow {
            location,
            statement: byte_offset..self.previous_end(),
            condition_span,
            methods,
            operations,
            condition,
        };
        Ok(allow)
    }

    /// An allow's condition, from its `:` or `if`: a rule of the official
    /// grammar's, which a token none of its forms takes ends, recovered to
    /// its `;` (conditions/colon-alone).
    fn allow_condition(&mut self) -> Parsed<(Expr, Range<usize>)> {
        if self.consume(&TokenKind::Colon) {
            if self.check_identifier("if") {
                self.advance();
                self.condition()
            } else if starts_expression(&self.current().kind) {
                // conditions/if-missing
                self.notify_here("Missing 'if' before conditional expression.")?;
                self.condition_expression()
            } else {
                Err(self.unexpected_here(State::Allow))
            }
        } else {
            // conditions/colon-missing
            self.notify_here("Missing ':' before 'if' condition.")?;
            self.advance();
            self.condition()
        }
    }

    /// The condition after `if`. A token no expression starts with is
    /// reported there, and the allow goes on without a condition
    /// (conditions/if-*, conditions/bad-character-at, eof/after-if).
    fn condition(&mut self) -> Parsed<(Expr, Range<usize>)> {
        if !starts_expression(&self.current().kind) {
            self.notify_here("Missing conditional expression after 'if'.")?;
            if !self.recovering && !self.check(&TokenKind::Semicolon) {
                self.stale.get_or_insert(AFTER_MISSING_CONDITION);
            }
            let end = self.previous_end();
            return Ok((Expr::new(ExprKind::Bool(false), end, end), end..end));
        }
        self.condition_expression()
    }

    fn condition_expression(&mut self) -> Parsed<(Expr, Range<usize>)> {
        let start = self.current().offset;
        let condition = self
            .operand_of(STATEMENT, |parser| parser.expression(0))?
            .unwrap_or_else(|| Expr::new(ExprKind::Bool(false), start, start));
        // A condition could end here (eof/after-condition, eof/in-string).
        if !self.recovering {
            self.stale.get_or_insert(AFTER_CONDITION);
        }
        Ok((condition, start..self.previous_end()))
    }

    /// An expression a statement holds: the official parser parses it as a
    /// rule of its own, which recovers from an error in it to what may
    /// follow it.
    fn operand_of(
        &mut self,
        follow: Follow,
        parse: impl FnOnce(&mut Self) -> Parsed<Expr>,
    ) -> Parsed<Option<Expr>> {
        if !self.recovering && starts_expression(&self.current().kind) {
            self.stale = None;
        }
        self.rule(follow, parse)
    }

    /// The official parser's lookahead at a service: whether its block is
    /// empty, or the token where no form fits.
    fn predict_service(&self) -> Result<bool, usize> {
        let at = self.index;
        if !matches!(self.kind_at(at + 1), TokenKind::ServiceName(_)) {
            return Err(at + 1);
        }
        if !matches!(self.kind_at(at + 2), TokenKind::LeftBrace) {
            return Err(at + 2);
        }
        let first = self.kind_at(at + 3);
        if tokens(first) & SERVICE_DECLARATION != 0 {
            Ok(false)
        } else if matches!(first, TokenKind::RightBrace) {
            Ok(true)
        } else {
            Err(at + 3)
        }
    }

    /// The official parser's lookahead at a function: its form, or the
    /// token where none fits.
    fn predict_function(&self) -> Result<FunctionForm, usize> {
        let mut at = self.index + 1;
        match self.kind_at(at) {
            TokenKind::Identifier(name) if is_name(name) => {}
            TokenKind::LeftParen => return Ok(FunctionForm::NoName),
            _ => return Err(at),
        }
        at += 1;
        match self.kind_at(at) {
            TokenKind::LeftParen => {}
            TokenKind::LeftBrace => return Ok(FunctionForm::NoSignature),
            _ => return Err(at),
        }
        at += 1;
        if !matches!(self.kind_at(at), TokenKind::RightParen) {
            loop {
                if !matches!(self.kind_at(at), TokenKind::Identifier(name) if is_name(name)) {
                    return Err(at);
                }
                at += 1;
                match self.kind_at(at) {
                    TokenKind::RightParen => break,
                    TokenKind::Comma => at += 1,
                    _ => return Err(at),
                }
            }
        }
        at += 1;
        if matches!(self.kind_at(at), TokenKind::RightParen) {
            at += 1;
        }
        if !matches!(self.kind_at(at), TokenKind::LeftBrace) {
            return Err(at);
        }
        at += 1;
        match self.kind_at(at) {
            kind if tokens(kind) & (LET | RETURN) != 0 => Ok(FunctionForm::Full),
            TokenKind::RightBrace => Ok(FunctionForm::NoBody),
            _ => Err(at),
        }
    }

    /// The official parser's lookahead at `match`: whether its block is
    /// empty, or the token where no reading of the path fits. Every reading
    /// is followed at once: a `/` is a segment of its own or a wildcard's
    /// start, and a wildcard's `}` may be closed again.
    fn predict_match(&self) -> Result<bool, usize> {
        const START: u16 = 1;
        const SEGMENT: u16 = 1 << 1;
        const SLASH: u16 = 1 << 2;
        const OPEN: u16 = 1 << 3;
        const NAME: u16 = 1 << 4;
        const ASSIGN: u16 = 1 << 5;
        const STAR: u16 = 1 << 6;
        const CLOSED: u16 = 1 << 7;
        const BLOCK: u16 = 1 << 8;
        let mut states = START;
        let mut at = self.index + 1;
        loop {
            if states & BLOCK != 0 {
                let kind = self.kind_at(at);
                if tokens(kind) & MATCH_DECLARATION != 0 {
                    return Ok(false);
                }
                if matches!(kind, TokenKind::RightBrace) {
                    return Ok(true);
                }
            }
            let (token, width) = self.path_token(at);
            let mut next = 0;
            match token {
                PathToken::Segment if states & (START | SEGMENT) != 0 => next = SEGMENT,
                PathToken::Slash if states & (START | SEGMENT) != 0 => next = SEGMENT | SLASH,
                PathToken::Open => {
                    if states & SEGMENT != 0 {
                        next |= BLOCK;
                    }
                    if states & SLASH != 0 {
                        next |= OPEN;
                    }
                }
                PathToken::Name if states & OPEN != 0 => next = NAME,
                PathToken::Close => {
                    if states & (NAME | STAR) != 0 {
                        next |= SEGMENT | CLOSED;
                    }
                    if states & CLOSED != 0 {
                        next |= SEGMENT;
                    }
                }
                PathToken::Assign if states & NAME != 0 => next = ASSIGN,
                PathToken::Star if states & ASSIGN != 0 => next = STAR,
                _ => {}
            }
            if next == 0 {
                return Err(at);
            }
            states = next;
            at += width;
        }
    }

    /// The official parser's lookahead at a `/` in a match path: the form of
    /// its segment, or the token where none fits. The `/` alone is taken
    /// where nothing else fits sooner: the official parser takes the form
    /// that could have ended the path when every form fails at once
    /// (paths/interpolation, `/{=**}`), and reports the token only where a
    /// wildcard went further (`/{name other}`).
    fn predict_segment(&self) -> Result<SegmentForm, usize> {
        let open = self.index + 1;
        if self.path_token(open).0 != PathToken::Open
            || self.path_token(open + 1).0 != PathToken::Name
        {
            return Ok(SegmentForm::Slash);
        }
        let mut close = open + 2;
        let star = match self.path_token(close).0 {
            PathToken::Close => None,
            PathToken::Assign => {
                let star = match self.kind_at(close + 1) {
                    TokenKind::DoubleStar => Star::Double,
                    TokenKind::Star => Star::Single,
                    _ => return Err(close + 1),
                };
                close += 2;
                if self.path_token(close).0 != PathToken::Close {
                    return Err(close);
                }
                Some(star)
            }
            _ => return Err(close),
        };
        Ok(SegmentForm::Wildcard {
            star,
            closed_twice: self.path_token(close + 1).0 == PathToken::Close,
        })
    }

    /// The token at `index` as a match path's grammar sees it, and how many
    /// of Firenook's tokens it is.
    fn path_token(&self, index: usize) -> (PathToken, usize) {
        if let Some((_, width)) = self.segment_at(index) {
            return (PathToken::Segment, width);
        }
        let token = match self.kind_at(index) {
            TokenKind::Slash => PathToken::Slash,
            TokenKind::LeftBrace => PathToken::Open,
            TokenKind::RightBrace => PathToken::Close,
            TokenKind::Identifier(name) if is_name(name) => PathToken::Name,
            TokenKind::Assign => PathToken::Assign,
            TokenKind::DoubleStar | TokenKind::Star => PathToken::Star,
            _ => PathToken::Other,
        };
        (token, 1)
    }

    /// The segment at `index`, without its `/`, and how many of Firenook's
    /// tokens it is: a path segment, or a `/` Firenook read as division with
    /// what the official lexer reads into the segment right after it.
    fn segment_at(&self, index: usize) -> Option<(String, usize)> {
        let token = &self.tokens[index.min(self.tokens.len() - 1)];
        match &token.kind {
            TokenKind::Path(path) => Some((path[1..].to_owned(), 1)),
            TokenKind::Slash => {
                let run = token.end_offset + segment_length(&self.source[token.end_offset..]);
                let width = self.tokens[index + 1..]
                    .iter()
                    .take_while(|part| {
                        !matches!(part.kind, TokenKind::Eof) && part.end_offset <= run
                    })
                    .count();
                let end = self.tokens[index + width].end_offset;
                (width > 0 && end == run)
                    .then(|| (self.source[token.end_offset..end].to_owned(), width + 1))
            }
            _ => None,
        }
    }

    /// Where a path Firenook read as one token in an expression is where a
    /// match path is read, or where the official parser's recovery reads
    /// its parts: its tokens as the official lexer reads them in its place.
    fn split_path(&mut self) {
        if let Some(parts) = self.path_parts(self.index) {
            self.tokens.splice(self.index..=self.index, parts);
        }
    }

    /// The parts of the path at `index`, where it has more than one.
    fn path_parts(&self, index: usize) -> Option<Vec<Token>> {
        let token = &self.tokens[index];
        let TokenKind::Path(path) = &token.kind else {
            return None;
        };
        if segment_length(&path[1..]) == path.len() - 1 {
            return None;
        }
        Some(lex_match_path(self.source, token.offset, token.end_offset))
    }

    /// A rule of the official grammar where `follow` may come after it. A
    /// syntax error in it is reported, unless the official parser is already
    /// recovering, and it recovers to what may follow a rule being parsed;
    /// the rule then ends.
    fn rule<T>(
        &mut self,
        follow: Follow,
        parse: impl FnOnce(&mut Self) -> Parsed<T>,
    ) -> Parsed<Option<T>> {
        self.follows.push(follow);
        let parsed = match parse(self) {
            Ok(value) => Ok(Some(value)),
            Err(Failure::Syntax(error, state)) => {
                self.report_error(error);
                self.recover(state);
                Ok(None)
            }
            Err(fatal) => Err(fatal),
        };
        self.follows.pop();
        parsed
    }

    /// The official parser's recovery from a syntax error: skips to what may
    /// follow a rule being parsed. Recovering a second time at the same
    /// token in the same state, it first skips that token, so every
    /// recovery goes on.
    fn recover(&mut self, state: State) {
        if self.last_recovery == Some(self.index) && self.recovery_states.contains(&state) {
            self.skip();
        }
        self.last_recovery = Some(self.index);
        if !self.recovery_states.contains(&state) {
            self.recovery_states.push(state);
        }
        let until = self.recovery_set();
        self.consume_until(until);
    }

    /// Skips to the end of the source or to a token in `until`, which may be
    /// a part of a path Firenook read as one token.
    fn consume_until(&mut self, until: Tokens) {
        loop {
            let kind = &self.current().kind;
            if matches!(kind, TokenKind::Eof) || tokens(kind) & until != 0 {
                return;
            }
            if let Some(parts) = self.path_parts(self.index)
                && parts[1..]
                    .iter()
                    .any(|part| tokens(&part.kind) & until != 0)
            {
                self.tokens.splice(self.index..=self.index, parts);
            }
            self.skip();
        }
    }

    /// What may follow any rule being parsed.
    fn recovery_set(&self) -> Tokens {
        self.follows
            .iter()
            .fold(0, |tokens, follow| tokens | follow.tokens)
    }

    /// What may follow the rule being parsed where it ends.
    fn follow_after_rule(&self) -> Tokens {
        let mut tokens = 0;
        for follow in self.follows.iter().rev() {
            tokens |= follow.tokens;
            if !follow.nullable {
                break;
            }
        }
        tokens
    }

    /// The `}` that ends the rule being parsed.
    fn close(&mut self, state: State) -> Parsed<()> {
        let follows = self.follow_after_rule();
        self.match_token_in(
            |kind| matches!(kind, TokenKind::RightBrace),
            "'}'",
            |kind| tokens(kind) & follows != 0,
            state,
        )
    }

    /// An operand where the official parser expects an expression: after an
    /// operator, `return`, or a let's `=`. A token no expression starts with is
    /// skipped as unwanted when the next one starts one
    /// (conditions/triple-equals), and is otherwise mismatched.
    fn operand(&mut self, binding_power: u8) -> Parsed<Expr> {
        if !starts_expression(&self.current().kind) {
            if !self.recovering && starts_expression(&self.next().kind) {
                self.skip_unexpected()?;
            } else {
                return Err(self.mismatched_here(EXPRESSION, State::Expression));
            }
        }
        self.expression(binding_power)
    }

    fn expression(&mut self, minimum_binding_power: u8) -> Parsed<Expr> {
        if self.expression_starts.len() == MAXIMUM_EXPRESSION_NESTING {
            return Err(Failure::Fatal(ParseError {
                message: TOO_COMPLEX.to_owned(),
                offset: self.expression_starts[REFUSED_LEVEL - 1],
            }));
        }
        self.expression_starts.push(self.current().offset);
        let expression = self.expression_within(minimum_binding_power);
        self.expression_starts.pop();
        expression
    }

    fn expression_within(&mut self, minimum_binding_power: u8) -> Parsed<Expr> {
        let mut left = self.prefix()?;
        loop {
            let start = left.span.start;
            if 30 >= minimum_binding_power && self.consume(&TokenKind::Dot) {
                // After `.` anything but a name is unwanted
                // (conditions/trailing-dot).
                let TokenKind::Identifier(name) = self.current().kind.clone() else {
                    return Err(self.unexpected_here(State::Expression));
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
    fn type_name(&mut self) -> Parsed<TypeName> {
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
                self.notify_here(format!(
                    "An unsupported type identifier was used with the 'is' operator. Received {name}. Expected one of {OFFICIAL_TYPES}"
                ))?;
                TypeName::Null
            }
        })
    }

    fn prefix(&mut self) -> Parsed<Expr> {
        let token = self.advance().clone();
        let kind = match token.kind {
            TokenKind::Identifier(value) if value == "true" => ExprKind::Bool(true),
            TokenKind::Identifier(value) if value == "false" => ExprKind::Bool(false),
            TokenKind::Identifier(value) if value == "null" => ExprKind::Null,
            TokenKind::Identifier(value) if !is_keyword(&value) => ExprKind::Variable(value),
            TokenKind::String(value) => ExprKind::String(value),
            TokenKind::UnpairedQuote(quote) => {
                // Reported at the token after it, and taken as closed
                // (strings/*, eof/in-string).
                self.notify_here(format!("Missing a closing {quote}"))?;
                ExprKind::String(self.source[token.offset + 1..token.end_offset].to_owned())
            }
            TokenKind::Integer(value) => ExprKind::Integer(value),
            TokenKind::Float(value) => ExprKind::Float(value),
            TokenKind::Path(value) => self.expression_path(&value, token.offset)?,
            TokenKind::Bang => ExprKind::Unary {
                operator: UnaryOperator::Not,
                operand: Box::new(self.operand(20)?),
            },
            TokenKind::Minus => ExprKind::Unary {
                operator: UnaryOperator::Negate,
                operand: Box::new(self.operand(20)?),
            },
            TokenKind::LeftParen => {
                // After `(`, and after its expression, a token that does not
                // go on is unwanted (conditions/group-cut,
                // parens/condition-close-missing).
                if !starts_expression(&self.current().kind) {
                    return Err(self.unexpected_here(State::Expression));
                }
                let mut expression = self.expression(0)?;
                if !self.check(&TokenKind::RightParen) {
                    return Err(self.unexpected_here(State::Expression));
                }
                self.advance();
                // Coverage includes the opening grouping token, but not its
                // closing token. Keep the child expressions' own positions.
                expression.span.start = token.offset;
                return Ok(expression);
            }
            TokenKind::LeftBracket => self.list()?,
            TokenKind::LeftBrace => self.map()?,
            TokenKind::Invalid(error) => {
                return Err(Failure::Fatal(ParseError {
                    message: error.message,
                    offset: error.offset,
                }));
            }
            _ => {
                return Err(Failure::Syntax(
                    ParseError {
                        message: "expected a rules expression".to_owned(),
                        offset: token.offset,
                    },
                    State::Expression,
                ));
            }
        };
        Ok(Expr::new(kind, token.offset, self.previous_end()))
    }

    fn list(&mut self) -> Parsed<ExprKind> {
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

    fn map(&mut self) -> Parsed<ExprKind> {
        let mut entries = Vec::new();
        if !self.check(&TokenKind::RightBrace) {
            loop {
                let (TokenKind::String(key) | TokenKind::Identifier(key)) =
                    self.advance().kind.clone()
                else {
                    return Err(self.fail_at_previous("map keys must be strings"));
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

    fn arguments(&mut self) -> Parsed<Vec<Expr>> {
        let mut arguments = Vec::new();
        if !self.check(&TokenKind::RightParen) {
            // After `(` anything no argument starts with is unwanted
            // (parens/call-close-missing, eof/in-arguments).
            if !starts_expression(&self.current().kind) {
                return Err(self.unexpected_here(State::Expression));
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

    fn index_or_slice(&mut self, base: Expr) -> Parsed<Expr> {
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
        let Some(index) = start else {
            return Err(self.fail_here("index expression is missing"));
        };
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

    fn expression_path(&mut self, raw: &str, offset: usize) -> Parsed<ExprKind> {
        let mut parts = Vec::new();
        let mut cursor = 0_usize;
        while let Some(relative) = raw[cursor..].find("$(") {
            let start = cursor + relative;
            if !raw[..start].ends_with('/') {
                return Err(interpolation_within_a_segment(offset).into());
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
            let Some(expression_end) = expression_end else {
                return Err(ParseError {
                    message: "unterminated path interpolation".to_owned(),
                    offset,
                }
                .into());
            };
            // The interpolation's own tokens, placed in the whole source,
            // parsed in place of the ruleset's.
            let base = offset + expression_start;
            let (mut tokens, skipped) = lex_expression(&raw[expression_start..expression_end]);
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
                return Err(interpolation_within_a_segment(offset).into());
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

    /// Where the official parser chooses among `expecting`, unless it is
    /// recovering: a token that fits none is skipped as unwanted when the
    /// one after it fits (top/word-before), and is otherwise mismatched
    /// (top/broken).
    fn entry(&mut self, expecting: &str, fits: fn(&TokenKind) -> bool) -> Parsed<()> {
        if self.recovering {
            return Ok(());
        }
        if fits(&self.current().kind) {
            self.stale = None;
            return Ok(());
        }
        if fits(&self.next().kind) {
            return self.skip_unexpected();
        }
        Err(self.mismatched_here(expecting, State::Expression))
    }

    /// The official parser's match of one token, `expected` as it shows it:
    /// an unwanted token before it is skipped, one missing before a token
    /// that may follow it is supplied (version/equals-missing), anything
    /// else is mismatched (version/colon).
    fn match_token(
        &mut self,
        expected: &TokenKind,
        shown: &str,
        follows: fn(&TokenKind) -> bool,
    ) -> Parsed<()> {
        self.match_token_in(
            |kind| discriminant(kind) == discriminant(expected),
            shown,
            follows,
            State::Expression,
        )
    }

    /// The official parser's match of one token that `expects` takes, in
    /// `state`: an unwanted token before it is skipped, one missing before a
    /// token that `follows` takes is supplied, anything else is mismatched
    /// with what the official parser expects there.
    fn match_token_in(
        &mut self,
        expects: impl Fn(&TokenKind) -> bool,
        shown: &str,
        follows: impl Fn(&TokenKind) -> bool,
        state: State,
    ) -> Parsed<()> {
        if expects(&self.current().kind) {
            self.advance();
            return Ok(());
        }
        if expects(&self.next().kind) {
            self.skip_unexpected()?;
            self.advance();
            return Ok(());
        }
        if follows(&self.current().kind) {
            return self.report_missing(shown);
        }
        Err(self.mismatched_here(self.stale.unwrap_or(shown), state))
    }

    /// The token at `index` as the official parser shows it in a message.
    #[cold]
    fn shown(&self, index: usize) -> String {
        let token = &self.tokens[index.min(self.tokens.len() - 1)];
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
            TokenKind::Slash => {
                let end = self
                    .segment_at(index)
                    .map_or(token.end_offset, |(segment, _)| {
                        token.end_offset + segment.len()
                    });
                &self.source[token.offset..end]
            }
            _ => &self.source[token.offset..token.end_offset],
        };
        text.replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t")
    }

    #[cold]
    fn unexpected(&self) -> ParseError {
        self.error(format!("Unexpected '{}'.", self.shown(self.index)))
    }

    /// The official parser's report of a token at `at` that none of the
    /// forms it looked ahead at fits; it recovers from the token it looked
    /// ahead from, where the rule starts.
    #[cold]
    fn no_viable_alternative(&self, at: usize, state: State) -> Failure {
        let token = &self.tokens[at.min(self.tokens.len() - 1)];
        if let TokenKind::Invalid(error) = &token.kind {
            return Failure::Fatal(ParseError {
                message: error.message.clone(),
                offset: error.offset,
            });
        }
        Failure::Syntax(
            ParseError {
                message: format!("Unexpected '{}'.", self.shown(at)),
                offset: token.offset,
            },
            state,
        )
    }

    #[cold]
    fn unexpected_here(&self, state: State) -> Failure {
        self.no_viable_alternative(self.index, state)
    }

    #[cold]
    fn mismatched_here(&self, expecting: &str, state: State) -> Failure {
        self.fail_with(
            format!(
                "mismatched input '{}' expecting {expecting}",
                self.shown(self.index)
            ),
            state,
        )
    }

    /// A syntax error at the current token in `state`; at a token Firenook
    /// could not read, that token's own error, which ends the parse.
    #[cold]
    fn fail_with(&self, message: String, state: State) -> Failure {
        match &self.current().kind {
            TokenKind::Invalid(error) => Failure::Fatal(ParseError {
                message: error.message.clone(),
                offset: error.offset,
            }),
            _ => Failure::Syntax(
                ParseError {
                    message,
                    offset: self.current().offset,
                },
                state,
            ),
        }
    }

    #[cold]
    fn fail_here(&self, message: impl Into<String>) -> Failure {
        self.fail_with(message.into(), State::Expression)
    }

    #[cold]
    fn fail_at_previous(&self, message: impl Into<String>) -> Failure {
        let token = &self.tokens[self.index.saturating_sub(1)];
        match &token.kind {
            TokenKind::Invalid(error) => Failure::Fatal(ParseError {
                message: error.message.clone(),
                offset: error.offset,
            }),
            _ => Failure::Syntax(
                ParseError {
                    message: message.into(),
                    offset: token.offset,
                },
                State::Expression,
            ),
        }
    }

    /// Reports a syntax error unless the official parser is already
    /// recovering from one, and recovers.
    #[cold]
    fn report_error(&mut self, error: ParseError) {
        if !self.recovering {
            self.reported.push(error);
        }
        self.recovering = true;
    }

    /// Reports one of the grammar's own messages, which the official parser
    /// reports even while recovering, and goes on. At a token Firenook could
    /// not read, the parse ends with that token's error.
    #[cold]
    fn notify_here(&mut self, message: impl Into<String>) -> Parsed<()> {
        self.reject_invalid()?;
        let offset = self.current().offset;
        self.notify_at(offset, message);
        Ok(())
    }

    #[cold]
    fn notify_at(&mut self, offset: usize, message: impl Into<String>) {
        self.reported.push(ParseError {
            message: message.into(),
            offset,
        });
    }

    /// Reports the current token as unwanted, unless the official parser is
    /// recovering. Unlike its other errors, this one does not start a
    /// recovery: the official parser reports the next error at once
    /// (eof/after-declaration, braces/match-close-missing).
    #[cold]
    fn report_unwanted(&mut self) -> Parsed<()> {
        self.reject_invalid()?;
        if !self.recovering {
            let unexpected = self.unexpected();
            self.reported.push(unexpected);
        }
        Ok(())
    }

    /// The official parser's single-token deletion: the current token is
    /// reported as unwanted, and skipped.
    #[cold]
    fn skip_unexpected(&mut self) -> Parsed<()> {
        self.report_unwanted()?;
        self.advance();
        Ok(())
    }

    /// The official parser's single-token insertion: `shown` is reported as
    /// missing at the current token, and taken as there.
    #[cold]
    fn report_missing(&mut self, shown: &str) -> Parsed<()> {
        self.reject_invalid()?;
        if !self.recovering {
            let missing = self.error(format!("missing {shown} at '{}'", self.shown(self.index)));
            self.reported.push(missing);
        }
        self.recovering = true;
        Ok(())
    }

    #[cold]
    fn reject_invalid(&self) -> Parsed<()> {
        match &self.current().kind {
            TokenKind::Invalid(error) => Err(Failure::Fatal(ParseError {
                message: error.message.clone(),
                offset: error.offset,
            })),
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

    fn take_identifier(&mut self, description: &str) -> Parsed<String> {
        match self.advance().kind.clone() {
            TokenKind::Identifier(value) => Ok(value),
            _ => Err(self.fail_at_previous(format!("expected {description}"))),
        }
    }

    fn expect(&mut self, expected: &TokenKind, description: &str) -> Parsed<()> {
        if self.check(expected) {
            self.advance();
            Ok(())
        } else {
            Err(self.fail_here(format!("expected {description}")))
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

    /// Whether the current token is in `set`.
    fn at(&self, set: Tokens) -> bool {
        tokens(&self.current().kind) & set != 0
    }

    fn current(&self) -> &Token {
        &self.tokens[self.index]
    }

    /// The token after the current one: the official parser's second token
    /// of lookahead.
    fn next(&self) -> &Token {
        &self.tokens[(self.index + 1).min(self.tokens.len() - 1)]
    }

    fn kind_at(&self, index: usize) -> &TokenKind {
        &self.tokens[index.min(self.tokens.len() - 1)].kind
    }

    /// Matches the current token: the official parser's recovery, if any,
    /// is over.
    fn advance(&mut self) -> &Token {
        self.recovering = false;
        self.last_recovery = None;
        self.recovery_states.clear();
        let index = self.index;
        if !matches!(self.tokens[index].kind, TokenKind::Eof) {
            self.index += 1;
        }
        &self.tokens[index]
    }

    /// Skips the current token without matching it, as the official parser's
    /// recovery does.
    fn skip(&mut self) {
        if !matches!(self.current().kind, TokenKind::Eof) {
            self.index += 1;
        }
    }

    fn previous_offset(&self) -> usize {
        self.tokens[self.index.saturating_sub(1)].offset
    }

    /// An error at the current token; at a token Firenook could not read,
    /// that token's own error.
    #[cold]
    fn error(&self, message: impl Into<String>) -> ParseError {
        let token = self.current();
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

impl From<ParseError> for Failure {
    fn from(error: ParseError) -> Self {
        Self::Syntax(error, State::Expression)
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

/// A word the official lexer makes a name of: neither a keyword nor a
/// literal.
fn is_name(word: &str) -> bool {
    !is_keyword(word) && !matches!(word, "true" | "false" | "null")
}

/// The token as the official grammar's follow sets tell it apart.
fn tokens(kind: &TokenKind) -> Tokens {
    match kind {
        TokenKind::Identifier(word) => match word.as_str() {
            "function" => FUNCTION,
            "allow" => ALLOW,
            "match" => MATCH,
            "service" => SERVICE,
            "import" => IMPORT,
            "let" => LET,
            "return" => RETURN,
            _ => 0,
        },
        TokenKind::LeftBrace => OPEN,
        TokenKind::RightBrace => CLOSE,
        TokenKind::Path(_) | TokenKind::Slash => PATH,
        TokenKind::Semicolon => SEMICOLON,
        TokenKind::Eof => END,
        _ => 0,
    }
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
                    "L6:1 Unexpected '}'.",
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

    /// The official parser's recovery from what developer-tools-compile-errors-v1
    /// records, on other sources: where it looked ahead at a function, a
    /// match or a service and no form fitted, it reports that token and
    /// skips from the rule's start to what may follow a rule it is in; a
    /// path where a declaration starts is a match missing its keyword; after
    /// a declaration or a let an unwanted token is reported and skipped.
    #[test]
    fn recovers_as_the_official_parser_and_goes_on() {
        let rules = |body: &str| {
            format!(
                "rules_version = '2';\nservice cloud.firestore {{\n  match /c/{{id}} {{\n{body}  }}\n}}\n"
            )
        };
        let cases: [(String, &[&str]); 11] = [
            (
                rules("    function f(a, ) { return a; }\n    allow read: if f(1);\n"),
                &[
                    "L4:19 Unexpected ')'.",
                    "L5:5 Unexpected 'allow'.",
                    "L7:1 Unexpected '}'.",
                ],
            ),
            (
                rules("    function f() return true; }\n    allow read: if f();\n"),
                &[
                    "L4:18 Unexpected 'return'.",
                    "L5:5 Unexpected 'allow'.",
                    "L7:1 Unexpected '}'.",
                ],
            ),
            (
                rules("    match /d/{e}\n      allow read: if true;\n    }\n"),
                &[
                    "L4:11 Missing 'match' keyword before path.",
                    "L5:7 Unexpected 'allow'.",
                    "L5:7 mismatched input 'allow' expecting {'{', '/', PATH_SEGMENT}",
                    "L8:1 Unexpected '}'.",
                ],
            ),
            (
                "rules_version = '2';\nservice cloud.firestore\n  match /c/{id} {\n    allow read: if true;\n  }\n}\nfunction f() { return true; }\nmatch\n".to_owned(),
                &["L3:3 Unexpected 'match'.", "L8:1 Unexpected 'match'."],
            ),
            (
                rules("    /d/{e} { allow read: if true; }\n"),
                &[
                    "L4:5 Missing 'match' keyword before path.",
                    "L4:14 missing '}' at 'allow'",
                    "L6:1 Unexpected '}'.",
                ],
            ),
            (
                rules("    match /d/{e f} { allow read: if true; }\n"),
                &[
                    "L4:11 Missing 'match' keyword before path.",
                    "L4:15 mismatched input 'e' expecting '}'",
                    "L4:17 Unexpected 'f'.",
                    "L4:17 Unexpected 'f'.",
                    "L4:20 Unexpected '{'.",
                    "L5:3 Unexpected '}'.",
                ],
            ),
            (
                rules("    match /d/{=**} { allow read: if true; }\n"),
                &[
                    "L4:11 Missing 'match' keyword before path.",
                    "L4:13 Forward slash '/' found where identifier or binding expected.",
                    "L4:15 Unexpected '='.",
                    "L4:15 mismatched input '=' expecting {'{', '/', PATH_SEGMENT}",
                    "L4:20 Unexpected '{'.",
                    "L5:3 Unexpected '}'.",
                ],
            ),
            (
                rules("    match /d/{e=**}} { allow read: if true; }\n"),
                &["L4:20 Exra closing '}' in path."],
            ),
            (
                rules(
                    "    function f() {\n      let a = 1;\n      retrun a;\n    }\n    allow read: if f();\n",
                ),
                &[
                    "L6:7 Unexpected 'retrun'.",
                    "L7:5 mismatched input '}' expecting {'&&', '.', '==', '>', '>=', '[', '<', '<=', '-', '%', '!=', '||', '+', ';', '/', '*', '?', 'in', 'is'}",
                ],
            ),
            (
                rules("    allow read: ; f();\n    allow write: if true;\n"),
                &["L4:17 Unexpected ';'.", "L4:19 Unexpected 'f'."],
            ),
            (
                rules("    function f()) { return true; }\n    allow read: if f();\n"),
                &["L4:17 Extra closing ')' at the end of parameter list."],
            ),
        ];
        for (source, expected) in cases {
            assert_eq!(answered(&source), expected, "{source}");
        }
    }

    /// Every recovery skips a token or ends, so a source cut anywhere, or
    /// missing any one character, is answered.
    #[test]
    fn recovery_ends_on_every_cut_and_every_dropped_character() {
        let source = "rules_version = '2';\nfunction top(a) { let b = a; return b; }\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    function signedIn() { return request.auth != null; }\n    match /items/{item=**} {\n      allow read, list: if signedIn() && exists(/databases/$(database)/documents/a/$(item));\n      allow write: if (request.resource.data.n is int) ? true : [1, {'k': 2}][0] == 1;\n    }\n  }\n}\n";
        for at in source.char_indices().map(|(at, _)| at) {
            let _ = parse(&source[..at]);
            let mut dropped = source.to_owned();
            dropped.remove(at);
            let _ = parse(&dropped);
        }
        parse(source).expect("the whole source parses");
    }
}
