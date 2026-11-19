//! The requests, and the desktop session behind them: GNOME's remote-control permission (the
//! screen plus keyboard and pointer, in one box the desktop remembers), the screen's video stream
//! and the libei connection that clicks and types.

use crate::{eyes::Eyes, hand::Hand};
use ashpd::desktop::{
    CreateSessionOptions, PersistMode, ResponseError, Session,
    remote_desktop::{ConnectToEISOptions, DeviceType, RemoteDesktop, SelectDevicesOptions, StartOptions},
    screencast::{CursorMode, OpenPipeWireRemoteOptions, Screencast, SelectSourcesOptions, SourceType},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use std::rc::Rc;
use tokio::sync::mpsc;

type Out = mpsc::UnboundedSender<Value>;

struct Live {
    session: Rc<Session<RemoteDesktop>>,
    hand: Option<Hand>,
    eyes: Option<Eyes>,
    watch: tokio::task::JoinHandle<()>,
}

impl Live {
    /// Lets go of anything held, stops the stream, ends the session (the orange dot goes).
    async fn shutdown(mut self) {
        self.watch.abort();
        if let Some(h) = self.hand.as_mut() {
            h.release_all();
        }
        if let Some(h) = self.hand.take() {
            h.stop();
        }
        if let Some(e) = self.eyes.take() {
            e.stop();
        }
        let _ = self.session.close().await;
    }
}

pub async fn serve() {
    let (out, mut out_rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(v) = out_rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });
    let reply = |id: Value, r: Result<Value, String>| {
        let mut msg = match r {
            Ok(Value::Object(m)) => Value::Object(m),
            Ok(_) => json!({}),
            Err(e) => json!({ "error": e }),
        };
        if msg.get("error").is_none() {
            msg["ok"] = json!(true);
        }
        msg["id"] = id;
        let _ = out.send(msg);
    };
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut live: Option<Live> = None;
    let (closed_tx, mut closed_rx) = mpsc::unbounded_channel::<()>();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                // stdin closed: the app is gone, so is the session.
                let Ok(Some(line)) = line else { break };
                let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                let op = req.get("op").and_then(Value::as_str).unwrap_or("").to_string();
                if op != "open" {
                    let r = handle(&op, &req, &mut live).await;
                    reply(id, r);
                    if op == "quit" {
                        break;
                    }
                    continue;
                }
                if let Some(l) = live.take() {
                    l.shutdown().await;
                }
                let token = req.get("token").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string);
                let begun = match begin(token.as_deref()).await {
                    Ok(b) => b,
                    Err(e) => {
                        reply(id, Err(e));
                        continue;
                    }
                };
                // GNOME's box can wait on the user for minutes. Requests are still read meanwhile:
                // close, quit or the app going away cancel it (the box goes), others are refused.
                let session = begun.session.clone();
                let finish = finish(begun, &out, &closed_tx);
                tokio::pin!(finish);
                let mut after: Option<(Value, bool)> = None; // the close/quit that cancelled it
                let done = loop {
                    tokio::select! {
                        r = &mut finish => break Some(r),
                        next = lines.next_line() => {
                            let Ok(Some(next)) = next else {
                                after = Some((Value::Null, true));
                                break None;
                            };
                            let Ok(r2) = serde_json::from_str::<Value>(&next) else { continue };
                            let id2 = r2.get("id").cloned().unwrap_or(Value::Null);
                            match r2.get("op").and_then(Value::as_str).unwrap_or("") {
                                "close" => { after = Some((id2, false)); break None; }
                                "quit" => { after = Some((id2, true)); break None; }
                                _ => reply(id2, Err("GNOME is still asking the user (its box is open).".into())),
                            }
                        }
                    }
                };
                match done {
                    Some(Ok((l, answer))) => {
                        live = Some(l);
                        reply(id, Ok(answer));
                    }
                    Some(Err(e)) => reply(id, Err(e)),
                    None => {
                        // GNOME 46 leaves the box up when only the session is closed; it goes with
                        // the D-Bus connection. So a cancelled box ends this helper too: the app
                        // starts a new one when it next needs it.
                        let _ = session.close().await;
                        reply(id, Err("cancelled".into()));
                        if let Some((id2, _)) = after {
                            if !id2.is_null() {
                                reply(id2, Ok(json!({ "exiting": true })));
                            }
                        }
                        drop(finish);
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        break;
                    }
                }
            }
            Some(()) = closed_rx.recv() => {
                if let Some(l) = live.take() {
                    l.shutdown().await;
                    let _ = out.send(json!({ "event": "closed" }));
                }
            }
        }
    }
    if let Some(l) = live.take() {
        l.shutdown().await;
    }
}

