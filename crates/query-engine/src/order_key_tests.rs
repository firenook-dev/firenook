//! The disk store's field index orders documents by a byte key, and the
//! query engine trusts that order. These tests hold the key to
//! [`compare_values`] over every edge value and many random ones, in both
//! editions:
//!
//! - values the engine compares as equal have equal keys;
//! - a value that orders before another has a smaller key, unless both keys
//!   are inexact and share a group, which the walk sorts with the engine's
//!   comparator;
//! - an exact key is never shared by values the engine tells apart;
//! - no key extends another, and no exact key falls inside a group, so an
//!   entry's document id can never reorder values and a group is one run of
//!   entries.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::sync::Arc;

use firenook_core_store::{FieldIndexKey, Timestamp, Value, field_index_key};

use crate::{DatabaseEdition, compare_values};

/// A small deterministic generator, so a failure reproduces from its seed.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 11
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next()).unwrap() % bound
    }

    fn wide(&mut self) -> u64 {
        (self.next() << 32) ^ self.next()
    }
}

const TWO_POW_63: f64 = 9_223_372_036_854_775_808.0;

fn text(value: &str) -> Value {
    Value::String(value.into())
}

fn reference(path: &str) -> Value {
    Value::Reference(Arc::from(format!(
        "projects/demo-order/databases/(default)/documents/{path}"
    )))
}

fn next_up(value: f64) -> f64 {
    if value.is_nan() || value == f64::INFINITY {
        return value;
    }
    if value == 0.0 {
        return f64::from_bits(1);
    }
    let bits = value.to_bits();
    f64::from_bits(if value > 0.0 { bits + 1 } else { bits - 1 })
}

fn next_down(value: f64) -> f64 {
    -next_up(-value)
}

fn edge_doubles() -> Vec<f64> {
    let mut doubles = vec![
        f64::NAN,
        f64::from_bits(0x7ff8_0000_0000_0001),
        f64::from_bits(0xfff8_0000_0000_0000),
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::MIN,
        f64::MAX,
        -0.0,
        0.0,
        f64::MIN_POSITIVE,
        -f64::MIN_POSITIVE,
        f64::from_bits(1),
        -f64::from_bits(1),
        0.5,
        -0.5,
        0.3,
        -0.3,
        -0.7,
        1.0,
        -1.0,
        1.5,
        -1.5,
        2.0,
        -2.0,
        1e-300,
        -1e-300,
        1e300,
        -1e300,
        TWO_POW_63,
        -TWO_POW_63,
        9_007_199_254_740_992.0,
        -9_007_199_254_740_992.0,
        4_503_599_627_370_495.5,
        -4_503_599_627_370_495.5,
    ];
    for anchor in [
        TWO_POW_63,
        -TWO_POW_63,
        0.0,
        1.0,
        -1.0,
        0.5,
        -0.5,
        9_007_199_254_740_992.0,
        4_503_599_627_370_496.0,
        -4_503_599_627_370_496.0,
    ] {
        doubles.extend([next_up(anchor), next_down(anchor), next_up(next_up(anchor))]);
    }
    doubles
}

fn edge_integers() -> Vec<i64> {
    vec![
        i64::MIN,
        i64::MIN + 1,
        i64::MAX,
        i64::MAX - 1,
        -9_007_199_254_740_993,
        -9_007_199_254_740_992,
        9_007_199_254_740_992,
        9_007_199_254_740_993,
        -4_503_599_627_370_496,
        4_503_599_627_370_495,
        -3,
        -2,
        -1,
        0,
        1,
        2,
        3,
        1_000,
    ]
}

/// Strings that share prefixes around the inline limit and the Standard
/// edition's 1,500 compared bytes, with zero bytes and multi-byte text.
fn edge_strings() -> Vec<String> {
    let inline = "s".repeat(64);
    let compared = "c".repeat(1_500);
    let mut strings = vec![
        String::new(),
        "\0".to_owned(),
        "\0\0".to_owned(),
        "a".to_owned(),
        "a\0".to_owned(),
        "a\0b".to_owned(),
        "a\u{1}".to_owned(),
        "ab".to_owned(),
        "b".to_owned(),
        "\u{7f}".to_owned(),
        "é".to_owned(),
        "中文".to_owned(),
        "😀".to_owned(),
        "\u{ffff}".to_owned(),
    ];
    for tail in ["", "\0", "a", "b", "\u{ff}", "aa", "a\0", "ab"] {
        strings.push(format!("{inline}{tail}"));
        strings.push(format!("{}{tail}", &inline[..63]));
        strings.push(format!("{compared}{tail}"));
        strings.push(format!("{}{tail}", &compared[..1_499]));
        strings.push(format!("{inline}x{tail}"));
    }
    strings
}

