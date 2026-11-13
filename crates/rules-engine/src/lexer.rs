#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Token {
    pub(crate) kind: TokenKind,
    pub(crate) offset: usize,
    pub(crate) end_offset: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum TokenKind {
    Identifier(String),
    String(String),
    Integer(i64),
    Float(f64),
    Path(String),
    Assign,
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    And,
    Or,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Bang,
    Dot,
    Comma,
    Colon,
    Question,
    Semicolon,
    LeftParen,
    RightParen,
    LeftBrace,
    RightBrace,
    LeftBracket,
    RightBracket,
    /// A string its line ends in before it closes, from the quote to the end
    /// of the line, as the official lexer reads it (`UNPAIRED_SINGLE_QUOTE`,
    /// `UNPAIRED_DOUBLE_QUOTE`); the quote it opens with.
    UnpairedQuote(char),
    /// A token of the official lexer's that no rule takes: `@`, `$` outside
    /// a path, and the `/*` of a comment that never closes.
    Stray,
    /// Text Firenook cannot read as a token: its message, and where it
    /// points. The parser reports it when it gets there. Boxed, so that
    /// every other token stays as small as it was.
    Invalid(Box<LexError>),
    Eof,
}

/// What the lexer could not read: a character no token starts with, which
/// it skips and the parser reports only when it reports nothing else, or,
/// in [`TokenKind::Invalid`], text the parser reports where it gets to it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LexError {
    pub(crate) message: String,
    pub(crate) offset: usize,
}

/// The tokens of `source`, ending with [`TokenKind::Eof`], and the
/// characters skipped.
pub(crate) fn lex(source: &str) -> (Vec<Token>, Vec<LexError>) {
    Lexer::new(source).lex()
}

struct Lexer<'a> {
    source: &'a str,
    offset: usize,
    tokens: Vec<Token>,
    skipped: Vec<LexError>,
}

impl<'a> Lexer<'a> {
    const fn new(source: &'a str) -> Self {
        Self {
            source,
            offset: 0,
            tokens: Vec::new(),
            skipped: Vec::new(),
        }
    }

    fn lex(mut self) -> (Vec<Token>, Vec<LexError>) {
        while self.offset < self.source.len() {
            self.skip_trivia();
            if self.offset == self.source.len() {
                break;
            }
            let start = self.offset;
            let character = self
                .current()
                .expect("offset before source end has a character");
            let kind = match character {
                // What skip_trivia left of a block comment: one that never
                // closes, whose `/*` the official lexer makes a token of
                // (developer-tools-compile-errors-v1 eof/in-block-comment).
                '/' if self.remaining().starts_with("/*") => {
                    self.offset += 2;
                    TokenKind::Stray
                }
                '\'' | '"' => self.string(character),
                '0'..='9' => self.number(),
                character if is_identifier_start(character) => self.identifier(),
                '/' if self.path_can_start() => self.path(),
                '=' if self.consume_pair("==") => TokenKind::Equal,
                '!' if self.consume_pair("!=") => TokenKind::NotEqual,
                '<' if self.consume_pair("<=") => TokenKind::LessEqual,
                '>' if self.consume_pair(">=") => TokenKind::GreaterEqual,
                '&' if self.consume_pair("&&") => TokenKind::And,
                '|' if self.consume_pair("||") => TokenKind::Or,
                '=' => self.single(TokenKind::Assign),
                '<' => self.single(TokenKind::Less),
                '>' => self.single(TokenKind::Greater),
                '+' => self.single(TokenKind::Plus),
                '-' => self.single(TokenKind::Minus),
                '*' => self.single(TokenKind::Star),
                '/' => self.single(TokenKind::Slash),
                '%' => self.single(TokenKind::Percent),
                '!' => self.single(TokenKind::Bang),
                '.' => self.single(TokenKind::Dot),
                ',' => self.single(TokenKind::Comma),
                ':' => self.single(TokenKind::Colon),
                '?' => self.single(TokenKind::Question),
                ';' => self.single(TokenKind::Semicolon),
                '(' => self.single(TokenKind::LeftParen),
                ')' => self.single(TokenKind::RightParen),
                '{' => self.single(TokenKind::LeftBrace),
                '}' => self.single(TokenKind::RightBrace),
                '[' => self.single(TokenKind::LeftBracket),
                ']' => self.single(TokenKind::RightBracket),
                '@' | '$' => self.single(TokenKind::Stray),
                '&' | '|' | '#' | '~' => {
                    self.skip_unrecognised(character);
                    continue;
                }
                _ => {
                    self.advance();
                    invalid(format!("unexpected character {character:?}"), start)
                }
            };
            self.tokens.push(Token {
                kind,
                offset: start,
                end_offset: self.offset,
            });
        }
        self.tokens.push(Token {
            kind: TokenKind::Eof,
            offset: self.source.len(),
            end_offset: self.source.len(),
        });
        (self.tokens, self.skipped)
    }

