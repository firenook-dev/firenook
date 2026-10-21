//! The values of the params a codebase declares (`defineString`,
//! `defineInt`, `defineBoolean`, `defineList`, `defineSecret` …), resolved
//! as the official emulator resolves them without a terminal
//! (firebase-tools 15.22.0 `deploy/functions/params.js` `resolveParams` with
//! the CLI's non-interactive prompt guard, `prompt.js` `guard`).
//!
//! A param an env file sets takes that value. Every other non-secret param
//! goes to the prompt in declaration order, and a prompt nobody can answer
//! returns its default: a CEL default (`{{ params.PROJECT_ID }}-suffix`) is
//! resolved first, a default of the wrong type is refused, and a param with
//! no default stops the codebase loading with the official question.
//! Secrets are never prompted for in the emulator; their values come from
//! `.secret.local` when a function runs.
//!
//! Firenook never prompts, so it answers every prompt the way the official
//! emulator does when no terminal is attached. It does not write the
//! answers to `.env.local` as the official emulator does: a default is taken
//! again at every load, so a changed default applies on the next reload.
//! What a function sees in `process.env` follows the deployed function's
//! environment (`deploy/functions/prepare.js`): a param no env file sets
//! gets its value, and a list param is the JSON array `.value()` parses.
//! The official emulator hands a list over as the text it wrote
//! (`red,green`), which the SDK's `JSON.parse` refuses.
use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use crate::manifest::{DeclaredParam, ManifestError, Resolver};

/// What resolving one codebase's params produced.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResolvedParams {
    /// What a `{{ params.NAME }}` reference in the manifest reads: every
    /// env file value, and the defaults taken for the params no file sets.
    pub values: BTreeMap<String, String>,
    /// The params that took their default, with the value as the prompt's
    /// answer is written (`512`, `true`, `red,green`).
    pub defaults: BTreeMap<String, String>,
    /// What the worker's `process.env` holds for the params beyond the env
    /// files: each default taken, and every list param as a JSON array.
    pub environment: BTreeMap<String, String>,
}

/// Resolves `params` (in declaration order) against the codebase's env file
/// values and the built-in project params.
pub fn resolve(
    params: &[DeclaredParam],
    user_env: &BTreeMap<String, String>,
    builtins: &BTreeMap<String, String>,
) -> Result<ResolvedParams, ManifestError> {
    // `paramValues`: the built-ins, then each declared param as it resolves.
    let mut known = builtins.clone();
    for param in params {
        if let Some(value) = user_env.get(&param.name) {
            known.insert(param.name.clone(), value.clone());
        }
    }
    let mut defaults = BTreeMap::new();
    for param in params {
        if is_secret(param) || user_env.contains_key(&param.name) {
            continue;
        }
        let default = resolved_default(param, &known)?;
        if let Some(value) = &default
            && truthy(value)
            && !can_satisfy(param, value)
        {
            return Err(ManifestError(format!(
                "Parameter {} has default value {} of wrong type",
                param.name,
                js_string(value)
            )));
        }
        let answer = answer(param, default.as_ref())?;
        known.insert(param.name.clone(), answer.clone());
        defaults.insert(param.name.clone(), answer);
    }
    let mut values = user_env.clone();
    values.extend(defaults.clone());
    let mut environment = BTreeMap::new();
    for param in params {
        if is_secret(param) {
            continue;
        }
        let list = param.param_type == "list";
        let (raw, delimiter) = if let Some(value) = defaults.get(&param.name) {
            (value, param.delimiter.as_deref().unwrap_or(","))
        } else if list && let Some(value) = user_env.get(&param.name) {
            // An env file value reads with the default delimiter
            // (`envWithTypes`).
            (value, ",")
        } else {
            continue;
        };
        let text = if list {
            list_json(raw, delimiter)
        } else {
            raw.clone()
        };
        if !text.is_empty() {
            environment.insert(param.name.clone(), text);
        }
    }
    Ok(ResolvedParams {
        values,
        defaults,
        environment,
    })
}

fn is_secret(param: &DeclaredParam) -> bool {
    param.param_type.eq_ignore_ascii_case("secret")
}