fn num(req: &Value, k: &str) -> Result<f64, String> {
    req.get(k).and_then(Value::as_f64).filter(|v| v.is_finite()).ok_or_else(|| format!("{k} is missing"))
}

fn portal_error(e: ashpd::Error) -> String {
    match e {
        ashpd::Error::Response(ResponseError::Cancelled) => "cancelled".into(),
        other => other.to_string(),
    }
}

async fn handle(op: &str, req: &Value, live: &mut Option<Live>) -> Result<Value, String> {
    match op {
        "close" => {
            if let Some(l) = live.take() {
                l.shutdown().await;
            }
            Ok(json!({}))
        }
        "quit" => Ok(json!({})),
        _ => {
            let l = live.as_mut().ok_or("There's no session: open one first.")?;
            match op {
                "frame" => {
                    let eyes = l.eyes.as_ref().ok_or("The screen wasn't shared.")?;
                    let node = req.get("node").and_then(Value::as_u64).ok_or("node is missing")? as u32;
                    let path = req.get("path").and_then(Value::as_str).ok_or("path is missing")?;
                    let (w, h) = eyes.frame(node, path).await?;
                    Ok(json!({ "w": w, "h": h }))
                }
                _ => {
                    let hand = l.hand.as_mut().ok_or("Control of the keyboard and pointer wasn't allowed.")?;
                    match op {
                        "move" => hand.move_to(num(req, "x")?, num(req, "y")?)?,
                        "button" => {
                            let b = req.get("button").and_then(Value::as_str).unwrap_or("left");
                            hand.button(b, req.get("down").and_then(Value::as_bool).unwrap_or(false))?
                        }
                        "scroll" => {
                            let n = req.get("n").and_then(Value::as_u64).unwrap_or(1).clamp(1, 30) as u32;
                            hand.scroll(num(req, "dx").unwrap_or(0.0) as i32, num(req, "dy").unwrap_or(0.0) as i32, n).await?
                        }
                        "key" => {
                            let sym = req.get("keysym").and_then(Value::as_u64).ok_or("keysym is missing")? as u32;
                            hand.key(sym, req.get("down").and_then(Value::as_bool).unwrap_or(false))?
                        }
                        "text" => {
                            let ch = req.get("ch").and_then(Value::as_str).and_then(|s| s.chars().next()).ok_or("ch is missing")?;
                            hand.text(ch).await?
                        }
                        "can_type" => {
                            let s = req.get("text").and_then(Value::as_str).unwrap_or("");
                            let mut missing = String::new();
                            for c in s.chars() {
                                if !hand.can_type(c)? && !missing.contains(c) {
                                    missing.push(c);
                                }
                            }
                            return Ok(json!({ "missing": missing, "layout": hand.layout_name(), "state": hand.state_note() }));
                        }
                        _ => return Err(format!("unknown request {op}")),
                    }
                    Ok(json!({}))
                }
            }
        }
    }
}

struct Begun {
    rd: RemoteDesktop,
    sc: Screencast,
    session: Rc<Session<RemoteDesktop>>,
}

/// One session: the screen (every monitor the user shares) and the keyboard and pointer, kept by
/// the desktop until the user takes it back. With a token from before, GNOME doesn't ask again.
/// This part never shows anything, so a failure is tried once more: GNOME's portal backend restarts
/// after a box goes away mid-question, and a request that reaches it while it starts gets a bare
/// "didn't succeed".
async fn begin(token: Option<&str>) -> Result<Begun, String> {
    match begin_once(token).await {
        Err(e) if e != "cancelled" => {
            if crate::hand::debug() {
                eprintln!("dunebot-wayland: setting up the session failed ({e}); once more");
            }
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            begin_once(token).await
        }
        r => r,
    }
}