    /// A character the official lexer has no token for: it reports it and
    /// goes on after it. A lone `&` or `|` it reads with the character after
    /// it, hoping for `&&` or `||`, and reports and skips both, at the second
    /// (developer-tools-compile-errors-v1 conditions/stray-ampersand,
    /// conditions/single-pipe, conditions/tilde, conditions/bad-character-hash).
    fn skip_unrecognised(&mut self, character: char) {
        let start = self.offset;
        let mut at = start;
        self.advance();
        if matches!(character, '&' | '|') && self.current().is_some() {
            at = self.offset;
            self.advance();
        }
        let text = self.source[start..self.offset]
            .replace('\n', "\\n")
            .replace('\r', "\\r")
            .replace('\t', "\\t");
        self.skipped.push(LexError {
            message: format!("token recognition error at: '{text}'"),
            offset: at,
        });
    }

    /// Whitespace and comments. A block comment that never closes is left
    /// for [`lex`](Self::lex).
    fn skip_trivia(&mut self) {
        loop {
            while self.current().is_some_and(char::is_whitespace) {
                self.advance();
            }
            if self.remaining().starts_with("//") {
                while self.current().is_some_and(|character| character != '\n') {
                    self.advance();
                }
                continue;
            }
            if self.remaining().starts_with("/*")
                && let Some(end) = self.remaining()[2..].find("*/")
            {
                self.offset += end + 4;
                continue;
            }
            return;
        }
    }

    /// A string closes on its line; one that does not is an unpaired quote,
    /// to the end of the line, as the official lexer reads it
    /// (developer-tools-compile-errors-v1 strings/*).
    fn string(&mut self, quote: char) -> TokenKind {
        self.advance();
        let quote_byte = u8::try_from(quote).expect("a quote is ASCII");
        let mut value = String::new();
        loop {
            // Up to the next byte that ends or escapes the text, all ASCII,
            // so a whole run is copied at once.
            let rest = self.remaining();
            let Some(at) = rest
                .bytes()
                .position(|byte| matches!(byte, b'\\' | b'\n' | b'\r') || byte == quote_byte)
            else {
                self.offset = self.source.len();
                break;
            };
            value.push_str(&rest[..at]);
            self.offset += at;
            match rest.as_bytes()[at] {
                b'\n' | b'\r' => break,
                b'\\' => {
                    self.advance();
                    let Some(escaped) = self
                        .current()
                        .filter(|escaped| !matches!(escaped, '\n' | '\r'))
                    else {
                        break;
                    };
                    self.advance();
                    value.push(match escaped {
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        '\\' => '\\',
                        '\'' => '\'',
                        '"' => '"',
                        other => other,
                    });
                }
                _ => {
                    self.advance();
                    return TokenKind::String(value);
                }
            }
        }
        TokenKind::UnpairedQuote(quote)
    }

