//! The list implementation the seek-skip walk replaced, kept verbatim as the
//! oracle its property test compares every page against. It scans every
//! object below the prefix twice per page, which is exactly why it was
//! replaced; nothing outside the tests calls it.

use std::collections::BTreeSet;

use crate::listing::ObjectListPage;
use crate::{StorageData, StoredObject, object_key};

pub(crate) fn list_objects_reference<'a>(
    data: &'a StorageData,
    bucket: &str,
    prefix: &str,
    delimiter: Option<&str>,
    page_token: Option<&str>,
    maximum: usize,
) -> ObjectListPage<'a> {
    let first_key = object_key(bucket, prefix);
    let scoped = || {
        data.objects
            .range(first_key.clone()..)
            .map(|(_, object)| object)
            .take_while(|object| object.bucket == bucket && object.name.starts_with(prefix))
    };
    let item_prefix = |object: &StoredObject| {
        delimiter.and_then(|delimiter| {
            object.name[prefix.len()..].find(delimiter).map(|index| {
                let end = prefix.len() + index + delimiter.len();
                object.name[..end].to_owned()
            })
        })
    };

    let mut prefixes = BTreeSet::new();
    let mut token_present = page_token.is_none();
    for object in scoped() {
        if let Some(group) = item_prefix(object) {
            prefixes.insert(group);
        } else if page_token == Some(object.name.as_str()) {
            token_present = true;
        }
    }

    let mut started = page_token.is_none() || !token_present;
    let mut items = Vec::with_capacity(maximum.min(1_000));
    let mut next_page_token = None;
    for object in scoped().filter(|object| item_prefix(object).is_none()) {
        if !started {
            if page_token == Some(object.name.as_str()) {
                started = true;
            } else {
                continue;
            }
        }
        if items.len() == maximum {
            next_page_token = Some(object.name.clone());
            break;
        }
        items.push(object);
    }

    ObjectListPage {
        items,
        prefixes: prefixes.into_iter().collect(),
        next_page_token,
    }
}
