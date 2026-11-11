use serde_json::json;

use super::*;

/// A file as `firebase firestore:indexes` writes it.
const CLI_FILE: &str = r#"{
  "indexes": [
    {
      "collectionGroup": "users",
      "queryScope": "COLLECTION",
      "fields": [
        {
          "fieldPath": "plan",
          "order": "ASCENDING"
        },
        {
          "fieldPath": "lastSeen",
          "order": "DESCENDING"
        }
      ]
    }
  ],
  "fieldOverrides": []
}
"#;

const ORDERS_ENTRY: &str = r#"{
      "collectionGroup": "orders",
      "queryScope": "COLLECTION",
      "fields": [
        {
          "fieldPath": "status",
          "order": "ASCENDING"
        },
        {
          "fieldPath": "total",
          "order": "DESCENDING"
        }
      ]
    }"#;

fn orders() -> Value {
    json!({
        "collectionGroup": "orders",
        "queryScope": "COLLECTION",
        "fields": [
            {"fieldPath": "status", "order": "ASCENDING"},
            {"fieldPath": "total", "order": "DESCENDING"},
        ],
    })
}

fn users() -> Value {
    json!({
        "collectionGroup": "users",
        "queryScope": "COLLECTION",
        "fields": [
            {"fieldPath": "plan", "order": "ASCENDING"},
            {"fieldPath": "lastSeen", "order": "DESCENDING"},
        ],
    })
}

fn add(source: Option<&str>, section: Section, entry: Value) -> (String, Outcome) {
    edit(source, &[(section, entry)], &[]).expect("edited")
}

fn remove(source: &str, section: Section, entry: Value) -> (String, Outcome) {
    edit(Some(source), &[], &[(section, entry)]).expect("edited")
}

/// An added index goes after the last one, laid out as the CLI lays one
/// out, and nothing else in the file moves.
#[test]
fn an_index_is_added_after_the_last_one_and_nothing_else_moves() {
    let (text, outcome) = add(Some(CLI_FILE), Section::Indexes, orders());
    assert_eq!(
        outcome,
        Outcome {
            added: 1,
            removed: 0,
            unchanged: 0
        }
    );
    let expected = CLI_FILE.replacen(
        "      ]\n    }\n  ],",
        &format!("      ]\n    }},\n    {ORDERS_ENTRY}\n  ],"),
        1,
    );
    assert_eq!(text, expected);
}

/// An index the file already declares, written another way, is not added
/// twice.
#[test]
fn an_index_already_declared_is_left_alone() {
    // Another direction is another index in the file, whatever queries
    // it serves.
    let reversed = json!({
        "collectionGroup": "users",
        "fields": [
            {"fieldPath": "plan", "order": "DESCENDING"},
            {"fieldPath": "lastSeen", "order": "DESCENDING"},
        ],
    });
    let (_, outcome) = add(Some(CLI_FILE), Section::Indexes, reversed);
    assert_eq!(outcome.added, 1);
    let spelled_out = json!({
        "collectionGroup": "users",
        "fields": [
            {"fieldPath": "plan", "mode": "ASCENDING"},
            {"fieldPath": "lastSeen", "order": "DESCENDING"},
            {"fieldPath": "__name__", "order": "DESCENDING"},
        ],
    });
    let (text, outcome) = add(Some(CLI_FILE), Section::Indexes, spelled_out);
    assert_eq!(text, CLI_FILE);
    assert_eq!(
        outcome,
        Outcome {
            added: 0,
            removed: 0,
            unchanged: 1
        }
    );
}