    fn number(&mut self) -> TokenKind {
        let start = self.offset;
        while self
            .current()
            .is_some_and(|character| character.is_ascii_digit())
        {
            self.advance();
        }
        let mut float = false;
        if self.current() == Some('.')
            && self
                .peek_after_current()
                .is_some_and(|character| character.is_ascii_digit())
        {
            float = true;
            self.advance();
            while self
                .current()
                .is_some_and(|character| character.is_ascii_digit())
            {
                self.advance();
            }
        }
        if matches!(self.current(), Some('e' | 'E')) {
            float = true;
            self.advance();
            if matches!(self.current(), Some('+' | '-')) {
                self.advance();
            }
            let exponent_start = self.offset;
            while self
                .current()
                .is_some_and(|character| character.is_ascii_digit())
            {
                self.advance();
            }
            if exponent_start == self.offset {
                return invalid("numeric exponent has no digits", exponent_start);
            }
        }
        let source = &self.source[start..self.offset];
        if float {
            source.parse::<f64>().map_or_else(
                |_| invalid("invalid floating-point literal", start),
                TokenKind::Float,
            )
        } else {
            source.parse::<i64>().map_or_else(
                |_| invalid("integer literal is out of range", start),
                TokenKind::Integer,
            )
        }
    }

    fn identifier(&mut self) -> TokenKind {
        let start = self.offset;
        // An identifier is ASCII, so its bytes are its characters.
        let length = self.remaining()[1..]
            .bytes()
            .position(|byte| !is_identifier_continue(char::from(byte)))
            .map_or(self.remaining().len(), |length| length + 1);
        self.offset += length;
        TokenKind::Identifier(self.source[start..self.offset].to_owned())
    }

    fn path_can_start(&self) -> bool {
        let next = self.source[self.offset + 1..].chars().next();
        if !next.is_some_and(|character| character == '{' || is_path_character(character)) {
            return false;
        }
        let Some(previous) = self.tokens.last() else {
            return true;
        };
        if matches!(&previous.kind, TokenKind::Identifier(value) if matches!(value.as_str(), "match" | "return" | "if" | "in"))
        {
            return true;
        }
        !token_can_end_expression(&previous.kind)
    }

    fn path(&mut self) -> TokenKind {
        let start = self.offset;
        let mut interpolation_depth = 0_usize;
        let mut braces = 0_usize;
        // A parenthesized literal segment such as `(default)` in
        // `/databases/(default)/documents` is part of the path.
        let mut literal_parentheses = 0_usize;
        while let Some(character) = self.current() {
            if interpolation_depth == 0 && braces == 0 && literal_parentheses == 0 {
                if character.is_whitespace()
                    || matches!(character, ';' | ',' | ')' | '[' | ']' | ':' | '&' | '|')
                {
                    break;
                }
                if matches!(character, '=' | '!' | '<' | '>') && self.offset > start {
                    break;
                }
            }
            if self.remaining().starts_with("$(") {
                interpolation_depth += 1;
                self.offset += 2;
                continue;
            }
            match character {
                '(' if interpolation_depth > 0 => interpolation_depth += 1,
                ')' if interpolation_depth > 0 => interpolation_depth -= 1,
                '(' if self.previous_character() == Some('/') => literal_parentheses += 1,
                ')' if literal_parentheses > 0 => literal_parentheses -= 1,
                '{' if interpolation_depth == 0 => braces += 1,
                '}' if interpolation_depth == 0 && braces > 0 => braces -= 1,
                _ => {}
            }
            self.advance();
        }
        if interpolation_depth != 0 || braces != 0 || literal_parentheses != 0 {
            return invalid("unterminated path interpolation or wildcard", start);
        }
        TokenKind::Path(self.source[start..self.offset].to_owned())
    }

    fn single(&mut self, token: TokenKind) -> TokenKind {
        self.advance();
        token
    }

    fn consume_pair(&mut self, pair: &str) -> bool {
        if self.remaining().starts_with(pair) {
            self.offset += pair.len();
            true
        } else {
            false
        }
    }