fn edge_bytes() -> Vec<Vec<u8>> {
    let mut bytes = vec![
        vec![],
        vec![0],
        vec![0, 0],
        vec![0, 255],
        vec![0, 1],
        vec![1],
        vec![255],
        vec![255, 0],
        vec![255, 255],
    ];
    for tail in [&[][..], &[0], &[1], &[255], &[0, 0], &[0, 255]] {
        bytes.push([vec![7_u8; 64], tail.to_vec()].concat());
        bytes.push([vec![0_u8; 64], tail.to_vec()].concat());
        bytes.push([vec![7_u8; 1_500], tail.to_vec()].concat());
        bytes.push([vec![255_u8; 63], tail.to_vec()].concat());
    }
    bytes
}

fn edge_references() -> Vec<Value> {
    let long = "r".repeat(260);
    vec![
        reference("a/b"),
        reference("a/b/c/d"),
        reference("a/b0"),
        reference("a/__id5__"),
        reference("a/__id05__"),
        reference("a/__id-5__"),
        reference("a/__id0__"),
        reference("a/__id-0__"),
        reference("a/__id9223372036854775807__"),
        reference("a/__id-9223372036854775808__"),
        reference("a/__idx__"),
        reference("a/a"),
        reference(&format!("a/{long}")),
        reference(&format!("a/{long}x")),
        reference(&format!("a/{long}/c/d")),
        reference("b/a"),
        reference("a\u{1}/b"),
        Value::Reference(Arc::from(
            "projects/demo-order/databases/other/documents/a/b",
        )),
        Value::Reference(Arc::from("projects/p/databases/(default)/documents/a/b")),
    ]
}

/// Every edge value of every type, plus arrays, maps and vectors built from
/// a few of them.
fn edge_values() -> Vec<Value> {
    let mut values = vec![Value::Null, Value::Boolean(false), Value::Boolean(true)];
    values.extend(edge_doubles().into_iter().map(Value::Double));
    values.extend(edge_integers().into_iter().map(Value::Integer));
    for (seconds, nanos) in [
        (i64::MIN, 0),
        (i64::MIN, 999_999_999),
        (-1, 999_999_999),
        (-1, 0),
        (0, 0),
        (0, 1),
        (1, 0),
        (i64::MAX, 0),
        (i64::MAX, 999_999_999),
    ] {
        values.push(Value::Timestamp(Timestamp::new(seconds, nanos).unwrap()));
    }
    values.extend(edge_strings().iter().map(|value| text(value)));
    values.extend(
        edge_bytes()
            .into_iter()
            .map(|value| Value::Bytes(value.into())),
    );
    values.extend(edge_references());
    for (latitude, longitude) in [
        (f64::NAN, 0.0),
        (-90.0, -180.0),
        (-0.0, f64::NAN),
        (0.0, -0.0),
        (0.0, 1.0),
        (90.0, 180.0),
        (1.5, -2.5),
    ] {
        values.push(Value::GeoPoint {
            latitude,
            longitude,
        });
    }
    values.extend([
        Value::Array(Vec::new()),
        Value::Array(vec![Value::Null]),
        Value::Array(vec![Value::Null, Value::Boolean(false)]),
        Value::Array(vec![Value::Integer(1)]),
        Value::Array(vec![Value::Double(1.0)]),
        Value::Array(vec![Value::Array(Vec::new())]),
        Value::Array(vec![text(&"x".repeat(1_600))]),
        Value::Vector(Vec::new()),
        Value::Vector(vec![9.0]),
        Value::Vector(vec![f64::NAN]),
        Value::Vector(vec![-0.0]),
        Value::Vector(vec![0.0, 0.0]),
        Value::Vector(vec![0.0, 1.0]),
        Value::Map(BTreeMap::new()),
        Value::Map(BTreeMap::from([("a".to_owned(), Value::Null)])),
        Value::Map(BTreeMap::from([("a".to_owned(), Value::Integer(1))])),
        Value::Map(BTreeMap::from([("a".to_owned(), Value::Double(1.0))])),
        Value::Map(BTreeMap::from([
            ("a".to_owned(), Value::Null),
            ("b".to_owned(), Value::Boolean(false)),
        ])),
        Value::Map(BTreeMap::from([("b".to_owned(), Value::Null)])),
    ]);
    values
}

