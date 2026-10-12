//! Subscription filter expressions: `attributes.k = "v"`, `!=`, the
//! existence test `attributes:k`, `hasPrefix(attributes.k, "p")`, `NOT`,
//! `AND`, `OR` and parentheses. A filter the official emulator cannot parse
//! (anything else, including `data` comparisons) fails subscription creation
//! with its generic application error.

use std::collections::BTreeMap;

use crate::error::PubsubError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Filter {
    Equals(String, String),
    NotEquals(String, String),
    Exists(String),
    HasPrefix(String, String),
    Not(Box<Filter>),
    And(Box<Filter>, Box<Filter>),
    Or(Box<Filter>, Box<Filter>),
}

/// Where and why a filter does not parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterSyntax {
    pub message: String,
    /// UTF-16 offset in the filter text where parsing stopped.
    pub position: usize,
}

impl std::fmt::Display for FilterSyntax {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} (at {})", self.message, self.position)
    }
}

impl std::error::Error for FilterSyntax {}

impl Filter {
    /// Parses the expression, or fails the way the official emulator does.
    pub fn parse(text: &str) -> Result<Self, PubsubError> {
        Self::check(text).map_err(|_| PubsubError::application_error())
    }

    /// Parses the expression, saying where and why it does not: the same
    /// parse [`Filter::parse`] makes, which keeps the official error.
    pub fn check(text: &str) -> Result<Self, FilterSyntax> {
        let (tokens, end) = tokenize(text)?;
        let mut parser = Parser {
            tokens,
            position: 0,
            end,
        };
        let filter = parser.or()?;
        if let Some(token) = parser.peek() {
            return Err(FilterSyntax {
                message: format!(
                    "Unexpected {} after a complete condition; join conditions with AND or OR.",
                    token.kind.describe()
                ),
                position: token.at,
            });
        }
        Ok(filter)
    }

