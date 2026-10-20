//! Timestamp values at the precision Firestore stores them.
//!
//! Firestore keeps a timestamp value to the microsecond: "When stored in
//! Cloud Firestore, precise only to microseconds; any additional precision
//! is rounded down" (the supported data types reference). The official
//! emulator does the same: a REST write of `…05.123456789Z` answers, and
//! shows rules, `…05.123456Z` (`conformance/fixtures/developer-tools-request-values-v1`).
//! Each front rounds a write down as it decodes it, before rules see it, and
//! every commit does again, so no write path stores a finer value.

use std::borrow::Cow;

use crate::{FieldTransform, Fields, Timestamp, TransformOperation, Value, Write};

impl Timestamp {
    /// The timestamp rounded down to a whole microsecond. The nanosecond
    /// fraction is never negative, so this rounds towards the past for
    /// times before the epoch too.
    #[must_use]
    pub const fn to_microseconds(self) -> Self {
        Self {
            seconds: self.seconds,
            nanos: self.nanos - self.nanos % 1_000,
        }
    }

    /// Whether the timestamp is finer than a microsecond.
    #[must_use]
    pub const fn is_finer_than_microseconds(self) -> bool {
        !self.nanos.is_multiple_of(1_000)
    }
}

impl Value {
    /// The value with every timestamp in it, however deep in maps and
    /// arrays, rounded down to a whole microsecond.
    #[must_use]
    pub fn at_stored_precision(mut self) -> Self {
        round_value(&mut self);
        self
    }
}

impl FieldTransform {
    /// The transform with every timestamp in its operand rounded down to a
    /// whole microsecond.
    #[must_use]
    pub fn at_stored_precision(mut self) -> Self {
        round_transform(&mut self);
        self
    }
}

impl Write {
    /// The write with every timestamp value it stores rounded down to a
    /// whole microsecond: its fields and its transforms' operands, nested in
    /// maps and arrays too. Preconditions are times to compare, not values
    /// to store, and are left as they are.
    #[must_use]
    pub fn at_stored_precision(mut self) -> Self {
        if write_is_finer(&self) {
            round_write(&mut self);
        }
        self
    }
}

/// The writes as a commit stores them; borrowed when none holds a
/// timestamp finer than a microsecond, as nearly all do.
pub(crate) fn stored_precision(writes: &[Write]) -> Cow<'_, [Write]> {
    if !writes.iter().any(write_is_finer) {
        return Cow::Borrowed(writes);
    }
    let mut owned = writes.to_vec();
    owned.iter_mut().for_each(round_write);
    Cow::Owned(owned)
}

fn write_is_finer(write: &Write) -> bool {
    match write {
        Write::Create { fields, .. } => fields_are_finer(fields),
        Write::Set {
            fields, transforms, ..
        }
        | Write::Patch {
            fields, transforms, ..
        } => fields_are_finer(fields) || transforms.iter().any(transform_is_finer),
        Write::Delete { .. } | Write::Verify { .. } => false,
    }
}

fn fields_are_finer(fields: &Fields) -> bool {
    fields.values().any(value_is_finer)
}

fn transform_is_finer(transform: &FieldTransform) -> bool {
    match &transform.operation {
        TransformOperation::ServerTimestamp => false,
        TransformOperation::Increment(value)
        | TransformOperation::Maximum(value)
        | TransformOperation::Minimum(value) => value_is_finer(value),
        TransformOperation::ArrayUnion(values) | TransformOperation::ArrayRemove(values) => {
            values.iter().any(value_is_finer)
        }
    }
}

fn value_is_finer(value: &Value) -> bool {
    match value {
        Value::Timestamp(timestamp) => timestamp.is_finer_than_microseconds(),
        Value::Array(values) => values.iter().any(value_is_finer),
        Value::Map(fields) => fields.values().any(value_is_finer),
        _ => false,
    }
}

fn round_write(write: &mut Write) {
    match write {
        Write::Create { fields, .. } => round_fields(fields),
        Write::Set {
            fields, transforms, ..
        }
        | Write::Patch {
            fields, transforms, ..
        } => {
            round_fields(fields);
            transforms.iter_mut().for_each(round_transform);
        }
        Write::Delete { .. } | Write::Verify { .. } => {}
    }
}

fn round_fields(fields: &mut Fields) {
    fields.values_mut().for_each(round_value);
}

fn round_transform(transform: &mut FieldTransform) {
    match &mut transform.operation {
        TransformOperation::ServerTimestamp => {}
        TransformOperation::Increment(value)
        | TransformOperation::Maximum(value)
        | TransformOperation::Minimum(value) => round_value(value),
        TransformOperation::ArrayUnion(values) | TransformOperation::ArrayRemove(values) => {
            values.iter_mut().for_each(round_value);
        }
    }
}

