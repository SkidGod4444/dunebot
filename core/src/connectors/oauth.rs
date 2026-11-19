//! Signing in to an account: OAuth 2.1's authorization code flow with PKCE (S256), the browser
//! sent back to a loopback address only this computer can reach, the authorization server found
//! from the MCP server (RFC 9728, RFC 8414) and Dune Bot registered there (RFC 7591) when the vendor
//! allows it, then tokens and refreshes. Everything here is blocking except the loopback wait.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

use super::{http, vendor::Redirect};

/// `n` × 128 random bits as hex (uuid v4 draws from the system's random source).
pub fn random(n: usize) -> String {
    (0..n).map(|_| uuid::Uuid::new_v4().simple().to_string()).collect()
}

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// A fresh verifier (96 characters of [0-9a-f], within RFC 7636's 43–128) and its S256 challenge.
pub fn pkce() -> Pkce {
    let verifier = random(3);
    let challenge = http::b64url(&sha2::Sha256::digest(verifier.as_bytes()));
    Pkce { verifier, challenge }
}

/// Where an account's sign-in happens.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Server {
    pub authorize: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration: Option<String>,
    /// The issuer the browser must come back from (RFC 9207), when the server says it names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(default)]
    pub iss_required: bool,
    /// The MCP server's own name for itself (RFC 8707 `resource`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
}

/// `https://host:port` of a URL, and its path ("" for none).
fn split(url: &str) -> Option<(String, String)> {
    let scheme_end = url.find("://")? + 3;
    let path_at = url[scheme_end..].find(['/', '?', '#']).map(|i| scheme_end + i).unwrap_or(url.len());
    let path = url[path_at..].split(['?', '#']).next().unwrap_or("").trim_end_matches('/').to_string();
    Some((url[..path_at].to_string(), path))
}

fn allowed(url: &str, allow_http: bool) -> bool {
    url.starts_with("https://") || (allow_http && url.starts_with("http://"))
}

fn fetch_json(url: &str) -> Option<Value> {
    let a = http::get(url, &[("accept", "application/json")], 256 << 10).ok()?;
    (a.status == 200).then(|| a.json()).filter(Value::is_object)
}

