//! What Dune Bot knows about each account it can connect: where the vendor's MCP server (or REST
//! API) is, how its sign-in works, and which of its tools only read. Data only; the engine is in
//! oauth.rs, remote.rs and x.rs.
//!
//! Sources (checked 2026-11-19):
//! - Slack: <https://docs.slack.dev/ai/slack-mcp-server>, <https://docs.slack.dev/authentication/using-pkce>,
//!   and the metadata at <https://mcp.slack.com/.well-known/oauth-authorization-server>.
//! - Notion: <https://developers.notion.com/guides/mcp/build-mcp-client> and
//!   <https://developers.notion.com/guides/mcp/tools-faqs.md> (tool names).
//! - Gmail, Calendar: <https://developers.google.com/workspace/guides/configure-mcp-servers> and the
//!   tool references at <https://developers.google.com/workspace/gmail/api/reference/mcp> and
//!   <https://developers.google.com/workspace/calendar/api/v3/reference/mcp>.
//! - X: <https://docs.x.com/x-api/posts/search-recent-posts>, <https://docs.x.com/x-api/posts/create-post>.

use crate::{asked::Source, policy::Action};

/// How the app signs in to the vendor.
#[derive(Clone, Debug)]
pub enum Auth {
    /// Ask the MCP server where its sign-in is (RFC 9728, RFC 8414) and register Dune Bot there
    /// (RFC 7591). Nothing for the user to set up. Notion.
    Discover,
    /// A client registered with the vendor beforehand (by whoever built this copy, or the user).
    Registered {
        authorize: String,
        token: String,
        scopes: Vec<String>,
        /// Extra query parameters for the sign-in page (Google: offline access).
        extra: Vec<(String, String)>,
        /// Whether the vendor needs the client's secret at its token endpoint.
        secret: SecretNeed,
    },
    /// The user pastes a key (X).
    Key,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretNeed {
    /// Google's desktop clients send their (not really secret) secret with every token request.
    Required,
    /// Slack: an app with PKCE turned on needs none; one without it does.
    Optional,
}

/// Where the vendor's sign-in page sends the browser back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Redirect {
    /// `http://127.0.0.1:<any free port>/callback`: Google's desktop clients and Notion accept any.
    Random,
    /// `http://localhost:<port>/callback`: Slack matches the port exactly against the app's
    /// Redirect URLs (and counts only localhost as a desktop redirect), so the port is fixed.
    Fixed(u16),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A remote MCP server (Streamable HTTP).
    Mcp { url: String },
    /// X's REST API v2 (base URL, no trailing slash).
    XRest { base: String },
}

#[derive(Clone, Debug)]
pub struct Vendor {
    pub kind: Kind,
    pub auth: Auth,
    pub redirect: Redirect,
    /// Send RFC 8707's `resource` (the MCP server's URL) when signing in and refreshing.
    pub resource: bool,
    /// Whether an authorization server may be plain http. Only the tests' stand-ins are.
    pub allow_http: bool,
    /// A client id (and secret) built into this copy of Dune Bot, if any.
    pub builtin: Option<(String, Option<String>)>,
    /// What the user is told about setting it up (shown under Connect).
    pub help: &'static str,
}

/// The fixed port Slack's sign-in comes back to (the Slack app lists
/// `http://localhost:51735/callback` as a Redirect URL).
pub const SLACK_PORT: u16 = 51735;

/// The tool name prefix agents see for an account: `slack_search_public`, `notion_fetch`.
pub fn prefix(source: Source) -> &'static str {
    match source {
        Source::Slack => "slack",
        Source::Gmail => "gmail",
        Source::Notion => "notion",
        Source::Calendar => "calendar",
        Source::X => "x",
    }
}

/// The account's name as the settings page and agents read it.
pub fn label(source: Source) -> &'static str {
    match source {
        Source::Calendar => "Google Calendar",
        s => s.label(),
    }
}

