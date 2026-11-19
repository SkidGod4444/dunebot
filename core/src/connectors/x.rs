//! X (Twitter) through its REST API v2 with the user's own bearer token: search recent posts, and
//! post. X charges per post read and per post made (pay-per-use since February 2026). Blocking.

use serde_json::{json, Value};

use super::{http, remote::Fail};

/// Whether a pasted key could be an X bearer token (it isn't checked with X: that would cost a read).
pub fn tidy_key(raw: &str) -> Option<String> {
    let k = raw.trim();
    let k = k.strip_prefix("Bearer ").or_else(|| k.strip_prefix("bearer ")).unwrap_or(k).trim();
    let ok = (20..=600).contains(&k.len()) && k.chars().all(|c| c.is_ascii_graphic());
    ok.then(|| k.to_string())
}

fn status_fail(status: u16, posting: bool) -> Fail {
    match status {
        401 => Fail::Unauthorized,
        402 => Fail::Other("X says the account has no credits left for this (402). Add credits at console.x.com.".into()),
        403 if posting => Fail::Other(
            "X refused the post (403). An app-only bearer token can only search; posting needs a user token (OAuth 2.0 with tweet.write), or X refused this text.".into(),
        ),
        403 => Fail::Other("X refused (403): this token's app may not have access to search.".into()),
        429 => Fail::Other("X says too many requests (429): try again in a few minutes.".into()),
        s => Fail::Other(format!("X answered {s}")),
    }
}

/// Recent posts (the last 7 days) matching an X search query.
pub fn search(base: &str, token: &str, query: &str, max: u64) -> Result<String, Fail> {
    let max = max.clamp(10, 100).to_string();
    let url = http::with_query(
        &format!("{base}/2/tweets/search/recent"),
        &[
            ("query", query),
            ("max_results", &max),
            ("tweet.fields", "created_at,author_id,public_metrics"),
            ("expansions", "author_id"),
            ("user.fields", "username,name"),
        ],
    );
    let auth = format!("Bearer {token}");
    let a = http::get(&url, &[("authorization", &auth), ("accept", "application/json")], 2 << 20).map_err(|e| Fail::Other(http::redact(&e, &[token])))?;
    if a.status != 200 {
        return Err(status_fail(a.status, false));
    }
    let v = a.json();
    let users: Vec<&Value> = v.pointer("/includes/users").and_then(Value::as_array).map(|u| u.iter().collect()).unwrap_or_default();
    let who = |id: &str| {
        users
            .iter()
            .find(|u| u.get("id").and_then(Value::as_str) == Some(id))
            .map(|u| format!("@{} ({})", u.get("username").and_then(Value::as_str).unwrap_or("?"), u.get("name").and_then(Value::as_str).unwrap_or("")))
            .unwrap_or_else(|| "someone".into())
    };
    let posts = v.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
    if posts.is_empty() {
        return Ok("No posts in the last 7 days match that search.".into());
    }
    let lines: Vec<String> = posts
        .iter()
        .map(|p| {
            let m = p.get("public_metrics").cloned().unwrap_or(json!({}));
            format!(
                "- {} at {}: {} [{} likes, {} reposts, {} replies; post {}]",
                who(p.get("author_id").and_then(Value::as_str).unwrap_or("")),
                p.get("created_at").and_then(Value::as_str).unwrap_or("?"),
                p.get("text").and_then(Value::as_str).unwrap_or("").replace('\n', " "),
                m.get("like_count").and_then(Value::as_u64).unwrap_or(0),
                m.get("retweet_count").and_then(Value::as_u64).unwrap_or(0),
                m.get("reply_count").and_then(Value::as_u64).unwrap_or(0),
                p.get("id").and_then(Value::as_str).unwrap_or("?"),
            )
        })
        .collect();
    Ok(format!("{} recent posts:\n{}", posts.len(), lines.join("\n")))
}

/// Posts `text` as the token's user.
pub fn post(base: &str, token: &str, text: &str) -> Result<String, Fail> {
    let auth = format!("Bearer {token}");
    let a = http::post_json(&format!("{base}/2/tweets"), &json!({ "text": text }), &[("authorization", &auth), ("accept", "application/json")], 256 << 10, 30)
        .map_err(|e| Fail::Other(http::redact(&e, &[token])))?;
    if !(200..300).contains(&a.status) {
        return Err(status_fail(a.status, true));
    }
    let id = a.json().pointer("/data/id").and_then(Value::as_str).unwrap_or("?").to_string();
    Ok(format!("Posted on X (post {id})."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_tidied_or_refused() {
        assert_eq!(tidy_key("  Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAA%3Dxyz  ").as_deref(), Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAA%3Dxyz"));
        assert_eq!(tidy_key("short"), None);
        assert_eq!(tidy_key("has a space in it but is long enough"), None);
        assert_eq!(tidy_key(&"a".repeat(601)), None);
    }
}