async fn begin_once(token: Option<&str>) -> Result<Begun, String> {
    let rd = RemoteDesktop::new()
        .await
        .map_err(|e| format!("This desktop has no remote-control service (xdg-desktop-portal): {e}"))?;
    let sc = Screencast::new().await.map_err(|e| format!("This desktop has no screen-sharing service: {e}"))?;
    let session = Rc::new(rd.create_session(CreateSessionOptions::default()).await.map_err(portal_error)?);
    let chosen = async {
        rd.select_devices(
            &session,
            SelectDevicesOptions::default()
                .set_devices(DeviceType::KEYBOARD | DeviceType::POINTER)
                .set_persist_mode(PersistMode::ExplicitlyRevoked)
                .set_restore_token(token),
        )
        .await
        .map_err(portal_error)?
        .response()
        .map_err(portal_error)?;
        // Pictures without the pointer drawn in, as on the other systems: it can hide what's under it.
        sc.select_sources(
            &session,
            SelectSourcesOptions::default().set_sources(SourceType::MONITOR).set_multiple(true).set_cursor_mode(CursorMode::HIDDEN),
        )
        .await
        .map_err(portal_error)?
        .response()
        .map_err(portal_error)
    }
    .await;
    if let Err(e) = chosen {
        let _ = session.close().await;
        return Err(e);
    }
    Ok(Begun { rd, sc, session })
}

/// The box (unless the token answers it), then the hand and the eyes.
async fn finish(b: Begun, out: &Out, closed: &mpsc::UnboundedSender<()>) -> Result<(Live, Value), String> {
    let Begun { rd, sc, session } = b;
    let _ = out.send(json!({ "event": "asking" }));
    let started = match rd.start(&session, None, StartOptions::default()).await.map_err(portal_error)?.response() {
        Ok(s) => s,
        Err(e) => {
            let _ = session.close().await;
            return Err(portal_error(e));
        }
    };
    let devices = started.devices().bits();
    let streams: Vec<Value> = started
        .streams()
        .iter()
        .map(|s| {
            let (x, y) = s.position().unwrap_or((0, 0));
            let (w, h) = s.size().unwrap_or((0, 0));
            json!({ "node": s.pipe_wire_node_id(), "x": x, "y": y, "w": w, "h": h, "mapping": s.mapping_id() })
        })
        .collect();
    let mut answer = json!({ "devices": devices, "streams": streams, "token": started.restore_token() });

    // The user can end it from GNOME's top bar at any time: that's a stop.
    let watch = {
        let closed = closed.clone();
        let session = session.clone();
        tokio::task::spawn_local(async move {
            if let Ok(mut s) = session.receive_closed().await {
                if s.next().await.is_some() {
                    let _ = closed.send(());
                }
            }
        })
    };

    let mut live = Live { session, hand: None, eyes: None, watch };
    if devices & (DeviceType::KEYBOARD | DeviceType::POINTER).bits() != 0 {
        let hand = match rd.connect_to_eis(&live.session, ConnectToEISOptions::default()).await {
            Ok(fd) => Hand::connect(fd, closed.clone()).await.map_err(|e| format!("libei: {e}")),
            Err(e) => Err(format!("ConnectToEIS: {e}")),
        };
        match hand {
            Ok(h) => live.hand = Some(h),
            Err(e) => answer["hand_error"] = json!(e),
        }
    }
    if !started.streams().is_empty() {
        let eyes = match sc.open_pipe_wire_remote(&live.session, OpenPipeWireRemoteOptions::default()).await {
            Ok(fd) => Eyes::start(fd).map_err(|e| format!("pipewire: {e}")),
            Err(e) => Err(format!("OpenPipeWireRemote: {e}")),
        };
        match eyes {
            Ok(e) => live.eyes = Some(e),
            Err(e) => answer["eyes_error"] = json!(e),
        }
    }
    answer["hand"] = json!(live.hand.is_some());
    answer["eyes"] = json!(live.eyes.is_some());
    if let Some(h) = &live.hand {
        answer["regions"] = json!(h.regions());
    }
    Ok((live, answer))
}