/// Taking an entry out takes its comma with it, wherever it is in the list,
/// and the last one leaves `[]`.
#[test]
fn an_entry_is_taken_out_with_its_comma() {
    let (two, _) = add(Some(CLI_FILE), Section::Indexes, orders());
    let (first_gone, outcome) = remove(&two, Section::Indexes, users());
    assert_eq!(outcome.removed, 1);
    assert_eq!(
        first_gone,
        CLI_FILE.replacen(
            &CLI_FILE
                [CLI_FILE.find("    {").expect("entry")..CLI_FILE.find("\n  ],").expect("end")],
            &format!("    {ORDERS_ENTRY}"),
            1
        )
    );
    let (last_gone, _) = remove(&two, Section::Indexes, orders());
    assert_eq!(last_gone, CLI_FILE);
    let (empty, _) = remove(CLI_FILE, Section::Indexes, users());
    assert_eq!(
        empty,
        "{\n  \"indexes\": [],\n  \"fieldOverrides\": []\n}\n"
    );
    // And back: an empty list is spread over lines again.
    let (again, _) = add(Some(&empty), Section::Indexes, users());
    assert_eq!(again, CLI_FILE);
    // Nothing to take out is not a failure.
    let (same, outcome) = remove(CLI_FILE, Section::Indexes, orders());
    assert_eq!(same, CLI_FILE);
    assert_eq!(outcome.unchanged, 1);
}

/// The first index of a database whose file is not there yet makes the file
/// the CLI would.
#[test]
fn the_first_index_makes_the_file() {
    let (text, outcome) = add(None, Section::Indexes, orders());
    assert_eq!(outcome.added, 1);
    assert_eq!(
        text,
        format!("{{\n  \"indexes\": [\n    {ORDERS_ENTRY}\n  ],\n  \"fieldOverrides\": []\n}}\n")
    );
}

/// A file without the section gets it, after what it has.
#[test]
fn a_missing_section_is_added_at_the_end() {
    let source = "{\n  \"indexes\": []\n}\n";
    let override_ = json!({
        "collectionGroup": "items",
        "fieldPath": "a",
        "indexes": [{"order": "ASCENDING", "queryScope": "COLLECTION_GROUP"}],
    });
    let (text, _) = add(Some(source), Section::FieldOverrides, override_);
    assert_eq!(
        text,
        "{\n  \"indexes\": [],\n  \"fieldOverrides\": [\n    {\n      \"collectionGroup\": \"items\",\n      \"fieldPath\": \"a\",\n      \"indexes\": [\n        {\n          \"order\": \"ASCENDING\",\n          \"queryScope\": \"COLLECTION_GROUP\"\n        }\n      ]\n    }\n  ]\n}\n"
    );
    let (empty_object, _) = add(Some("{}"), Section::Indexes, users());
    IndexCatalog::from_json(&empty_object).expect("valid");
    assert!(empty_object.starts_with("{\n  \"indexes\": [\n    {\n"));
}

/// An override for a field the file overrides already adds the indexes it
/// lacks to that override, which keeps everything else it says.
#[test]
fn an_override_for_a_field_already_overridden_adds_to_it() {
    let source = r#"{
  "indexes": [],
  "fieldOverrides": [
    {
      "collectionGroup": "items",
      "fieldPath": "expiresAt",
      "ttl": true,
      "indexes": [
        {
          "order": "ASCENDING",
          "queryScope": "COLLECTION"
        }
      ]
    }
  ]
}
"#;
    let wanted = json!({
        "collectionGroup": "items",
        "fieldPath": "expiresAt",
        "indexes": [
            {"order": "ASCENDING", "queryScope": "COLLECTION"},
            {"order": "ASCENDING", "queryScope": "COLLECTION_GROUP"},
        ],
    });
    let (text, outcome) = add(Some(source), Section::FieldOverrides, wanted.clone());
    assert_eq!(outcome.added, 1);
    assert_eq!(
        text,
        source.replacen(
            "          \"queryScope\": \"COLLECTION\"\n        }\n",
            "          \"queryScope\": \"COLLECTION\"\n        },\n        {\n          \"order\": \"ASCENDING\",\n          \"queryScope\": \"COLLECTION_GROUP\"\n        }\n",
            1
        )
    );
    // Asked again, it changes nothing.
    let (again, outcome) = add(Some(&text), Section::FieldOverrides, wanted);
    assert_eq!(again, text);
    assert_eq!(outcome.unchanged, 1);
}