fn random_double(random: &mut Lcg) -> f64 {
    match random.below(6) {
        // Any bit pattern: NaNs, infinities, subnormals and everything else.
        0 => f64::from_bits(random.wide()),
        // Small fractional values on both sides of zero.
        #[allow(clippy::cast_precision_loss)]
        1 => (random.wide() % 2_000_001) as f64 / 1_000.0 - 1_000.0,
        // Near the edges of the integers' range.
        2 => {
            let anchor = *[TWO_POW_63, -TWO_POW_63, 9_007_199_254_740_992.0][random.below(3)..]
                .first()
                .unwrap();
            let mut value = anchor;
            for _ in 0..random.below(4) {
                value = if random.below(2) == 0 {
                    next_up(value)
                } else {
                    next_down(value)
                };
            }
            value
        }
        // Integral doubles that equal some integer.
        #[allow(clippy::cast_precision_loss)]
        3 => (random.wide().cast_signed() >> random.below(64)) as f64,
        #[allow(clippy::cast_precision_loss)]
        4 => (random.wide().cast_signed() % 7) as f64 + 0.5,
        _ => -f64::from_bits(random.wide() >> 2),
    }
}

#[allow(clippy::cast_possible_wrap)]
fn random_integer(random: &mut Lcg) -> i64 {
    match random.below(4) {
        0 => random.wide() as i64,
        1 => (random.wide() as i64) >> random.below(64),
        2 => i64::try_from(random.below(7)).unwrap() - 3,
        _ => 9_007_199_254_740_992 + i64::try_from(random.below(5)).unwrap() - 2,
    }
}

fn random_text(random: &mut Lcg) -> String {
    let alphabet = ['\0', '\u{1}', 'a', 'b', 'é', '😀', '\u{ffff}'];
    let base = match random.below(4) {
        0 => String::new(),
        1 => "s".repeat(60 + random.below(8)),
        2 => "c".repeat(1_496 + random.below(8)),
        _ => "q".repeat(random.below(4)),
    };
    let mut value = base;
    for _ in 0..random.below(4) {
        value.push(alphabet[random.below(alphabet.len())]);
    }
    value
}

fn random_value(random: &mut Lcg, depth: usize) -> Value {
    match random.below(if depth > 1 { 9 } else { 12 }) {
        0 => Value::Null,
        1 => Value::Boolean(random.below(2) == 0),
        2 | 3 => Value::Double(random_double(random)),
        4 => Value::Integer(random_integer(random)),
        5 => Value::Timestamp(
            Timestamp::new(
                random_integer(random),
                u32::try_from(random.below(1_000_000_000)).unwrap(),
            )
            .unwrap(),
        ),
        6 => Value::String(random_text(random).into()),
        7 => Value::Bytes(random_text(random).into_bytes().into()),
        8 => {
            let ids = ["a", "b", "__id1__", "__id01__", "__id-1__", "x\u{1}y"];
            let mut path = String::new();
            for index in 0..2 * (1 + random.below(2)) {
                if index > 0 {
                    path.push('/');
                }
                path.push_str(ids[random.below(ids.len())]);
            }
            reference(&path)
        }
        9 => Value::Array(
            (0..random.below(3))
                .map(|_| random_value(random, depth + 1))
                .collect(),
        ),
        10 => Value::Vector(
            (0..random.below(3))
                .map(|_| random_double(random))
                .collect(),
        ),
        _ => Value::Map(
            (0..random.below(3))
                .map(|_| {
                    (
                        ["a", "b", ""][random.below(3)].to_owned(),
                        random_value(random, depth + 1),
                    )
                })
                .collect(),
        ),
    }
}

fn group(key: &FieldIndexKey) -> &[u8] {
    &key.bytes[..key.group]
}

