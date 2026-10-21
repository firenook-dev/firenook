//! The home directory as the Firebase CLI sees it: Node's `os.homedir()`,
//! under which its stored login (configstore) and the shared Extensions
//! source cache live.
use std::ffi::OsString;
use std::path::PathBuf;

/// `os.homedir()`: libuv's `uv_os_homedir` reads `USERPROFILE` on Windows
/// and `HOME` elsewhere (a `HOME` set on Windows, as Git Bash does, is not
/// read), then asks the system for the user's profile directory.
#[must_use]
pub fn home_dir() -> Option<PathBuf> {
    from_env(|name| std::env::var_os(name), cfg!(windows)).or_else(std::env::home_dir)
}

/// The environment lookup of [`home_dir`] for the given platform.
pub fn from_env(var: impl Fn(&str) -> Option<OsString>, windows: bool) -> Option<PathBuf> {
    var(if windows { "USERPROFILE" } else { "HOME" })
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_reads_the_user_profile_and_never_home() {
        let env = |name: &str| match name {
            "HOME" => Some(OsString::from("/d/shop")),
            "USERPROFILE" => Some(OsString::from(r"C:\Users\shop")),
            _ => None,
        };
        assert_eq!(from_env(env, true), Some(PathBuf::from(r"C:\Users\shop")));
        assert_eq!(from_env(env, false), Some(PathBuf::from("/d/shop")));
        let only_home = |name: &str| (name == "HOME").then(|| OsString::from("/d/shop"));
        assert_eq!(from_env(only_home, true), None);
        let empty = |_: &str| Some(OsString::new());
        assert_eq!(from_env(empty, false), None);
    }
}
