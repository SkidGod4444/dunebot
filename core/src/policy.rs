//! What an agent may do, decided in code. Nothing here trusts the model or the renderer.

use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Action {
    RunCommand,
    ReadFile,
    WriteFile,
    ListFolder,
    SearchChats,
    LookScreen,
    /// Where the computer is, from the system's location services.
    FindLocation,
    /// A click, scroll or drag on the screen for the user (the app does it; macOS asks once for
    /// Accessibility).
    Click,
    /// Typing or a key or shortcut, into whatever app has the keyboard (never Dune Bot itself).
    Type,
    /// A ring with a short label around something on the screen, to show the user where it is
    /// (teaching: tools/teach.rs). It changes nothing.
    Point,
    /// Sending or changing something in the user's connected accounts (connectors/), one each.
    SlackWrite,
    GmailWrite,
    NotionWrite,
    CalendarWrite,
    XPost,
}

impl Action {
    pub const ALL: [Action; 15] = [
        Action::RunCommand,
        Action::WriteFile,
        Action::ReadFile,
        Action::ListFolder,
        Action::SearchChats,
        Action::LookScreen,
        Action::Point,
        Action::Click,
        Action::Type,
        Action::FindLocation,
        Action::SlackWrite,
        Action::GmailWrite,
        Action::NotionWrite,
        Action::CalendarWrite,
        Action::XPost,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Action::RunCommand => "run-command",
            Action::ReadFile => "read-file",
            Action::WriteFile => "write-file",
            Action::ListFolder => "list-folder",
            Action::SearchChats => "search-chats",
            Action::LookScreen => "look-screen",
            Action::FindLocation => "find-location",
            Action::Click => "click",
            Action::Type => "type",
            Action::Point => "point",
            Action::SlackWrite => "slack-write",
            Action::GmailWrite => "gmail-write",
            Action::NotionWrite => "notion-write",
            Action::CalendarWrite => "calendar-write",
            Action::XPost => "x-post",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Action::RunCommand => "Run a command",
            Action::ReadFile => "Read a file",
            Action::WriteFile => "Create or change a file",
            Action::ListFolder => "Look inside a folder",
            Action::SearchChats => "Search your past chats",
            Action::LookScreen => "Look at your screen",
            Action::FindLocation => "Find where you are",
            Action::Click => "Click, scroll and drag on your screen",
            Action::Type => "Type and press keys",
            Action::Point => "Point at things on your screen",
            Action::SlackWrite => "Send or change things in Slack",
            Action::GmailWrite => "Draft or change email in Gmail",
            Action::NotionWrite => "Create or change Notion pages",
            Action::CalendarWrite => "Add or change calendar events",
            Action::XPost => "Post on X",
        }
    }

    pub fn default_mode(self) -> Mode {
        match self {
            // The user chose Auto for commands (2026-11-16; "only risky ones ask" 2026-11-17).
            Action::RunCommand => Mode::Auto,
            Action::WriteFile => Mode::Ask,
            // The user chose looks without asking (2026-11-16, "dont ask to look my screen"). Pointing
            // at something to teach changes nothing either, so it never asks (nor in scheduled chats).
            Action::ReadFile | Action::ListFolder | Action::SearchChats | Action::LookScreen | Action::Point => Mode::Always,
            // The user asked for the exact location from the system (2026-11-17); macOS asks once itself.
            Action::FindLocation => Mode::Always,
            // The user chose clicks without asking, through Dune Bot's own tool (2026-11-18); osascript,
            // which can do far more than click, still asks under Auto.
            Action::Click => Mode::Always,
            // And typing and shortcuts without asking too (2026-11-18), though they can do whatever a
            // person at the keyboard can.
            Action::Type => Mode::Always,
            // Anything sent or changed in an account asks first (connectors/).
            Action::SlackWrite | Action::GmailWrite | Action::NotionWrite | Action::CalendarWrite | Action::XPost => Mode::Ask,
        }
    }

    /// A change in one of the user's accounts (sending, posting, editing in Slack, Gmail, Notion,
    /// Calendar, X). A new bot starts without these (team.rs save).
    pub fn is_account_change(self) -> bool {
        matches!(self, Action::SlackWrite | Action::GmailWrite | Action::NotionWrite | Action::CalendarWrite | Action::XPost)
    }

    pub fn from_key(k: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|a| a.key() == k)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Always,
    Ask,
    Never,
    /// Commands only: runs a command with nothing risky in it (`lookonly.rs`), asks for the rest.
    Auto,
}