/// The permission for changing things in an account: one per account, so "allow all in this chat"
/// for a Slack message doesn't also cover an X post.
pub fn write_action(source: Source) -> Action {
    match source {
        Source::Slack => Action::SlackWrite,
        Source::Gmail => Action::GmailWrite,
        Source::Notion => Action::NotionWrite,
        Source::Calendar => Action::CalendarWrite,
        Source::X => Action::XPost,
    }
}

/// Vendor tools that only read, by the vendor's own name. Everything else (including a tool a
/// vendor adds later) is treated as a change and asks the user first.
pub fn reads(source: Source) -> &'static [&'static str] {
    match source {
        // Slack's docs describe the tools without naming them all; these names are from Slack's
        // listing in Anthropic's connector directory, and each only searches or reads.
        Source::Slack => &[
            "slack_search_public",
            "slack_search_public_and_private",
            "slack_search_channels",
            "slack_search_users",
            "slack_read_channel",
            "slack_read_thread",
            "slack_read_canvas",
            "slack_read_user_profile",
        ],
        // Google's tool reference for gmailmcp.googleapis.com (no tool there sends mail).
        Source::Gmail => &["search_threads", "get_thread", "get_message", "list_drafts", "list_labels"],
        // Google's tool reference for calendarmcp.googleapis.com.
        Source::Calendar => &["list_calendars", "list_events", "search_events", "get_event", "suggest_time"],
        // Notion's tool list (tools-faqs): the ones that search, fetch, list or query.
        Source::Notion => &[
            "notion-search",
            "notion-fetch",
            "notion-ai-search",
            "notion-connector-search",
            "notion-get-self",
            "notion-get-users",
            "notion-get-teams",
            "notion-get-groups",
            "notion-get-comments",
            "notion-get-tool-access",
            "notion-get-version-changes",
            "notion-view-version",
            "notion-get-suggested-edit",
            "notion-query-data-sources",
            "notion-query-multiple-data-sources",
            "notion-query-meeting-notes",
            "notion-list-recent-pages",
            "notion-list-favorite-pages",
            "notion-list-private-pages",
            "notion-list-shared-pages",
            "notion-list-page-backlinks",
            "notion-calendar-list-calendars",
            "notion-calendar-list-events",
            "notion-calendar-list-contacts",
            "notion-calendar-list-calendar-resources",
            "notion-calendar-list-coworkers-events",
            "notion-memory-search",
        ],
        Source::X => &["search"],
    }
}

/// The name agents see for a vendor tool: the account's prefix and the vendor's name without its
/// own prefix, in lowercase letters, digits and `_` (at most 64 characters).
pub fn exposed(source: Source, vendor_name: &str) -> String {
    let p = prefix(source);
    let mut rest = vendor_name.trim();
    for strip in [format!("{p}_"), format!("{p}-"), format!("{p}.")] {
        if let Some(r) = rest.strip_prefix(strip.as_str()) {
            rest = r;
        }
    }
    let rest: String = rest
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect();
    let rest = rest.trim_matches('_');
    let mut name = format!("{p}_{}", if rest.is_empty() { "tool" } else { rest });
    name.truncate(64);
    name
}

fn google(scopes: &[&str], help: &'static str, url: &str) -> Vendor {
    let builtin = option_env!("DUNEBOT_GOOGLE_CLIENT_ID").map(|id| (id.to_string(), option_env!("DUNEBOT_GOOGLE_CLIENT_SECRET").map(String::from)));
    Vendor {
        kind: Kind::Mcp { url: url.into() },
        auth: Auth::Registered {
            authorize: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            scopes: scopes.iter().map(|s| format!("https://www.googleapis.com/auth/{s}")).collect(),
            extra: vec![("access_type".into(), "offline".into()), ("prompt".into(), "consent".into())],
            secret: SecretNeed::Required,
        },
        redirect: Redirect::Random,
        resource: false,
        allow_http: false,
        builtin,
        help,
    }
}

const GOOGLE_HELP: &str = "Google's Workspace MCP servers are a Developer Preview: join the preview, make a Google Cloud project, turn on the Gmail and Calendar APIs and their MCP APIs, then make an OAuth client of type Desktop app with \"Use this client for an AI-powered agent\" ticked. Paste its client ID and secret here.";