    /// Whether a message with `attributes` passes the filter.
    #[must_use]
    pub fn matches(&self, attributes: &BTreeMap<String, String>) -> bool {
        match self {
            Self::Equals(key, value) => attributes.get(key) == Some(value),
            Self::NotEquals(key, value) => attributes.get(key) != Some(value),
            Self::Exists(key) => attributes.contains_key(key),
            Self::HasPrefix(key, prefix) => attributes
                .get(key)
                .is_some_and(|value| value.starts_with(prefix)),
            Self::Not(inner) => !inner.matches(attributes),
            Self::And(left, right) => left.matches(attributes) && right.matches(attributes),
            Self::Or(left, right) => left.matches(attributes) || right.matches(attributes),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TokenKind {
    Ident(String),
    Text(String),
    Symbol(char),
    NotEqual,
}

impl TokenKind {
    fn describe(&self) -> String {
        match self {
            Self::Ident(word) => format!("\"{word}\""),
            Self::Text(text) => format!("the quoted value \"{text}\""),
            Self::Symbol(symbol) => format!("\"{symbol}\""),
            Self::NotEqual => "\"!=\"".to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    kind: TokenKind,
    /// UTF-16 offset of the token's start.
    at: usize,
}

/// The tokens of `text` and the UTF-16 length of the text.
fn tokenize(text: &str) -> Result<(Vec<Token>, usize), FilterSyntax> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut offsets = Vec::with_capacity(chars.len() + 1);
    let mut offset = 0;
    for character in &chars {
        offsets.push(offset);
        offset += character.len_utf16();
    }
    offsets.push(offset);
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        let at = offsets[index];
        if current.is_whitespace() {
            index += 1;
        } else if current == '"' {
            let mut value = String::new();
            index += 1;
            loop {
                let Some(&next) = chars.get(index) else {
                    return Err(FilterSyntax {
                        message: "This quoted value is not closed; end it with \".".to_owned(),
                        position: at,
                    });
                };
                index += 1;
                if next == '"' {
                    break;
                }
                if next == '\\' {
                    let Some(&escaped) = chars.get(index) else {
                        return Err(FilterSyntax {
                            message: "This quoted value is not closed; end it with \".".to_owned(),
                            position: at,
                        });
                    };
                    index += 1;
                    value.push(escaped);
                } else {
                    value.push(next);
                }
            }
            tokens.push(Token {
                kind: TokenKind::Text(value),
                at,
            });
        } else if current == '!' && chars.get(index + 1) == Some(&'=') {
            tokens.push(Token {
                kind: TokenKind::NotEqual,
                at,
            });
            index += 2;
        } else if "()=:,.-".contains(current) {
            tokens.push(Token {
                kind: TokenKind::Symbol(current),
                at,
            });
            index += 1;
        } else if current.is_alphanumeric() || current == '_' {
            let start = index;
            while index < chars.len() && (chars[index].is_alphanumeric() || chars[index] == '_') {
                index += 1;
            }
            tokens.push(Token {
                kind: TokenKind::Ident(chars[start..index].iter().collect()),
                at,
            });
        } else {
            return Err(FilterSyntax {
                message: format!(
                    "\"{current}\" cannot appear here; filters use attributes, quoted values, =, !=, :, hasPrefix, NOT, AND, OR and parentheses."
                ),
                position: at,
            });
        }
    }
    Ok((tokens, offset))
}

struct Parser {
    tokens: Vec<Token>,
    position: usize,
    /// UTF-16 length of the text: where a missing token was expected.
    end: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.position)
    }

    /// Where the next token starts, or the end of the text.
    fn here(&self) -> usize {
        self.peek().map_or(self.end, |token| token.at)
    }

    fn fail<T>(&self, message: impl Into<String>) -> Result<T, FilterSyntax> {
        Err(FilterSyntax {
            message: message.into(),
            position: self.here(),
        })
    }

    fn keyword(&mut self, word: &str) -> bool {
        if matches!(self.peek(), Some(Token { kind: TokenKind::Ident(ident), .. }) if ident == word)
        {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn symbol(&mut self, symbol: char) -> bool {
        if matches!(self.peek(), Some(Token { kind: TokenKind::Symbol(found), .. }) if *found == symbol)
        {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn or(&mut self) -> Result<Filter, FilterSyntax> {
        let mut left = self.and()?;
        while self.keyword("OR") {
            let right = self.and()?;
            left = Filter::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn and(&mut self) -> Result<Filter, FilterSyntax> {
        let mut left = self.unary()?;
        while self.keyword("AND") {
            let right = self.unary()?;
            left = Filter::And(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Filter, FilterSyntax> {
        if self.keyword("NOT") || self.symbol('-') {
            return Ok(Filter::Not(Box::new(self.unary()?)));
        }
        self.primary()
    }

    fn primary(&mut self) -> Result<Filter, FilterSyntax> {
        if self.symbol('(') {
            let inner = self.or()?;
            if !self.symbol(')') {
                return self.fail("Expected \")\" to close the group.");
            }
            return Ok(inner);
        }
        if self.keyword("hasPrefix") {
            if !self.symbol('(') {
                return self.fail(
                    "Expected \"(\" after hasPrefix, as in hasPrefix(attributes.key, \"prefix\").",
                );
            }
            let key = self.attribute_path()?;
            if !self.symbol(',') {
                return self.fail("Expected \",\" and the quoted prefix after the attribute.");
            }
            let Some(Token {
                kind: TokenKind::Text(prefix),
                ..
            }) = self.peek().cloned()
            else {
                return self.fail("Expected the prefix as a quoted value.");
            };
            self.position += 1;
            if !self.symbol(')') {
                return self.fail("Expected \")\" to close hasPrefix.");
            }
            return Ok(Filter::HasPrefix(key, prefix));
        }
        if !self.keyword("attributes") {
            return match self.peek() {
                Some(Token {
                    kind: TokenKind::Ident(word),
                    ..
                }) => {
                    let word = word.clone();
                    self.fail(format!(
                        "\"{word}\" cannot be filtered on: a subscription filter tests attributes only (attributes.key = \"value\", attributes:key, hasPrefix(attributes.key, \"p\"))."
                    ))
                }
                Some(_) => self.fail(
                    "Expected a condition, like attributes.key = \"value\", attributes:key or hasPrefix(attributes.key, \"p\").",
                ),
                None => self.fail(
                    "Expected a condition here, like attributes.key = \"value\".",
                ),
            };
        }
        if self.symbol(':') {
            return Ok(Filter::Exists(self.key()?));
        }
        if !self.symbol('.') {
            return self.fail("Expected \".\" and a key, or \":\" and a key, after attributes.");
        }
        let key = self.key()?;
        let operator = self.peek().map(|token| token.kind.clone());
        match operator {
            Some(TokenKind::Symbol('=')) => {
                self.position += 1;
                let value = self.value("=")?;
                Ok(Filter::Equals(key, value))
            }
            Some(TokenKind::NotEqual) => {
                self.position += 1;
                let value = self.value("!=")?;
                Ok(Filter::NotEquals(key, value))
            }
            _ => self.fail(format!(
                "Expected = or != after attributes.{key}, or test that the key exists with attributes:{key}."
            )),
        }
    }

    fn value(&mut self, operator: &str) -> Result<String, FilterSyntax> {
        match self.peek().cloned() {
            Some(Token {
                kind: TokenKind::Text(value),
                ..
            }) => {
                self.position += 1;
                Ok(value)
            }
            _ => self.fail(format!("Expected a quoted value after {operator}.")),
        }
    }

    fn attribute_path(&mut self) -> Result<String, FilterSyntax> {
        if !self.keyword("attributes") || !self.symbol('.') {
            return self.fail("Expected attributes.key here.");
        }
        self.key()
    }

    fn key(&mut self) -> Result<String, FilterSyntax> {
        match self.peek().cloned() {
            Some(Token {
                kind: TokenKind::Ident(key) | TokenKind::Text(key),
                ..
            }) => {
                self.position += 1;
                Ok(key)
            }
            _ => self.fail("Expected an attribute key here."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attributes(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn recorded_filters_parse_and_evaluate() {
        let ping = attributes(&[("kind", "ping")]);
        let high = attributes(&[("kind", "ping"), ("priority", "high")]);
        let none = attributes(&[]);
        assert!(
            Filter::parse(r#"attributes.kind = "ping""#)
                .unwrap()
                .matches(&ping)
        );
        assert!(
            !Filter::parse(r#"attributes.kind != "ping""#)
                .unwrap()
                .matches(&ping)
        );
        assert!(
            Filter::parse(r#"attributes.kind != "ping""#)
                .unwrap()
                .matches(&none)
        );
        assert!(Filter::parse("attributes:kind").unwrap().matches(&ping));
        assert!(
            Filter::parse(r#"hasPrefix(attributes.kind, "pi")"#)
                .unwrap()
                .matches(&ping)
        );
        assert!(
            !Filter::parse(r#"NOT attributes.kind = "ping""#)
                .unwrap()
                .matches(&ping)
        );
        assert!(
            Filter::parse(r#"attributes.kind = "ping" AND attributes.priority = "high""#)
                .unwrap()
                .matches(&high)
        );
        assert!(Filter::parse(r#"(attributes.kind = "ping" OR attributes.kind = "pong") AND NOT attributes:priority"#).unwrap().matches(&ping));
        assert!(Filter::parse("attributes.kind =").is_err());
        assert!(Filter::parse(r#"nope(attributes.kind, "x")"#).is_err());
        assert!(Filter::parse(r#"data = "x""#).is_err());
        assert!(Filter::parse(r#"orderingKey = "k""#).is_err());
    }
}