/// Asks the MCP server where it signs people in (RFC 9728), then that server how (RFC 8414).
/// PKCE with S256 is required: a server that doesn't say it does isn't used.
pub fn discover(mcp_url: &str, allow_http: bool) -> Result<Server, String> {
    let (origin, path) = split(mcp_url).ok_or("its address is malformed")?;
    let prm = fetch_json(&format!("{origin}/.well-known/oauth-protected-resource{path}"))
        .or_else(|| fetch_json(&format!("{origin}/.well-known/oauth-protected-resource")))
        .ok_or("it doesn't say where to sign in")?;
    let resource = prm.get("resource").and_then(Value::as_str).map(String::from);
    if let Some(r) = &resource {
        if split(r).map(|(o, _)| o) != Some(origin.clone()) {
            return Err("its sign-in names another server".into());
        }
    }
    let issuer = prm
        .pointer("/authorization_servers/0")
        .and_then(Value::as_str)
        .filter(|u| allowed(u, allow_http))
        .ok_or("it doesn't name a secure sign-in server")?
        .trim_end_matches('/')
        .to_string();
    let (is_origin, is_path) = split(&issuer).ok_or("its sign-in server's address is malformed")?;
    let meta = fetch_json(&format!("{is_origin}/.well-known/oauth-authorization-server{is_path}"))
        .or_else(|| fetch_json(&format!("{issuer}/.well-known/openid-configuration")))
        .ok_or("its sign-in server doesn't describe itself")?;
    if meta.get("issuer").and_then(Value::as_str).map(|s| s.trim_end_matches('/')) != Some(issuer.as_str()) {
        return Err("its sign-in server names itself differently".into());
    }
    let s256 = meta
        .get("code_challenge_methods_supported")
        .and_then(Value::as_array)
        .is_some_and(|m| m.iter().any(|x| x == "S256"));
    if !s256 {
        return Err("its sign-in server doesn't support PKCE (S256)".into());
    }
    let url = |k: &str| meta.get(k).and_then(Value::as_str).filter(|u| allowed(u, allow_http)).map(String::from);
    Ok(Server {
        authorize: url("authorization_endpoint").ok_or("its sign-in server has no secure sign-in page")?,
        token: url("token_endpoint").ok_or("its sign-in server has no secure token address")?,
        registration: url("registration_endpoint"),
        iss_required: meta.get("authorization_response_iss_parameter_supported") == Some(&json!(true)),
        issuer: Some(issuer),
        resource: resource.or_else(|| Some(mcp_url.to_string())),
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Client {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

/// Registers Dune Bot with an authorization server (RFC 7591) as a public client for one redirect.
pub fn register(registration: &str, redirect_uri: &str) -> Result<Client, String> {
    let body = json!({
        "client_name": "Dune Bot",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let a = http::post_json(registration, &body, &[("accept", "application/json")], 64 << 10, 30)?;
    let v = a.json();
    let id = v.get("client_id").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 500);
    match (a.status, id) {
        (200..=299, Some(id)) => Ok(Client { id: id.to_string(), secret: v.get("client_secret").and_then(Value::as_str).map(String::from) }),
        (s, _) => Err(format!("registering Dune Bot there failed ({s})")),
    }
}

/// The loopback address the browser comes back to.
pub struct Loopback {
    listeners: Vec<TcpListener>,
    pub port: u16,
    pub redirect_uri: String,
}

/// Opens the loopback listener: Slack's fixed port (as `localhost`, on IPv4 and, when free, IPv6),
/// or `want` (the port a stored registration names) if it's free, or any free port.
pub async fn bind(redirect: Redirect, want: Option<u16>) -> Result<Loopback, String> {
    match redirect {
        Redirect::Fixed(port) => {
            let v4 = TcpListener::bind(("127.0.0.1", port))
                .await
                .map_err(|_| format!("port {port} on this computer is in use, so the browser can't come back to Dune Bot. Close what uses it and try again."))?;
            let mut listeners = vec![v4];
            if let Ok(v6) = TcpListener::bind(("::1", port)).await {
                listeners.push(v6);
            }
            Ok(Loopback { listeners, port, redirect_uri: format!("http://localhost:{port}/callback") })
        }
        Redirect::Random => {
            let mut listener = None;
            if let Some(p) = want.filter(|p| *p != 0) {
                listener = TcpListener::bind(("127.0.0.1", p)).await.ok();
            }
            let listener = match listener {
                Some(l) => l,
                None => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("no loopback port ({e})"))?,
            };
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            Ok(Loopback { listeners: vec![listener], port, redirect_uri: format!("http://127.0.0.1:{port}/callback") })
        }
    }
}

/// The port a redirect URI names.
pub fn port_of(redirect_uri: &str) -> Option<u16> {
    let (origin, _) = split(redirect_uri)?;
    origin.rsplit_once(':')?.1.parse().ok()
}

const PAGE_OK: &str = "Dune Bot is connected. You can close this tab.";

fn page(status: &str, text: &str) -> String {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Dune Bot</title><body style=\"margin:0;padding:48px;background:#000;color:#fff;font:16px -apple-system,system-ui,sans-serif\"><p>{}</p>",
        text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
    );
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

async fn reply(sock: &mut tokio::net::TcpStream, status: &str, text: &str) {
    let r = page(status, text);
    let _ = sock.write_all(r.as_bytes()).await;
    let _ = sock.shutdown().await;
}

enum Seen {
    /// Not the sign-in (another page, a wrong state): answered, and the wait goes on.
    Ignore,
    Code(String),
    Failed(String),
}

/// Reads one request on the loopback and answers it.
async fn one(mut sock: tokio::net::TcpStream, port: u16, state: &str, issuer: Option<&str>, iss_required: bool) -> Seen {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let read = tokio::time::timeout(Duration::from_secs(5), async {
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16 << 10 {
            match sock.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
    })
    .await;
    if read.is_err() {
        return Seen::Ignore;
    }
    let head = String::from_utf8_lossy(&buf).into_owned();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let host = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("host"))
        .map(|(_, v)| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    // Only this computer's own names for itself: a web page that renamed its host to 127.0.0.1
    // (DNS rebinding) sends its own Host and is refused.
    let host_ok = [format!("127.0.0.1:{port}"), format!("localhost:{port}"), format!("[::1]:{port}")].contains(&host);
    let path = target.split('?').next().unwrap_or("");
    if method != "GET" || path != "/callback" || !host_ok {
        reply(&mut sock, "404 Not Found", "Not found.").await;
        return Seen::Ignore;
    }
    let q = http::query_pairs(target);
    let get = |k: &str| q.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    if !get("state").is_some_and(|s| crate::app::ct_eq(s.as_bytes(), state.as_bytes())) {
        reply(&mut sock, "400 Bad Request", "This sign-in isn't the one Dune Bot started.").await;
        return Seen::Ignore;
    }
    if let Some(err) = get("error") {
        let code: String = err.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(60).collect();
        reply(&mut sock, "200 OK", "Dune Bot wasn't connected. You can close this tab.").await;
        return Seen::Failed(if code == "access_denied" { "you said no in the browser".into() } else { format!("the sign-in page said {code}") });
    }
    // RFC 9207: when the sign-in server is known, the browser must come back from it (a server that
    // says it always names itself must name itself).
    if let Some(expected) = issuer {
        let iss = get("iss").map(|s| s.trim_end_matches('/'));
        if (iss.is_some() || iss_required) && iss != Some(expected) {
            reply(&mut sock, "400 Bad Request", "This sign-in came from an unexpected server.").await;
            return Seen::Failed("the browser came back from an unexpected server".into());
        }
    }
    match get("code").filter(|c| !c.is_empty() && c.len() <= 4096) {
        Some(code) => {
            reply(&mut sock, "200 OK", PAGE_OK).await;
            Seen::Code(code.to_string())
        }
        None => {
            reply(&mut sock, "400 Bad Request", "The sign-in page sent no code.").await;
            Seen::Ignore
        }
    }
}

/// Waits for the browser to come back with the code for `state` (or `cancel`, or `limit`).
pub async fn wait(lb: Loopback, state: &str, issuer: Option<&str>, iss_required: bool, mut cancel: oneshot::Receiver<()>, limit: Duration) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + limit;
    let port = lb.port;
    loop {
        let accept = async {
            match lb.listeners.as_slice() {
                [a] => a.accept().await,
                [a, b, ..] => tokio::select! { r = a.accept() => r, r = b.accept() => r },
                [] => std::future::pending().await,
            }
        };
        let conn = tokio::select! {
            r = accept => r,
            _ = &mut cancel => return Err("stopped".into()),
            _ = tokio::time::sleep_until(deadline) => return Err("the browser didn't come back within 5 minutes".into()),
        };
        let Ok((sock, _)) = conn else { continue };
        match one(sock, port, state, issuer, iss_required).await {
            Seen::Ignore => continue,
            Seen::Code(c) => return Ok(c),
            Seen::Failed(e) => return Err(e),
        }
    }
}

#[derive(Debug)]
pub struct Tokens {
    pub access: String,
    pub refresh: Option<String>,
    /// When the access token stops working (ms since the epoch), if the server said.
    pub expires_at: Option<i64>,
    /// The workspace or team signed in to, when the server names it (Slack, Notion).
    pub account: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TokenError {
    /// The grant is gone (revoked, expired, or a refresh token already used): sign in again.
    Revoked,
    Other(String),
}

/// Words for an error code or description from a server, safe to show.
fn said(v: &Value, secrets: &[&str]) -> String {
    let code: String = v.get("error").and_then(Value::as_str).unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.').take(60).collect();
    let desc = v.get("error_description").and_then(Value::as_str).map(|d| http::redact(d, secrets)).unwrap_or_default();
    let desc: String = desc.chars().take(120).collect();
    match (code.is_empty(), desc.is_empty()) {
        (true, _) => "an error".into(),
        (false, true) => code,
        (false, false) => format!("{code}: {desc}"),
    }
}

fn token_request(url: &str, form: &[(&str, &str)], secrets: &[&str]) -> Result<Tokens, TokenError> {
    let a = http::post_form(url, form, &[]).map_err(TokenError::Other)?;
    let v = a.json();
    let revoked_codes = ["invalid_grant", "invalid_refresh_token", "token_revoked", "token_expired", "invalid_auth", "account_inactive"];
    let code = v.get("error").and_then(Value::as_str).unwrap_or("");
    // Slack answers 200 with {"ok": false, "error": …}.
    if v.get("ok") == Some(&json!(false)) || !(200..300).contains(&a.status) || !code.is_empty() {
        if revoked_codes.contains(&code) {
            return Err(TokenError::Revoked);
        }
        return Err(TokenError::Other(format!("the sign-in server said {} ({})", said(&v, secrets), a.status)));
    }
    // Slack's v2 (non-user) answer keeps the user's token under authed_user.
    let pick = |k: &str| v.get(k).or_else(|| v.pointer(&format!("/authed_user/{k}"))).cloned();
    let access = pick("access_token").and_then(|t| t.as_str().map(String::from)).filter(|t| !t.is_empty()).ok_or_else(|| TokenError::Other("the sign-in server sent no access token".into()))?;
    let refresh = pick("refresh_token").and_then(|t| t.as_str().map(String::from)).filter(|t| !t.is_empty());
    let expires_at = pick("expires_in").and_then(|e| e.as_i64()).filter(|e| *e > 0).map(|e| crate::store::now_ms() + e * 1000);
    let account = v
        .pointer("/team/name")
        .or_else(|| v.get("workspace_name"))
        .and_then(Value::as_str)
        .map(|s| s.chars().filter(|c| !c.is_control()).take(80).collect::<String>())
        .filter(|s| !s.trim().is_empty());
    Ok(Tokens { access, refresh, expires_at, account })
}

/// The code for tokens (with the PKCE verifier; the client's secret when it has one).
pub fn exchange(token_url: &str, client: &Client, code: &str, verifier: &str, redirect_uri: &str, resource: Option<&str>) -> Result<Tokens, TokenError> {
    let mut form = vec![("grant_type", "authorization_code"), ("code", code), ("redirect_uri", redirect_uri), ("client_id", client.id.as_str()), ("code_verifier", verifier)];
    if let Some(s) = &client.secret {
        form.push(("client_secret", s));
    }
    if let Some(r) = resource {
        form.push(("resource", r));
    }
    let mut secrets = vec![code, verifier];
    secrets.extend(client.secret.as_deref());
    token_request(token_url, &form, &secrets)
}

/// A new access token from the refresh token (which the server may also replace).
pub fn refresh(token_url: &str, client: &Client, refresh_token: &str, resource: Option<&str>) -> Result<Tokens, TokenError> {
    let mut form = vec![("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("client_id", client.id.as_str())];
    if let Some(s) = &client.secret {
        form.push(("client_secret", s));
    }
    if let Some(r) = resource {
        form.push(("resource", r));
    }
    let mut secrets = vec![refresh_token];
    secrets.extend(client.secret.as_deref());
    let mut t = token_request(token_url, &form, &secrets)?;
    // A server that doesn't rotate keeps the old refresh token working.
    if t.refresh.is_none() {
        t.refresh = Some(refresh_token.to_string());
    }
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_pairs_are_fresh_and_valid() {
        let a = pkce();
        let b = pkce();
        assert_ne!(a.verifier, b.verifier);
        assert!((43..=128).contains(&a.verifier.len()));
        assert_eq!(a.challenge, http::b64url(&sha2::Sha256::digest(a.verifier.as_bytes())));
        assert!(!a.challenge.contains('=') && !a.challenge.contains('+') && !a.challenge.contains('/'));
    }

    #[test]
    fn urls_split_into_origin_and_path() {
        assert_eq!(split("https://mcp.notion.com/mcp"), Some(("https://mcp.notion.com".into(), "/mcp".into())));
        assert_eq!(split("https://gmailmcp.googleapis.com/mcp/v1?x=1"), Some(("https://gmailmcp.googleapis.com".into(), "/mcp/v1".into())));
        assert_eq!(split("https://accounts.google.com/"), Some(("https://accounts.google.com".into(), "".into())));
        assert_eq!(port_of("http://127.0.0.1:5123/callback"), Some(5123));
        assert_eq!(port_of("http://localhost:51735/callback"), Some(51735));
    }
}