/// The real vendors.
pub fn of(source: Source) -> Vendor {
    match source {
        Source::Slack => Vendor {
            kind: Kind::Mcp { url: "https://mcp.slack.com/mcp".into() },
            auth: Auth::Registered {
                authorize: "https://slack.com/oauth/v2_user/authorize".into(),
                token: "https://slack.com/api/oauth.v2.user.access".into(),
                scopes: [
                    "search:read.public", "search:read.private", "search:read.mpim", "search:read.im", "search:read.files", "search:read.users",
                    "channels:history", "groups:history", "mpim:history", "im:history",
                    "channels:read", "groups:read", "im:read", "mpim:read",
                    "users:read", "users:read.email", "chat:write", "canvases:read", "canvases:write",
                ]
                .iter()
                .map(|s| s.to_string())
                .collect(),
                extra: vec![],
                secret: SecretNeed::Optional,
            },
            redirect: Redirect::Fixed(SLACK_PORT),
            resource: false,
            allow_http: false,
            builtin: option_env!("DUNEBOT_SLACK_CLIENT_ID").map(|id| (id.to_string(), None)),
            help: "Slack lets only your own workspace's apps (or ones in the Slack Marketplace) use its MCP server. Make an app at api.slack.com/apps, turn on PKCE under OAuth & Permissions, add the Redirect URL below, then paste its client ID (the client secret only if PKCE is off).",
        },
        Source::Notion => Vendor {
            kind: Kind::Mcp { url: "https://mcp.notion.com/mcp".into() },
            auth: Auth::Discover,
            redirect: Redirect::Random,
            resource: true,
            allow_http: false,
            builtin: None,
            help: "Notion asks you in your browser which pages Dune Bot may use. Nothing to set up first.",
        },
        Source::Gmail => google(&["gmail.readonly", "gmail.compose", "gmail.modify"], GOOGLE_HELP, "https://gmailmcp.googleapis.com/mcp/v1"),
        Source::Calendar => google(
            &["calendar.calendarlist.readonly", "calendar.events.freebusy", "calendar.events.readonly", "calendar.events"],
            GOOGLE_HELP,
            "https://calendarmcp.googleapis.com/mcp/v1",
        ),
        Source::X => Vendor {
            kind: Kind::XRest { base: "https://api.x.com".into() },
            auth: Auth::Key,
            redirect: Redirect::Random,
            resource: false,
            allow_http: false,
            builtin: None,
            help: "Paste a bearer token from your X developer app (console.x.com). X charges per post read. An app-only token can search; posting needs a user token (OAuth 2.0, tweet.write).",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposed_names_are_clear_and_safe() {
        assert_eq!(exposed(Source::Slack, "slack_search_public"), "slack_search_public");
        assert_eq!(exposed(Source::Notion, "notion-create-pages"), "notion_create_pages");
        assert_eq!(exposed(Source::Gmail, "search_threads"), "gmail_search_threads");
        assert_eq!(exposed(Source::Calendar, "list_events"), "calendar_list_events");
        assert_eq!(exposed(Source::Slack, "weird name/../x"), "slack_weird_name____x");
        assert_eq!(exposed(Source::Notion, "notion-"), "notion_tool");
        assert!(exposed(Source::Gmail, &"a".repeat(200)).len() <= 64);
    }

    #[test]
    fn every_account_has_its_own_write_permission() {
        let mut seen = std::collections::HashSet::new();
        for s in Source::ALL {
            assert!(seen.insert(write_action(s)), "{s:?} shares a write permission");
            assert_eq!(write_action(s).default_mode(), crate::policy::Mode::Ask);
        }
    }

    #[test]
    fn real_vendors_are_https_only() {
        for s in Source::ALL {
            let v = of(s);
            assert!(!v.allow_http);
            match &v.kind {
                Kind::Mcp { url } => assert!(url.starts_with("https://")),
                Kind::XRest { base } => assert!(base.starts_with("https://")),
            }
            if let Auth::Registered { authorize, token, .. } = &v.auth {
                assert!(authorize.starts_with("https://") && token.starts_with("https://"));
            }
        }
    }
}
