//! A small client for a vendor's remote MCP server (Streamable HTTP, protocol 2025-06-18): start a
//! session, list its tools, call one. Blocking; run it off the async threads.

use serde_json::{json, Value};

use super::http;

pub const PROTOCOL: &str = "2025-06-18";

#[derive(Debug, PartialEq, Eq)]
pub enum Fail {
    /// The token was refused (HTTP 401): refresh it, or sign in again.
    Unauthorized,
    /// The server forgot the session (HTTP 404 on a session): start a new one.
    Gone,
    Other(String),
}

/// One JSON-RPC request; the answer's `result` and the session id the server named, if any.
fn rpc(url: &str, token: &str, session: Option<&str>, id: u64, method: &str, params: Value, limit: u64, secs: u64) -> Result<(Value, Option<String>), Fail> {
    let auth = format!("Bearer {token}");
    let mut headers = vec![("authorization", auth.as_str()), ("accept", "application/json, text/event-stream")];
    // After initialize, every request names the protocol (servers without sessions too).
    if method != "initialize" {
        headers.push(("mcp-protocol-version", PROTOCOL));
    }
    if let Some(s) = session {
        headers.push(("mcp-session-id", s));
    }
    let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let a = http::post_json(url, &body, &headers, limit, secs).map_err(|e| Fail::Other(http::redact(&e, &[token])))?;
    match a.status {
        401 => return Err(Fail::Unauthorized),
        404 if session.is_some() => return Err(Fail::Gone),
        200..=299 => {}
        403 => return Err(Fail::Other("it refused (403): the account may not allow this".into())),
        429 => return Err(Fail::Other("it says too many requests (429): try again in a minute".into())),
        s => return Err(Fail::Other(format!("it answered {s}"))),
    }
    let answer = if a.content_type.starts_with("text/event-stream") { from_events(&a.body, id) } else { Some(a.json()) };
    let Some(answer) = answer.filter(Value::is_object) else {
        return Err(Fail::Other("its answer couldn't be read".into()));
    };
    if let Some(err) = answer.get("error") {
        let msg = err.get("message").and_then(Value::as_str).unwrap_or("an error");
        return Err(Fail::Other(http::redact(msg, &[token]).chars().take(200).collect()));
    }
    Ok((answer.get("result").cloned().unwrap_or(Value::Null), a.session))
}

/// The JSON-RPC answer with `id` from a server-sent event stream.
fn from_events(body: &str, id: u64) -> Option<Value> {
    let body = body.replace("\r\n", "\n");
    for event in body.split("\n\n") {
        let data: Vec<&str> = event.lines().filter_map(|l| l.strip_prefix("data:")).map(|d| d.strip_prefix(' ').unwrap_or(d)).collect();
        if data.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&data.join("\n")) else { continue };
        if v.get("id") == Some(&json!(id)) && (v.get("result").is_some() || v.get("error").is_some()) {
            return Some(v);
        }
    }
    None
}

/// Starts a session: `initialize`, then `notifications/initialized`. The session id, if the server
/// keeps sessions.
pub fn initialize(url: &str, token: &str) -> Result<Option<String>, Fail> {
    let params = json!({
        "protocolVersion": PROTOCOL,
        "capabilities": {},
        "clientInfo": { "name": "Dune Bot", "version": env!("CARGO_PKG_VERSION") },
    });
    let (_, session) = rpc(url, token, None, 1, "initialize", params, 256 << 10, 30)?;
    let auth = format!("Bearer {token}");
    let mut headers = vec![("authorization", auth.as_str()), ("accept", "application/json, text/event-stream"), ("mcp-protocol-version", PROTOCOL)];
    if let Some(s) = session.as_deref() {
        headers.push(("mcp-session-id", s));
    }
    let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    match http::post_json(url, &note, &headers, 64 << 10, 30) {
        Ok(a) if a.status == 401 => Err(Fail::Unauthorized),
        _ => Ok(session),
    }
}

/// Every tool the server offers (at most 20 pages of them).
pub fn list_tools(url: &str, token: &str, session: Option<&str>) -> Result<Vec<Value>, Fail> {
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    for page in 0..20u64 {
        let params = match &cursor {
            Some(c) => json!({ "cursor": c }),
            None => json!({}),
        };
        let (result, _) = rpc(url, token, session, 10 + page, "tools/list", params, 4 << 20, 60)?;
        tools.extend(result.get("tools").and_then(Value::as_array).cloned().unwrap_or_default());
        cursor = result.get("nextCursor").and_then(Value::as_str).filter(|c| !c.is_empty()).map(String::from);
        if cursor.is_none() {
            break;
        }
    }
    Ok(tools)
}

/// Calls one tool: its text, and whether the server says it failed.
pub fn call_tool(url: &str, token: &str, session: Option<&str>, name: &str, args: &Value) -> Result<(String, bool), Fail> {
    let (result, _) = rpc(url, token, session, 100, "tools/call", json!({ "name": name, "arguments": args }), 8 << 20, 90)?;
    let mut parts = Vec::new();
    for c in result.get("content").and_then(Value::as_array).into_iter().flatten() {
        match c.get("type").and_then(Value::as_str) {
            Some("text") => parts.push(c.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
            Some("resource") => {
                if let Some(t) = c.pointer("/resource/text").and_then(Value::as_str) {
                    parts.push(t.to_string());
                }
            }
            Some("resource_link") => {
                let n = c.get("name").and_then(Value::as_str).unwrap_or("a file");
                parts.push(format!("[{n}]"));
            }
            Some("image") => parts.push("[a picture]".into()),
            Some("audio") => parts.push("[a sound]".into()),
            _ => {}
        }
    }
    if parts.is_empty() {
        if let Some(s) = result.get("structuredContent") {
            parts.push(s.to_string());
        }
    }
    let failed = result.get("isError") == Some(&json!(true));
    Ok((parts.join("\n"), failed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_answer_from_an_event_stream() {
        let body = "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\nevent: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\r\ndata: \"result\":{\"ok\":1}}\r\n\r\n";
        assert_eq!(from_events(body, 7), Some(json!({ "jsonrpc": "2.0", "id": 7, "result": { "ok": 1 } })));
        assert_eq!(from_events(body, 8), None);
    }
}
