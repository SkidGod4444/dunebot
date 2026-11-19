//! The little HTTP the connectors need, with the rules that keep tokens in: redirects are never
//! followed (a token-bearing request goes only where it was sent), bodies are read with a limit, and
//! every error that might reach a page or an agent has its addresses and secrets taken out.

use std::time::Duration;

use serde_json::Value;

/// One HTTP answer, read whole.
pub struct Answer {
    pub status: u16,
    pub content_type: String,
    pub session: Option<String>,
    pub body: String,
}

impl Answer {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

fn agent(secs: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(secs)))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into()
}

fn read(mut resp: ureq::http::Response<ureq::Body>, limit: u64) -> Result<Answer, String> {
    let status = resp.status().as_u16();
    let header = |k: &str| resp.headers().get(k).and_then(|v| v.to_str().ok()).map(String::from);
    let content_type = header("content-type").unwrap_or_default().to_ascii_lowercase();
    let session = header("mcp-session-id");
    let body = resp
        .body_mut()
        .with_config()
        .limit(limit)
        .read_to_string()
        .map_err(|e| format!("the answer couldn't be read ({})", redact(&e.to_string(), &[])))?;
    Ok(Answer { status, content_type, session, body })
}

fn failed(e: ureq::Error) -> String {
    // ureq's errors can name the address; it's taken out whole.
    format!("it couldn't be reached ({})", redact(&e.to_string(), &[]))
}

pub fn get(url: &str, headers: &[(&str, &str)], limit: u64) -> Result<Answer, String> {
    let mut req = agent(30).get(url);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    read(req.call().map_err(failed)?, limit)
}

pub fn post_form(url: &str, form: &[(&str, &str)], headers: &[(&str, &str)]) -> Result<Answer, String> {
    let mut req = agent(30).post(url).header("accept", "application/json");
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    read(req.send_form(form.iter().copied()).map_err(failed)?, 256 << 10)
}

pub fn post_json(url: &str, body: &Value, headers: &[(&str, &str)], limit: u64, secs: u64) -> Result<Answer, String> {
    let mut req = agent(secs).post(url).header("content-type", "application/json");
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let bytes = serde_json::to_vec(body).map_err(|e| e.to_string())?;
    read(req.send(&bytes[..]).map_err(failed)?, limit)
}

/// Text that may reach a page, an agent or a log, without secrets or addresses: each secret is
/// replaced, every URL is cut to its scheme and host, and the rest is kept short.
pub fn redact(text: &str, secrets: &[&str]) -> String {
    let mut s = text.to_string();
    for secret in secrets.iter().filter(|x| x.len() >= 6) {
        s = s.replace(secret, "[hidden]");
    }
    let mut out = String::new();
    let mut rest = s.as_str();
    while let Some(i) = rest.find("http") {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let scheme = if tail.starts_with("https://") { 8 } else if tail.starts_with("http://") { 7 } else { 0 };
        if scheme == 0 {
            out.push_str("http");
            rest = &tail[4..];
            continue;
        }
        let end = tail.find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ')' || c == '>').unwrap_or(tail.len());
        let host_end = tail[scheme..end].find(['/', '?', '#']).map(|j| scheme + j).unwrap_or(end);
        out.push_str(&tail[..host_end]);
        rest = &tail[end..];
    }
    out.push_str(rest);
    let out: String = out.chars().filter(|c| !c.is_control() || *c == ' ').collect();
    out.chars().take(300).collect()
}

/// `application/x-www-form-urlencoded` / query encoding (RFC 3986 unreserved kept).
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(v) => {
                        out.push(v);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `base?k=v&…` with each value encoded.
pub fn with_query(base: &str, pairs: &[(&str, &str)]) -> String {
    let q: Vec<String> = pairs.iter().map(|(k, v)| format!("{}={}", encode(k), encode(v))).collect();
    let sep = if base.contains('?') { '&' } else { '?' };
    format!("{base}{sep}{}", q.join("&"))
}

/// The query of a request target (`/callback?a=1&b=2`) as pairs, decoded.
pub fn query_pairs(target: &str) -> Vec<(String, String)> {
    let q = target.split_once('?').map(|(_, q)| q).unwrap_or("");
    let q = q.split('#').next().unwrap_or("");
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (decode(k), decode(v))
        })
        .collect()
}

/// Base64 for URLs without padding (PKCE).
pub fn b64url(bytes: &[u8]) -> String {
    crate::deepgram::base64(bytes).trim_end_matches('=').replace('+', "-").replace('/', "_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_takes_out_secrets_and_addresses() {
        let r = redact("POST https://slack.com/api/oauth.v2.user.access?code=abc123secret failed: xoxp-1234567 bad", &["xoxp-1234567"]);
        assert_eq!(r, "POST https://slack.com failed: [hidden] bad");
        assert_eq!(redact("see http://127.0.0.1:5555/callback?state=s and httpx", &[]), "see http://127.0.0.1:5555 and httpx");
        assert!(redact(&"x".repeat(1000), &[]).len() <= 300);
    }

    #[test]
    fn encoding_round_trips() {
        assert_eq!(encode("a b/c?d=é"), "a%20b%2Fc%3Fd%3D%C3%A9");
        assert_eq!(decode("4%2F0Ab+x%zz"), "4/0Ab x%zz");
        assert_eq!(decode("%"), "%");
        assert_eq!(decode("%4"), "%4");
        let pairs = query_pairs("/callback?code=4%2F0A&state=s1&iss=https%3A%2F%2Fmcp.notion.com#frag");
        assert_eq!(pairs, vec![("code".into(), "4/0A".into()), ("state".into(), "s1".into()), ("iss".into(), "https://mcp.notion.com".into())]);
        assert_eq!(with_query("https://x.test/a", &[("q", "a b"), ("n", "1")]), "https://x.test/a?q=a%20b&n=1");
    }

    #[test]
    fn pkce_base64url() {
        // RFC 7636 appendix B.
        use sha2::Digest;
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(b64url(&sha2::Sha256::digest(verifier.as_bytes())), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }
}