impl Mode {
    pub fn key(self) -> &'static str {
        match self {
            Mode::Always => "always",
            Mode::Ask => "ask",
            Mode::Never => "never",
            Mode::Auto => "auto",
        }
    }

    pub fn from_key(k: &str) -> Option<Self> {
        match k {
            "always" => Some(Mode::Always),
            "ask" => Some(Mode::Ask),
            "never" => Some(Mode::Never),
            "auto" => Some(Mode::Auto),
            _ => None,
        }
    }
}

pub fn home() -> Option<PathBuf> {
    dirs::home_dir().map(|h| std::fs::canonicalize(&h).unwrap_or(h))
}

/// Turns what the agent typed into one real path: `~` expanded, relative to the chat's
/// folder, `.`/`..` removed and symlinks in the existing part resolved.
pub fn resolve(raw: &str, cwd: &Path) -> PathBuf {
    let raw = raw.trim();
    let p = if raw == "~" {
        home().unwrap_or_else(|| PathBuf::from(raw))
    } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        home().map(|h| h.join(rest)).unwrap_or_else(|| PathBuf::from(raw))
    } else {
        PathBuf::from(raw)
    };
    let p = if p.is_absolute() { p } else { cwd.join(p) };
    normalize(&p)
}

fn normalize(p: &Path) -> PathBuf {
    let mut lexical = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                lexical.pop();
            }
            Component::CurDir => {}
            other => lexical.push(other.as_os_str()),
        }
    }
    let mut existing = lexical.clone();
    let mut tail = Vec::new();
    while !existing.exists() {
        match existing.file_name() {
            Some(n) => {
                tail.push(n.to_owned());
                existing.pop();
            }
            None => break,
        }
    }
    let mut base = std::fs::canonicalize(&existing).unwrap_or(existing);
    for n in tail.iter().rev() {
        base.push(n);
    }
    base
}

const PRIVATE_DIRS: &[&str] = &[
    ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", ".1password",
];

const CREDENTIAL_FILES: &[&str] = &[".netrc", ".npmrc", ".pypirc", ".git-credentials", ".pgpass"];

/// Places no agent tool may touch, on any OS, whatever the settings say.
const PROTECTED_UNDER_HOME: &[&str] = &[
    "library/keychains",
    "library/cookies",
    "library/messages",
    "library/mail",
    "library/application support/com.apple.tcc",
    "library/application support/google/chrome",
    "library/application support/bravesoftware",
    "library/application support/microsoft edge",
    "library/application support/firefox",
    ".config/gh",
    ".config/google-chrome",
    ".config/chromium",
    ".config/bravesoftware",
    ".mozilla",
    ".local/share/keyrings",
    "appdata/roaming/microsoft/credentials",
    "appdata/local/microsoft/credentials",
    "appdata/roaming/microsoft/protect",
    "appdata/local/google/chrome/user data",
    "appdata/local/microsoft/edge/user data",
    "appdata/roaming/mozilla",
];