/// A file written on one line stays on one; four spaces and CRLF stay four
/// spaces and CRLF.
#[test]
fn the_file_keeps_its_own_layout() {
    let (one_line, _) = add(
        Some(r#"{"indexes":[],"fieldOverrides":[]}"#),
        Section::Indexes,
        users(),
    );
    assert_eq!(
        one_line,
        r#"{"indexes":[{"collectionGroup":"users","queryScope":"COLLECTION","fields":[{"fieldPath":"plan","order":"ASCENDING"},{"fieldPath":"lastSeen","order":"DESCENDING"}]}],"fieldOverrides":[]}"#
    );
    let (two, _) = add(Some(&one_line), Section::Indexes, orders());
    assert!(two.contains(r#"]}, {"collectionGroup":"orders""#), "{two}");
    IndexCatalog::from_json(&two).expect("valid");

    let wide = CLI_FILE.replace("  ", "    ").replace('\n', "\r\n");
    let (text, _) = add(Some(&wide), Section::Indexes, orders());
    let expected_entry = ORDERS_ENTRY.replace("  ", "    ").replace('\n', "\r\n");
    assert!(
        text.contains(&format!("}},\r\n        {expected_entry}\r\n    ],")),
        "{text}"
    );
}

/// Names out of ASCII are spliced around, not through.
#[test]
fn names_out_of_ascii_survive() {
    let source = "{\n  \"indexes\": [\n    {\"collectionGroup\": \"commandes_été\", \"fields\": [{\"fieldPath\": \"état\", \"order\": \"ASCENDING\"}, {\"fieldPath\": \"総額\", \"order\": \"DESCENDING\"}]}\n  ]\n}\n";
    let (text, _) = add(Some(source), Section::Indexes, orders());
    assert!(text.starts_with(&source[..source.find("\n  ]").expect("end")]));
    let (back, _) = remove(&text, Section::Indexes, orders());
    assert_eq!(back, source);
}

/// A file that is not a valid index file, or an entry that is not a valid
/// index, changes nothing.
#[test]
fn what_is_not_valid_is_refused() {
    assert!(edit(Some("{\"indexes\": ["), &[(Section::Indexes, users())], &[]).is_err());
    assert!(edit(Some("[]"), &[(Section::Indexes, users())], &[]).is_err());
    assert!(
        edit(
            Some(CLI_FILE),
            &[(
                Section::Indexes,
                json!({"collectionGroup": "x", "fields": [{"fieldPath": "a"}]})
            )],
            &[]
        )
        .is_err()
    );
    assert!(
        edit(
            Some(CLI_FILE),
            &[(
                Section::Indexes,
                json!({"collectionGroup": "x", "fields": []})
            )],
            &[]
        )
        .is_err()
    );
    assert!(
        edit(
            Some(CLI_FILE),
            &[(Section::FieldOverrides, json!({"collectionGroup": "x"}))],
            &[]
        )
        .is_err()
    );
}

/// An override written without `indexes` (a field left out of every index)
/// gets the list, holding the index required, not a list inside a list.
#[test]
fn an_override_without_indexes_gets_the_list() {
    let source = "{\n  \"fieldOverrides\": [\n    {\n      \"collectionGroup\": \"items\",\n      \"fieldPath\": \"a\"\n    }\n  ]\n}\n";
    let wanted = json!({
        "collectionGroup": "items",
        "fieldPath": "a",
        "indexes": [{"order": "ASCENDING", "queryScope": "COLLECTION_GROUP"}],
    });
    let (text, outcome) = add(Some(source), Section::FieldOverrides, wanted);
    assert_eq!(outcome.added, 1);
    assert_eq!(
        text,
        "{\n  \"fieldOverrides\": [\n    {\n      \"collectionGroup\": \"items\",\n      \"fieldPath\": \"a\",\n      \"indexes\": [\n        {\n          \"order\": \"ASCENDING\",\n          \"queryScope\": \"COLLECTION_GROUP\"\n        }\n      ]\n    }\n  ]\n}\n"
    );
}
