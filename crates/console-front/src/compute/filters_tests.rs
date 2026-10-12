use firenook_functions_runtime::monitor::{
    EventarcEventSummary, EventarcOrigin, FunctionKind, InvocationCause, InvocationOutcome,
    InvocationOutcomeClass, InvocationSummary,
};

use super::super::tests::summary;
use super::*;

fn keeps(q: &str, record: &InvocationSummary) -> bool {
    let filter = invocation_filter(q)
        .expect("a valid filter")
        .expect("not empty");
    filter(record)
}

#[test]
fn an_empty_filter_compiles_to_nothing() {
    assert!(invocation_filter("").expect("valid").is_none());
    assert!(invocation_filter("   ").expect("valid").is_none());
    assert!(event_filter("").expect("valid").is_none());
}

#[test]
fn exact_fields_match_whole_values_or_prefixes_and_fn_is_function() {
    let api = summary(1, "us-central1-api", FunctionKind::Http);
    assert!(keeps("function:us-central1-api", &api));
    assert!(keeps("fn:us-central1-api", &api));
    assert!(keeps("function:us-central1-*", &api));
    assert!(!keeps("function:us-central1-ap", &api));
    assert!(!keeps("function:US-CENTRAL1-API", &api));
    assert!(keeps("codebase:default", &api));
    assert!(!keeps("codebase:jobs", &api));
}

#[test]
fn repeated_keys_match_any_value_and_negation_excludes_on_its_own() {
    let api = summary(1, "us-central1-api", FunctionKind::Http);
    let order = summary(2, "us-central1-onOrder", FunctionKind::Firestore);
    let either = "kind:http kind:firestore";
    assert!(keeps(either, &api));
    assert!(keeps(either, &order));
    assert!(!keeps("kind:pubsub", &order));
    assert!(keeps("-kind:http", &order));
    assert!(!keeps("-kind:http", &api));
    assert!(!keeps("kind:http -function:us-central1-api", &api));
}

#[test]
fn outcome_is_the_class_and_running_ones_have_no_duration() {
    let mut failed = summary(1, "us-central1-api", FunctionKind::Http);
    failed.outcome = Some(InvocationOutcome::Failed);
    failed.outcome_class = InvocationOutcomeClass::Failed;
    failed.status = Some(500);
    assert!(keeps("outcome:failed", &failed));
    assert!(!keeps("outcome:succeeded", &failed));
    assert!(keeps("status:500", &failed));
    assert!(keeps("status:>=500", &failed));
    assert!(!keeps("status:<500", &failed));
    let mut running = summary(2, "us-central1-api", FunctionKind::Http);
    running.duration_ms = None;
    running.outcome = None;
    running.outcome_class = InvocationOutcomeClass::Running;
    running.status = None;
    assert!(keeps("outcome:running", &running));
    assert!(!keeps("took:>1ms", &running));
    assert!(!keeps("status:200", &running));
}

#[test]
fn durations_times_and_flags() {
    let mut slow = summary(1, "us-central1-api", FunctionKind::Http);
    slow.duration_ms = Some(450.0);
    slow.cold = true;
    assert!(keeps("took:>200ms", &slow));
    assert!(keeps("took:<1s", &slow));
    assert!(!keeps("took:>0.5s", &slow));
    assert!(keeps("is:cold", &slow));
    assert!(!keeps("is:replay", &slow));
    slow.replay_of = Some("abc123-0".to_owned());
    assert!(keeps("is:replay", &slow));
    assert!(keeps("at:2026-10-12", &slow));
    assert!(!keeps("at:2026-10-11", &slow));
    assert!(keeps("at:>2026-10-11", &slow));
    assert!(keeps("at:<2026-10-13", &slow));
    assert!(keeps("at:2026-10-12T07:59:59Z", &slow));
    assert!(!keeps("at:2026-10-12T08:00:01Z", &slow));
    assert!(keeps("origin:emulator", &slow));
    assert!(!keeps("origin:console", &slow));
}

#[test]
fn words_search_the_summary_path_error_and_function() {
    let mut call = summary(1, "us-central1-api", FunctionKind::Http);
    call.cause = InvocationCause::Http {
        method: "GET".to_owned(),
        path: "/users/42".to_owned(),
    };
    call.summary = "GET /users/42".to_owned();
    call.error = Some("TypeError: x is undefined".to_owned());
    assert!(keeps("users", &call));
    assert!(keeps("TYPEERROR", &call));
    assert!(keeps("central1", &call));
    assert!(keeps("\"is undefined\"", &call));
    assert!(!keeps("orders", &call));
    assert!(keeps("-orders", &call));
    assert!(!keeps("-users", &call));
}

#[test]
fn unknown_keys_and_bad_values_are_refused_with_their_span() {
    let error = invocation_filter("fn:a nope:b")
        .err()
        .expect("an unknown key");
    assert!(
        error.message.contains("Unknown filter"),
        "{}",
        error.message
    );
    assert_eq!((error.from, error.to), (5, 11));
    let error = invocation_filter("took:fast").err().expect("a bad value");
    assert!(error.message.contains("duration"), "{}", error.message);
    let error = invocation_filter("outcome:exploded")
        .err()
        .expect("not a class");
    assert!(error.message.contains("succeeded"), "{}", error.message);
    let error = invocation_filter("function:>a").err().expect("no range");
    assert!(error.message.contains("works on"), "{}", error.message);
}

fn event() -> EventarcEventSummary {
    EventarcEventSummary {
        id: "abc123-7".to_owned(),
        seq: 7,
        event_id: Some("e-1".to_owned()),
        received_at: "2026-10-12T08:00:00.000Z".to_owned(),
        channel: "projects/demo/locations/us-central1/channels/firebase".to_owned(),
        event_type: "test.greeter.v1.greeted".to_owned(),
        source: Some("projects/demo/instances/greeter".to_owned()),
        subject: Some("ada".to_owned()),
        publisher: Some("greeter".to_owned()),
        origin: EventarcOrigin::App,
        matched: 2,
        delivered: 1,
        failed: 0,
        pending: 1,
        filtered: 1,
        unheard: false,
        error: None,
    }
}

fn keeps_event(q: &str, record: &EventarcEventSummary) -> bool {
    let filter = event_filter(q).expect("a valid filter").expect("not empty");
    filter(record)
}

#[test]
fn events_filter_by_type_prefix_delivery_origin_and_words() {
    let greeted = event();
    assert!(keeps_event("type:test.greeter.*", &greeted));
    assert!(!keeps_event("type:test.other.*", &greeted));
    assert!(keeps_event("publisher:greeter", &greeted));
    assert!(keeps_event("subject:ada", &greeted));
    assert!(keeps_event("source:projects/demo/instances/*", &greeted));
    assert!(keeps_event("delivery:delivered", &greeted));
    assert!(keeps_event("delivery:filtered", &greeted));
    assert!(keeps_event("delivery:pending", &greeted));
    assert!(!keeps_event("delivery:unheard", &greeted));
    assert!(!keeps_event("delivery:failed", &greeted));
    assert!(keeps_event("origin:app", &greeted));
    assert!(!keeps_event("origin:console", &greeted));
    assert!(keeps_event("greeted", &greeted));
    assert!(keeps_event("at:2026-10-12", &greeted));
    let mut broken = event();
    broken.error = Some("The event has no source.".to_owned());
    assert!(keeps_event("delivery:failed", &broken));
    let error = event_filter("kind:x").err().expect("unknown");
    assert!(
        error.message.contains("Unknown filter"),
        "{}",
        error.message
    );
}
