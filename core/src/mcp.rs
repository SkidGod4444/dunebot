//! Loopback MCP endpoint (streamable HTTP, JSON responses only). One path and one bearer token
//! per chat, so every tool call is tied to the chat whose approvals it uses. Browsers are refused
//! (any Origin header), and so is any Host that isn't this loopback port.

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};

use crate::{app::App, tools};

pub async fn serve(app: Arc<App>) -> anyhow::Result<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let router = Router::new()
        .route(
            "/t/{thread}/mcp",
            post(handle)
                .get(|| async { StatusCode::METHOD_NOT_ALLOWED })
                .delete(|| async { StatusCode::OK }),
        )
        .with_state(app);
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("dunebot-core: tool endpoint stopped: {e}");
        }
    });
    Ok(port)
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

async fn handle(
    State(app): State<Arc<App>>,
    Path(thread_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if headers.contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    let host_ok = host
        .rsplit_once(':')
        .map(|(h, _)| h == "127.0.0.1" || h == "localhost")
        .unwrap_or(false);
    if !host_ok {
        return StatusCode::FORBIDDEN.into_response();
    }
    let auth = headers.get(header::AUTHORIZATION).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !app.check_token(&thread_id, auth) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let msg: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return Json(rpc_error(Value::Null, -32700, "parse error")).into_response(),
    };
    match msg {
        Value::Array(items) => {
            let mut out = Vec::new();
            for m in items {
                if let Some(r) = one(&app, &thread_id, m).await {
                    out.push(r);
                }
            }
            if out.is_empty() {
                StatusCode::ACCEPTED.into_response()
            } else {
                Json(Value::Array(out)).into_response()
            }
        }
        m => match one(&app, &thread_id, m).await {
            Some(r) => Json(r).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
    }
}

/// Runs one tool and shows it in the chat as a tool card that updates when it finishes.
/// A picture (look_at_screen) goes to the agent only: the card keeps the text line.
pub async fn run_tool(app: &Arc<App>, thread: &crate::store::Thread, name: &str, args: &Value) -> (String, bool, Option<Value>) {
    let kept = tools::recorded_args(name, args);
    let meta = json!({ "tool": name, "args": kept, "status": "running" });
    let card = app.add_message(&thread.id, "tool", name, meta).ok();
    let (text, is_error, image) = tools::call(app, thread, name, args).await;
    if let Some(card) = card {
        let output: String = text.chars().take(4000).collect();
        let status = if is_error { "failed" } else { "done" };
        app.update_message(&card.id, name, json!({ "tool": name, "args": kept, "status": status, "output": output }));
    }
    (text, is_error, image)
}

/// One JSON-RPC message. Notifications (no id) get no answer.
async fn one(app: &Arc<App>, thread_id: &str, m: Value) -> Option<Value> {
    let id = m.get("id").cloned()?;
    let method = m.get("method").and_then(Value::as_str).unwrap_or("");
    let params = m.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match method {
        "initialize" => json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "dunebot", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "Dune Bot's tools act on the user's own computer. Some ask the user first; a declined action must not be retried.",
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools::list() }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let thread = match app.db(|d| d.get_thread(thread_id)) {
                Ok(t) => t,
                Err(_) => return Some(rpc_error(id, -32602, "this chat no longer exists")),
            };
            let (text, is_error, image) = run_tool(app, &thread, name, &args).await;
            let mut content = vec![json!({ "type": "text", "text": text })];
            content.extend(image);
            json!({ "content": content, "isError": is_error })
        }
        _ => return Some(rpc_error(id, -32601, "method not found")),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}