/// The param's default, with a CEL default (`{{ params.X }}`) resolved
/// against what has resolved so far (`resolveDefaultCEL`).
fn resolved_default(
    param: &DeclaredParam,
    known: &BTreeMap<String, String>,
) -> Result<Option<Value>, ManifestError> {
    let Some(default) = &param.default else {
        return Ok(None);
    };
    if !Resolver::is_cel(default) {
        return Ok(Some(default.clone()));
    }
    let expression = default.as_str().unwrap_or_default();
    if dependencies(expression)
        .iter()
        .any(|dependency| !known.contains_key(dependency))
    {
        return Err(ManifestError(format!(
            "Build specified parameter with un-resolvable default value {expression}; dependencies missing."
        )));
    }
    let resolver = Resolver::new(known, BTreeMap::new());
    match param.param_type.as_str() {
        "int" => resolver.resolve_int(default).map(Some),
        "boolean" => resolver.resolve_boolean(default).map(Some),
        "string" | "list" => resolver
            .interpolate(expression)
            .map(|text| Some(Value::String(text))),
        _ => Err(ManifestError(format!(
            "Build specified parameter with default {expression} of unsupported type"
        ))),
    }
}

/// The params a CEL expression references (`dependenciesCEL`).
fn dependencies(expression: &str) -> Vec<String> {
    static CAPTURE: OnceLock<Regex> = OnceLock::new();
    CAPTURE
        .get_or_init(|| Regex::new(r"\{\{ params\.([A-Za-z0-9_]+) \}\}").expect("static regex"))
        .captures_iter(expression)
        .map(|captures| captures[1].to_owned())
        .collect()
}

/// `canSatisfyParam`. A type the official CLI does not know (`float`) takes
/// any default.
fn can_satisfy(param: &DeclaredParam, value: &Value) -> bool {
    match param.param_type.as_str() {
        "string" => value.is_string(),
        "int" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" => value.is_boolean(),
        "list" => value.is_array(),
        _ => true,
    }
}

/// The input kind of a prompt (`isTextInput`, `isSelectInput` …).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Input {
    Text,
    Select,
    MultiSelect,
    Resource,
}

fn input_of(param: &DeclaredParam) -> Input {
    let has = |key: &str| {
        param
            .input
            .as_ref()
            .and_then(Value::as_object)
            .is_some_and(|input| input.contains_key(key))
    };
    if has("select") {
        Input::Select
    } else if has("multiSelect") {
        Input::MultiSelect
    } else if has("resource") {
        Input::Resource
    } else {
        Input::Text
    }
}

/// What the prompt for `param` answers without a terminal: its default,
/// written as `promptParam` writes the answer, or the official question no
/// one can answer.
fn answer(param: &DeclaredParam, default: Option<&Value>) -> Result<String, ManifestError> {
    let label = param
        .label
        .as_deref()
        .filter(|label| !label.is_empty())
        .unwrap_or(&param.name);
    let input = input_of(param);
    let delimiter = param.delimiter.as_deref().unwrap_or(",");
    let refused = |message: &str| Err(ManifestError(message.to_owned()));
    let question = match (param.param_type.as_str(), input) {
        ("string" | "int" | "boolean", Input::MultiSelect) => {
            return refused("Non-list params cannot have multi selector inputs");
        }
        ("int", Input::Resource) => {
            return refused("Numeric params cannot have Cloud Resource selector inputs");
        }
        ("boolean", Input::Resource) => {
            return refused("Boolean params cannot have Cloud Resource selector inputs");
        }
        ("list", Input::Select) => {
            return refused("List params cannot have non-list selector inputs");
        }
        ("string" | "int" | "boolean", Input::Select | Input::Resource) => {
            format!("Select a value for {label}:")
        }
        ("string", Input::Text) => format!("Enter a string value for {label}:"),
        ("int", Input::Text) => format!("Enter an integer value for {label}:"),
        ("boolean", Input::Text) => format!("Enter a boolean value for {label}:"),
        ("list", Input::MultiSelect | Input::Resource) => format!("Select values for {label}:"),
        ("list", Input::Text) => {
            format!("Enter a list of strings (delimiter: {delimiter}) for {label}:")
        }
        _ => format!("Enter a value for {label}:"),
    };
    // A Cloud Resource list prompt has no default (`promptResourceStrings`).
    let default = default.filter(|_| !(param.param_type == "list" && input == Input::Resource));
    let Some(default) = default else {
        return Err(ManifestError(format!(
            "Question \"{question}\" does not have a default and cannot be answered in non-interactive mode"
        )));
    };
    Ok(match param.param_type.as_str() {
        "boolean" => {
            let text = js_string(default).to_lowercase();
            matches!(text.as_str(), "true" | "y" | "yes" | "1").to_string()
        }
        // A text prompt reads the answer back through `toString()` and
        // splits it on the delimiter; `fromList` joins it again.
        "list" if input == Input::MultiSelect => match default {
            Value::Array(items) => items
                .iter()
                .map(js_string)
                .collect::<Vec<_>>()
                .join(delimiter),
            other => js_string(other),
        },
        _ => js_string(default),
    })
}

