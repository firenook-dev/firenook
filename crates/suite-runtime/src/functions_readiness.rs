//! The readiness fingerprint: compact identities of the registered handlers,
//! computed the same way for the receipt the suite prints and for the
//! inventory it serves, pinned by `functions-readiness-v1`.
use std::fmt::Write as _;

use fireside_functions_bridge::FunctionsInventory;
use sha2::{Digest as _, Sha256};

pub(crate) fn fingerprint(inventory: &FunctionsInventory) -> Result<String, String> {
    let mut rows = Vec::new();
    for function in inventory.functions() {
        let region = if function.region.is_empty() {
            function.regions.first().map_or("", String::as_str)
        } else {
            &function.region
        };
        let id = if function.id.is_empty() {
            format!("{region}-{}", function.name)
        } else {
            function.id.clone()
        };
        let identity = [
            id.as_str(),
            function.name.as_str(),
            region,
            function.platform.as_str(),
        ];
        if identity.iter().any(|value| value.is_empty()) {
            return Err("Functions inventory contains an incomplete identity".to_owned());
        }
        rows.push(serde_json::to_string(&identity).map_err(|error| error.to_string())?);
    }
    // Rust string ordering is UTF-8 byte ordering, matching Node Buffer.compare.
    // Keep duplicate rows: an extra handler must change both count and digest.
    rows.sort();
    let bytes = serde_json::to_vec(&rows).map_err(|error| error.to_string())?;
    let mut digest = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        write!(digest, "{byte:02x}").map_err(|error| error.to_string())?;
    }
    Ok(digest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn captured(mode: &str) -> FunctionsInventory {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../conformance/fixtures/functions-readiness-v1/fixture.json"
        ))
        .unwrap();
        let observation = fixture["observations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["mode"] == mode)
            .unwrap();
        FunctionsInventory {
            generation: 0,
            backends: serde_json::from_value(observation["inventory"]["backends"].clone()).unwrap(),
        }
    }

    #[test]
    fn captured_identities_fingerprint_like_the_recorded_host() {
        let mut inventory = captured("healthy");
        let healthy = "8532cd316320668eb493034eeedce3ae2694a8d31e4c1a2090ffae8083fb95d6";
        assert_eq!(fingerprint(&inventory).unwrap(), healthy);
        inventory.backends.reverse();
        assert_eq!(
            fingerprint(&inventory).unwrap(),
            healthy,
            "order does not matter"
        );
        assert_ne!(fingerprint(&captured("failed-codebase")).unwrap(), healthy);
        inventory.backends[0].function_triggers[0]
            .name
            .push_str("-changed");
        assert_ne!(fingerprint(&inventory).unwrap(), healthy);
        let mut duplicate = captured("healthy");
        let extra = duplicate.backends[0].function_triggers[0].clone();
        duplicate.backends[0].function_triggers.push(extra);
        assert_ne!(
            fingerprint(&duplicate).unwrap(),
            healthy,
            "duplicates change the digest"
        );
        assert_eq!(
            fingerprint(&captured("predefined-backend")).unwrap(),
            "8aec3fff76586e3233f5ef55609ca4166373b28540ce65eda85a307b72eb4f7a"
        );
    }
}