/// Why `path` is off limits, or None. `path` must come from [`resolve`].
pub fn denied(path: &Path, data_dir: &Path) -> Option<String> {
    let data = std::fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
    for d in [&data, &data_dir.to_path_buf()] {
        // Chats' own work folders (workspaces/<chat>) live in the data folder; the rest is Dune Bot's.
        let ws = d.join("workspaces");
        if path.starts_with(d) && !(path.starts_with(&ws) && path != ws) {
            return Some("Dune Bot's own settings and approvals".into());
        }
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name == ".env" || name.starts_with(".env.") {
        return Some("a secrets file (.env)".into());
    }
    if CREDENTIAL_FILES.contains(&name.as_str()) {
        return Some(format!("a credentials file ({name})"));
    }
    for c in path.components() {
        if let Component::Normal(s) = c {
            let s = s.to_string_lossy().to_lowercase();
            if PRIVATE_DIRS.contains(&s.as_str()) {
                return Some(format!("a private folder ({s})"));
            }
        }
    }
    if let Some(home) = home() {
        if let Ok(rel) = path.strip_prefix(&home) {
            let rel = rel.to_string_lossy().replace('\\', "/").to_lowercase();
            for pre in PROTECTED_UNDER_HOME {
                if rel == *pre || rel.starts_with(&format!("{pre}/")) {
                    return Some(format!("a protected location (~/{pre})"));
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_and_blocks_private_places() {
        let data = std::env::temp_dir().join("dunebot-test-data");
        let home = home().unwrap();
        let cwd = home.join("somewhere");
        assert_eq!(resolve("~/notes.txt", &cwd), home.join("notes.txt"));
        assert!(denied(&resolve("~/.ssh/id_ed25519", &cwd), &data).is_some());
        assert!(denied(&resolve("project/.env", &cwd), &data).is_some());
        assert!(denied(&resolve("project/.env.local", &cwd), &data).is_some());
        assert!(denied(&resolve("~/Library/Keychains/login.keychain-db", &cwd), &data).is_some());
        assert!(denied(&resolve("../../../../../../.aws/credentials", &cwd), &data).is_some());
        assert!(denied(&data.join("dunebot.db"), &data).is_some());
        assert!(denied(&data.join("journal/x/1-a.txt"), &data).is_some());
        assert!(denied(&data.join("workspaces"), &data).is_some());
        assert!(denied(&data.join("workspaces/abc/notes.md"), &data).is_none());
        assert!(denied(&resolve("~/Documents/report.md", &cwd), &data).is_none());
        assert!(denied(&resolve("src/env.rs", &cwd), &data).is_none());
    }

    #[test]
    fn data_folder_blocked_in_any_letter_case() {
        // On a case-insensitive disk (macOS, Windows) another spelling reaches the same folder.
        let data = std::env::temp_dir().join(format!("DunebotCaseTest{}", std::process::id()));
        std::fs::create_dir_all(data.join("history")).unwrap();
        std::fs::write(data.join("dunebot.db"), b"").unwrap();
        let lower = PathBuf::from(data.to_string_lossy().to_lowercase());
        if lower.exists() {
            for p in [lower.join("dunebot.db"), lower.join("HISTORY").join("new.mdx"), lower.join("NewDir").join("x.txt")] {
                assert!(denied(&resolve(&p.to_string_lossy(), Path::new("/")), &data).is_some(), "{p:?} got through");
            }
        }
        let _ = std::fs::remove_dir_all(&data);
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_reach_the_same_rules() {
        let data = std::env::temp_dir().join(format!("DunebotWinTest{}", std::process::id()));
        let cwd = data.join("workspaces").join("abc");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(data.join("dunebot.db"), b"").unwrap();
        let upper = data.to_string_lossy().to_uppercase();
        for raw in [r"..\..\dunebot.db".to_string(), "../../dunebot.db".to_string(), format!(r"{upper}\DUNEBOT.DB"), upper.replace('\\', "/") + "/history/x.mdx"] {
            assert!(denied(&resolve(&raw, &cwd), &data).is_some(), "{raw} got through");
        }
        assert!(denied(&resolve(r"~\.ssh\id_ed25519", &cwd), &data).is_some());
        assert!(denied(&resolve(r"notes.md", &cwd), &data).is_none());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn dotdot_cannot_escape_lexically() {
        let cwd = PathBuf::from("/tmp/a/b");
        let p = resolve("../../../etc/hosts", &cwd);
        assert!(!p.to_string_lossy().contains(".."));
    }
}