fn round_value(value: &mut Value) {
    match value {
        Value::Timestamp(timestamp) => *timestamp = timestamp.to_microseconds(),
        Value::Array(values) => values.iter_mut().for_each(round_value),
        Value::Map(fields) => round_fields(fields),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::{DatabaseName, DocumentKey, FieldPath, Precondition, Store, StoreOptions};

    fn fine(seconds: i64, nanos: u32) -> Value {
        Value::Timestamp(Timestamp::new(seconds, nanos).unwrap())
    }

    fn key(path: &str) -> DocumentKey {
        DocumentKey::new(
            DatabaseName::new("demo-precision", "(default)").unwrap(),
            path,
        )
        .unwrap()
    }

    #[test]
    fn a_timestamp_is_rounded_down_to_the_microsecond() {
        let rounded = Timestamp::new(1_577_934_245, 123_456_789)
            .unwrap()
            .to_microseconds();
        assert_eq!(rounded, Timestamp::new(1_577_934_245, 123_456_000).unwrap());
        // Rounded down, never to the nearest.
        let almost = Timestamp::new(7, 999_999_999).unwrap().to_microseconds();
        assert_eq!(almost, Timestamp::new(7, 999_999_000).unwrap());
        // Before the epoch: -0.0000005 s is -1 s + 0.9999995 s, so down is
        // -0.000001 s.
        let before = Timestamp::new(-1, 999_999_500).unwrap().to_microseconds();
        assert_eq!(before, Timestamp::new(-1, 999_999_000).unwrap());
        let whole = Timestamp::new(3, 5_000).unwrap();
        assert_eq!(whole.to_microseconds(), whole);
        assert!(!whole.is_finer_than_microseconds());
        assert!(
            Timestamp::new(3, 5_001)
                .unwrap()
                .is_finer_than_microseconds()
        );
    }

    #[test]
    fn nested_values_and_transform_operands_are_rounded() {
        let fields = Fields::from([
            ("top".to_owned(), fine(1, 1)),
            (
                "map".to_owned(),
                Value::Map(BTreeMap::from([(
                    "inner".to_owned(),
                    Value::Array(vec![fine(2, 2_999), Value::Integer(5)]),
                )])),
            ),
        ]);
        let write = Write::Set {
            key: key("c/d"),
            fields,
            transforms: vec![FieldTransform {
                path: FieldPath::top("list").unwrap(),
                operation: TransformOperation::ArrayUnion(vec![fine(3, 3_333)]),
            }],
            precondition: Precondition::None,
        }
        .at_stored_precision();
        let Write::Set {
            fields, transforms, ..
        } = write
        else {
            unreachable!()
        };
        assert_eq!(fields["top"], fine(1, 0));
        assert_eq!(
            fields["map"],
            Value::Map(BTreeMap::from([(
                "inner".to_owned(),
                Value::Array(vec![fine(2, 2_000), Value::Integer(5)]),
            )]))
        );
        assert_eq!(
            transforms[0].operation,
            TransformOperation::ArrayUnion(vec![fine(3, 3_000)])
        );
    }

    #[test]
    fn a_commit_stores_timestamps_to_the_microsecond() {
        let store = Store::new(StoreOptions::default());
        let writes = [
            Write::Create {
                key: key("c/created"),
                fields: Fields::from([("at".to_owned(), fine(10, 123_456_789))]),
            },
            Write::Patch {
                key: key("c/patched"),
                fields: Fields::from([(
                    "nested".to_owned(),
                    Value::Map(BTreeMap::from([("at".to_owned(), fine(11, 1))])),
                )]),
                update_mask: vec![FieldPath::top("nested").unwrap()],
                transforms: vec![FieldTransform {
                    path: FieldPath::top("times").unwrap(),
                    operation: TransformOperation::ArrayUnion(vec![fine(12, 999)]),
                }],
                precondition: Precondition::None,
            },
        ];
        store.commit(&writes).unwrap();
        let snapshot = store.snapshot();
        let created = snapshot.get(&key("c/created")).unwrap();
        assert_eq!(created.fields()["at"], fine(10, 123_456_000));
        let patched = snapshot.get(&key("c/patched")).unwrap();
        assert_eq!(
            patched.fields()["nested"],
            Value::Map(BTreeMap::from([("at".to_owned(), fine(11, 0))]))
        );
        assert_eq!(patched.fields()["times"], Value::Array(vec![fine(12, 0)]));
        // A later arrayRemove of the value as first sent finds the stored one.
        store
            .commit(&[Write::Patch {
                key: key("c/patched"),
                fields: Fields::new(),
                update_mask: Vec::new(),
                transforms: vec![FieldTransform {
                    path: FieldPath::top("times").unwrap(),
                    operation: TransformOperation::ArrayRemove(vec![fine(12, 999)]),
                }],
                precondition: Precondition::None,
            }])
            .unwrap();
        let patched = store.snapshot().get(&key("c/patched")).unwrap();
        assert_eq!(patched.fields()["times"], Value::Array(Vec::new()));
    }

    #[test]
    fn writes_without_finer_timestamps_are_not_copied() {
        let writes = [Write::Create {
            key: key("c/d"),
            fields: Fields::from([("at".to_owned(), fine(1, 1_000))]),
        }];
        assert!(matches!(stored_precision(&writes), Cow::Borrowed(_)));
    }
}