/// A list param's value as `process.env` holds it for `.value()`:
/// `ParamValue.toSDK()` (a JSON array; text holding `[` is JSON already).
fn list_json(raw: &str, delimiter: &str) -> String {
    let items: Value = if raw.contains('[') {
        match serde_json::from_str(&raw.replace('\'', "\"")) {
            Ok(parsed) => parsed,
            Err(_) => return raw.to_owned(),
        }
    } else {
        Value::Array(
            raw.split(delimiter)
                .map(|item| Value::String(item.to_owned()))
                .collect(),
        )
    };
    items.to_string()
}

/// JavaScript truthiness of a JSON default.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JavaScript `String(value)` of a JSON default.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                integer.to_string()
            } else if let Some(integer) = number.as_u64() {
                integer.to_string()
            } else {
                number
                    .as_f64()
                    .map_or_else(String::new, |float| float.to_string())
            }
        }
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn param(name: &str, param_type: &str, default: Option<Value>) -> DeclaredParam {
        DeclaredParam {
            name: name.to_owned(),
            param_type: param_type.to_owned(),
            default,
            label: None,
            description: None,
            input: None,
            delimiter: None,
        }
    }

    fn builtins() -> BTreeMap<String, String> {
        crate::manifest::builtin_params("demo-shop", "demo-shop.appspot.com")
    }

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn error(params: &[DeclaredParam], user_env: &BTreeMap<String, String>) -> String {
        resolve(params, user_env, &builtins())
            .expect_err("the params do not resolve")
            .0
    }

    #[test]
    fn every_type_takes_its_default_as_the_prompt_writes_it() {
        let params = [
            param("REGION", "string", Some(json!("europe-west1"))),
            param("MEMORY_MB", "int", Some(json!(512))),
            param("MIN_INSTANCES", "int", Some(json!(0))),
            param("ENABLED", "boolean", Some(json!(true))),
            param("VERBOSE", "boolean", Some(json!(false))),
            param("COLOURS", "list", Some(json!(["red", "green"]))),
            param("API_KEY", "secret", None),
        ];
        let resolved = resolve(&params, &BTreeMap::new(), &builtins()).expect("resolved");
        assert_eq!(
            resolved.defaults,
            env(&[
                ("REGION", "europe-west1"),
                ("MEMORY_MB", "512"),
                ("MIN_INSTANCES", "0"),
                ("ENABLED", "true"),
                ("VERBOSE", "false"),
                ("COLOURS", "red,green"),
            ])
        );
        assert_eq!(resolved.values, resolved.defaults);
        assert_eq!(resolved.environment["COLOURS"], r#"["red","green"]"#);
        assert_eq!(resolved.environment["MEMORY_MB"], "512");
        assert!(!resolved.environment.contains_key("API_KEY"));
    }

    #[test]
    fn env_file_values_win_over_defaults() {
        let params = [
            param("GREETING", "string", Some(json!("hello"))),
            param("COUNT", "int", None),
            param("TAGS", "list", Some(json!(["a"]))),
        ];
        let user_env = env(&[
            ("GREETING", "from-dotenv"),
            ("COUNT", "7"),
            ("TAGS", "x,y"),
            ("UNDECLARED", "kept"),
        ]);
        let resolved = resolve(&params, &user_env, &builtins()).expect("resolved");
        assert!(resolved.defaults.is_empty());
        assert_eq!(resolved.values, user_env);
        // Only a list param an env file sets changes form for the worker.
        assert_eq!(resolved.environment, env(&[("TAGS", r#"["x","y"]"#)]));
    }

    #[test]
    fn a_param_without_a_value_or_default_asks_the_official_question() {
        let cases = [
            (
                param("NAME", "string", None),
                "Enter a string value for NAME:",
            ),
            (
                param("COUNT", "int", None),
                "Enter an integer value for COUNT:",
            ),
            (
                param("ON", "boolean", None),
                "Enter a boolean value for ON:",
            ),
            (
                param("TAGS", "list", None),
                "Enter a list of strings (delimiter: ,) for TAGS:",
            ),
        ];
        for (param, question) in cases {
            assert_eq!(
                error(&[param], &BTreeMap::new()),
                format!(
                    "Question \"{question}\" does not have a default and cannot be answered in non-interactive mode"
                )
            );
        }
        let mut labelled = param("PLAN", "string", None);
        labelled.label = Some("Plan name".to_owned());
        labelled.input = Some(json!({"select": {"options": [{"value": "free"}]}}));
        assert_eq!(
            error(&[labelled], &BTreeMap::new()),
            "Question \"Select a value for Plan name:\" does not have a default and cannot be answered in non-interactive mode"
        );
        // The first param no one can answer stops the load; secrets never ask.
        let params = [
            param("API_KEY", "secret", None),
            param("FIRST", "string", None),
            param("SECOND", "int", None),
        ];
        assert!(error(&params, &BTreeMap::new()).contains("for FIRST:"));
    }

    #[test]
    fn cel_defaults_resolve_against_what_resolved_before() {
        let params = [
            param("PREFIX", "string", Some(json!("shop"))),
            param(
                "DERIVED",
                "string",
                Some(json!("{{ params.PROJECT_ID }}-{{ params.PREFIX }}")),
            ),
            param("DOUBLE", "int", Some(json!("{{ params.BASE }}"))),
        ];
        let resolved = resolve(&params, &env(&[("BASE", "4")]), &builtins());
        // BASE is not declared: the dependency is missing.
        assert_eq!(
            resolved.expect_err("BASE is undeclared").0,
            "Build specified parameter with un-resolvable default value {{ params.BASE }}; dependencies missing."
        );
        let resolved = resolve(&params[..2], &BTreeMap::new(), &builtins()).expect("resolved");
        assert_eq!(resolved.defaults["DERIVED"], "demo-shop-shop");
    }

    #[test]
    fn a_default_of_the_wrong_type_is_refused() {
        assert_eq!(
            error(&[param("COUNT", "int", Some(json!("8")))], &BTreeMap::new()),
            "Parameter COUNT has default value 8 of wrong type"
        );
        assert_eq!(
            error(
                &[param("ON", "boolean", Some(json!("yes")))],
                &BTreeMap::new()
            ),
            "Parameter ON has default value yes of wrong type"
        );
        // A falsy default is not checked, as officially.
        let resolved = resolve(
            &[param("NAME", "string", Some(json!(0)))],
            &BTreeMap::new(),
            &builtins(),
        )
        .expect("resolved");
        assert_eq!(resolved.defaults["NAME"], "0");
    }

    #[test]
    fn selector_inputs_the_type_cannot_take_are_refused() {
        let mut multi = param("NAME", "string", Some(json!("a")));
        multi.input = Some(json!({"multiSelect": {"options": []}}));
        assert_eq!(
            error(&[multi], &BTreeMap::new()),
            "Non-list params cannot have multi selector inputs"
        );
        let mut select = param("TAGS", "list", Some(json!(["a"])));
        select.input = Some(json!({"select": {"options": []}}));
        assert_eq!(
            error(&[select], &BTreeMap::new()),
            "List params cannot have non-list selector inputs"
        );
        let mut resource = param("BUCKETS", "list", Some(json!(["a"])));
        resource.input = Some(json!({"resource": {"type": "storage.googleapis.com/Bucket"}}));
        assert!(
            error(&[resource], &BTreeMap::new())
                .starts_with("Question \"Select values for BUCKETS:\"")
        );
    }

    #[test]
    fn list_values_reach_the_worker_as_the_json_the_sdk_parses() {
        let mut semicolons = param("TAGS", "list", Some(json!(["a", "b"])));
        semicolons.delimiter = Some(";".to_owned());
        let mut picked = param("PICKED", "list", Some(json!(["x", "y"])));
        picked.input = Some(json!({"multiSelect": {"options": []}}));
        let resolved = resolve(
            &[semicolons, picked, param("JSON", "list", None)],
            &env(&[("JSON", "['p', 'q']")]),
            &builtins(),
        )
        .expect("resolved");
        assert_eq!(resolved.defaults["TAGS"], "a,b");
        assert_eq!(resolved.environment["TAGS"], r#"["a,b"]"#);
        assert_eq!(resolved.defaults["PICKED"], "x,y");
        assert_eq!(resolved.environment["PICKED"], r#"["x","y"]"#);
        assert_eq!(resolved.environment["JSON"], r#"["p","q"]"#);
        assert_eq!(list_json("a,b", ","), r#"["a","b"]"#);
        assert_eq!(list_json("[broken", ","), "[broken");
    }
}
