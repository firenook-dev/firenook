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

impl Filter {
    /// Parses the expression, or fails the way the official emulator does.
    pub fn parse(text: &str) -> Result<Self, PubsubError> {
        let mut parser = Parser {
            tokens: tokenize(text).ok_or_else(PubsubError::application_error)?,
            position: 0,
        };
        let filter = parser.or().ok_or_else(PubsubError::application_error)?;
        if parser.position != parser.tokens.len() {
            return Err(PubsubError::application_error());
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
enum Token {
    Ident(String),
    Text(String),
    Symbol(char),
    NotEqual,
}

fn tokenize(text: &str) -> Option<Vec<Token>> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        if current.is_whitespace() {
            index += 1;
        } else if current == '"' {
            let mut value = String::new();
            index += 1;
            loop {
                let next = *chars.get(index)?;
                index += 1;
                if next == '"' {
                    break;
                }
                if next == '\\' {
                    let escaped = *chars.get(index)?;
                    index += 1;
                    value.push(escaped);
                } else {
                    value.push(next);
                }
            }
            tokens.push(Token::Text(value));
        } else if current == '!' && chars.get(index + 1) == Some(&'=') {
            tokens.push(Token::NotEqual);
            index += 2;
        } else if "()=:,.-".contains(current) {
            tokens.push(Token::Symbol(current));
            index += 1;
        } else if current.is_alphanumeric() || current == '_' {
            let start = index;
            while index < chars.len() && (chars[index].is_alphanumeric() || chars[index] == '_') {
                index += 1;
            }
            tokens.push(Token::Ident(chars[start..index].iter().collect()));
        } else {
            return None;
        }
    }
    Some(tokens)
}

struct Parser {
    tokens: Vec<Token>,
    position: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.position)
    }

    fn take(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.position).cloned();
        if token.is_some() {
            self.position += 1;
        }
        token
    }

    fn keyword(&mut self, word: &str) -> bool {
        if matches!(self.peek(), Some(Token::Ident(ident)) if ident == word) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn symbol(&mut self, symbol: char) -> bool {
        if self.peek() == Some(&Token::Symbol(symbol)) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn or(&mut self) -> Option<Filter> {
        let mut left = self.and()?;
        while self.keyword("OR") {
            let right = self.and()?;
            left = Filter::Or(Box::new(left), Box::new(right));
        }
        Some(left)
    }

    fn and(&mut self) -> Option<Filter> {
        let mut left = self.unary()?;
        while self.keyword("AND") {
            let right = self.unary()?;
            left = Filter::And(Box::new(left), Box::new(right));
        }
        Some(left)
    }

    fn unary(&mut self) -> Option<Filter> {
        if self.keyword("NOT") || self.symbol('-') {
            return Some(Filter::Not(Box::new(self.unary()?)));
        }
        self.primary()
    }

    fn primary(&mut self) -> Option<Filter> {
        if self.symbol('(') {
            let inner = self.or()?;
            if !self.symbol(')') {
                return None;
            }
            return Some(inner);
        }
        if self.keyword("hasPrefix") {
            if !self.symbol('(') {
                return None;
            }
            let key = self.attribute_path()?;
            if !self.symbol(',') {
                return None;
            }
            let Token::Text(prefix) = self.take()? else {
                return None;
            };
            if !self.symbol(')') {
                return None;
            }
            return Some(Filter::HasPrefix(key, prefix));
        }
        if !self.keyword("attributes") {
            return None;
        }
        if self.symbol(':') {
            return Some(Filter::Exists(self.key()?));
        }
        if !self.symbol('.') {
            return None;
        }
        let key = self.key()?;
        match self.take()? {
            Token::Symbol('=') => {
                let Token::Text(value) = self.take()? else {
                    return None;
                };
                Some(Filter::Equals(key, value))
            }
            Token::NotEqual => {
                let Token::Text(value) = self.take()? else {
                    return None;
                };
                Some(Filter::NotEquals(key, value))
            }
            _ => None,
        }
    }

    fn attribute_path(&mut self) -> Option<String> {
        if !self.keyword("attributes") || !self.symbol('.') {
            return None;
        }
        self.key()
    }

    fn key(&mut self) -> Option<String> {
        match self.take()? {
            Token::Ident(key) | Token::Text(key) => Some(key),
            _ => None,
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