    fn current(&self) -> Option<char> {
        self.remaining().chars().next()
    }

    fn previous_character(&self) -> Option<char> {
        self.source[..self.offset].chars().next_back()
    }

    fn peek_after_current(&self) -> Option<char> {
        let mut characters = self.remaining().chars();
        characters.next()?;
        characters.next()
    }

    fn remaining(&self) -> &'a str {
        &self.source[self.offset..]
    }

    fn advance(&mut self) {
        if let Some(character) = self.current() {
            self.offset += character.len_utf8();
        }
    }
}

fn invalid(message: impl Into<String>, offset: usize) -> TokenKind {
    TokenKind::Invalid(Box::new(LexError {
        message: message.into(),
        offset,
    }))
}

fn is_identifier_start(character: char) -> bool {
    character == '_' || character.is_ascii_alphabetic()
}

fn is_identifier_continue(character: char) -> bool {
    character == '_' || character.is_ascii_alphanumeric()
}

fn is_path_character(character: char) -> bool {
    character == '_' || character == '(' || character.is_ascii_alphanumeric()
}

fn token_can_end_expression(token: &TokenKind) -> bool {
    matches!(
        token,
        TokenKind::Identifier(_)
            | TokenKind::String(_)
            | TokenKind::UnpairedQuote(_)
            | TokenKind::Integer(_)
            | TokenKind::Float(_)
            | TokenKind::Path(_)
            | TokenKind::RightParen
            | TokenKind::RightBracket
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_can_open_an_expression_and_ends_at_a_bracket() {
        let (tokens, skipped) = lex("allow get: if /a/$('b')[1] == 'b' && 'x' in /c/d;");
        assert_eq!(skipped, []);
        let paths = tokens
            .iter()
            .filter_map(|token| match &token.kind {
                TokenKind::Path(path) => Some(path.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(paths, ["/a/$('b')", "/c/d"]);
    }

    #[test]
    fn distinguishes_paths_from_division() {
        let (tokens, _) = lex("return /databases/$(database)/documents/a; 9/3 == 3;");
        assert!(matches!(tokens[1].kind, TokenKind::Path(_)));
        assert!(
            tokens
                .iter()
                .any(|token| matches!(token.kind, TokenKind::Slash))
        );
    }

    #[test]
    fn skips_both_comment_forms() {
        let (tokens, _) = lex("// line\ntrue /* block */ && false");
        assert_eq!(
            tokens
                .iter()
                .filter(|token| matches!(token.kind, TokenKind::Identifier(_)))
                .count(),
            2
        );
    }

    /// The official lexer's reading of what does not make a token
    /// (developer-tools-compile-errors-v1): a string its line ends in, an
    /// unclosed comment's `/*`, and characters it skips and reports.
    #[test]
    fn reads_what_does_not_make_a_token_as_the_official_lexer() {
        let (tokens, skipped) = lex("'ab\n\"c\\\"\n/* x & y ~ |");
        let kinds = tokens.iter().map(|token| &token.kind).collect::<Vec<_>>();
        assert!(matches!(
            kinds.as_slice(),
            [
                TokenKind::UnpairedQuote('\''),
                TokenKind::UnpairedQuote('"'),
                TokenKind::Stray,
                TokenKind::Identifier(x),
                TokenKind::Identifier(y),
                TokenKind::Eof,
            ] if x == "x" && y == "y"
        ));
        let spans = tokens[..3]
            .iter()
            .map(|token| (token.offset, token.end_offset))
            .collect::<Vec<_>>();
        assert_eq!(spans, [(0, 3), (4, 8), (9, 11)]);
        let skipped = skipped
            .iter()
            .map(|error| (error.offset, error.message.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            skipped,
            [
                (15, "token recognition error at: '& '"),
                (18, "token recognition error at: '~'"),
                (20, "token recognition error at: '|'"),
            ]
        );
    }
}