/// Checks one ordered pair; `left` and `right` are any two values.
fn check_pair(left: &Value, right: &Value, edition: DatabaseEdition) {
    let ordering = compare_values(left, right, edition);
    let (left_key, right_key) = (field_index_key(left), field_index_key(right));
    match ordering {
        Ordering::Equal => assert_eq!(
            left_key.bytes, right_key.bytes,
            "{edition:?}: {left:?} == {right:?} need one key"
        ),
        Ordering::Less => {
            let tied = !left_key.exact && !right_key.exact && group(&left_key) == group(&right_key);
            assert!(
                tied || left_key.bytes < right_key.bytes,
                "{edition:?}: {left:?} < {right:?} need a smaller key or one group: {left_key:?} {right_key:?}"
            );
        }
        Ordering::Greater => check_pair(right, left, edition),
    }
    if left_key.exact && left_key.bytes == right_key.bytes {
        assert_eq!(
            ordering,
            Ordering::Equal,
            "{edition:?}: an exact key is shared by {left:?} and {right:?}"
        );
    }
    if left_key.bytes != right_key.bytes {
        assert!(
            !right_key.bytes.starts_with(&left_key.bytes),
            "{left:?}'s key is a prefix of {right:?}'s"
        );
    }
    if !left_key.exact && right_key.exact {
        assert!(
            !right_key.bytes.starts_with(group(&left_key)),
            "exact {right:?} falls inside the group of {left:?}"
        );
    }
}

#[test]
fn every_pair_of_edge_values_is_keyed_in_the_query_order() {
    let values = edge_values();
    let mut pairs = 0_usize;
    for left in &values {
        for right in &values {
            for edition in [DatabaseEdition::Standard, DatabaseEdition::Enterprise] {
                check_pair(left, right, edition);
                pairs += 1;
            }
        }
    }
    assert!(pairs > 100_000, "{pairs} pairs");
}

#[test]
fn random_values_are_keyed_in_the_query_order() {
    let edges = edge_values();
    let mut pairs = 0_usize;
    for seed in 0..40_u64 {
        let mut random = Lcg(seed.wrapping_mul(104_729).wrapping_add(11));
        let values = (0..250)
            .map(|_| random_value(&mut random, 0))
            .collect::<Vec<_>>();
        for left in &values {
            for right in values.iter().chain(&edges[..edges.len().min(40)]) {
                for edition in [DatabaseEdition::Standard, DatabaseEdition::Enterprise] {
                    check_pair(left, right, edition);
                    pairs += 1;
                }
            }
        }
    }
    assert!(pairs > 1_000_000, "{pairs} pairs");
}

#[test]
fn sorting_by_key_sorts_by_value_outside_groups() {
    // The walk's order, end to end: sort by key, sort each run of one
    // inexact group with the comparator, and the sequence is sorted.
    let mut random = Lcg(5);
    let mut values = edge_values();
    values.extend((0..2_000).map(|_| random_value(&mut random, 0)));
    for edition in [DatabaseEdition::Standard, DatabaseEdition::Enterprise] {
        let mut keyed = values
            .iter()
            .map(|value| (field_index_key(value), value))
            .collect::<Vec<_>>();
        keyed.sort_by(|left, right| left.0.bytes.cmp(&right.0.bytes));
        let mut walked: Vec<&Value> = Vec::with_capacity(keyed.len());
        let mut index = 0;
        while index < keyed.len() {
            let mut end = index + 1;
            if !keyed[index].0.exact {
                while end < keyed.len()
                    && !keyed[end].0.exact
                    && group(&keyed[end].0) == group(&keyed[index].0)
                {
                    end += 1;
                }
            }
            let mut run = keyed[index..end]
                .iter()
                .map(|(_, value)| *value)
                .collect::<Vec<_>>();
            run.sort_by(|left, right| compare_values(left, right, edition));
            walked.extend(run);
            index = end;
        }
        for pair in walked.windows(2) {
            assert_ne!(
                compare_values(pair[0], pair[1], edition),
                Ordering::Greater,
                "{edition:?}: {:?} walked before {:?}",
                pair[0],
                pair[1]
            );
        }
    }
}

#[test]
fn short_values_are_exact_and_long_ones_keep_a_narrow_digest() {
    for value in [
        Value::Integer(7),
        Value::Double(-0.3),
        text(&"a".repeat(64)),
        Value::Bytes(vec![0; 64].into()),
        reference("a/b"),
        Value::Array(Vec::new()),
    ] {
        assert!(field_index_key(&value).exact, "{value:?}");
    }
    let left = field_index_key(&text(&("s".repeat(64) + "a")));
    let right = field_index_key(&text(&("s".repeat(64) + "b")));
    assert!(!left.exact && !right.exact);
    assert_eq!(group(&left), group(&right), "one group for one prefix");
    assert_ne!(left.bytes, right.bytes, "the digest keeps equality narrow");
}
