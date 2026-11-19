//! Dune Bot core: owns every decision. The Electron shell only draws what this process says.
//!
//! Host protocol: one JSON object per line on stdin/stdout (see docs/protocol.md).
//! Agent tools: a loopback MCP endpoint, one bearer token per chat (see mcp.rs).

mod agent;
mod asked;
mod dictation;
mod fixes;
mod keys;
mod lookonly;
mod app;
mod deepgram;
mod history;
mod mcp;
mod policy;
mod protocol;
mod sarvam;
mod speak_stream;
mod schedule;
mod store;
mod team;
mod telegram;
mod tools;
mod undo;
mod voice;

use std::{path::PathBuf, sync::Arc};

use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let data_dir = std::env::var_os("DUNEBOT_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let base = dirs::data_dir().unwrap_or_else(std::env::temp_dir);
            move_renamed(&base.join("Deskmate"), &base.join("Dunebot"));
            base.join("Dunebot")
        });
    std::fs::create_dir_all(&data_dir)?;
    rename_old_db(&data_dir);

    let out = protocol::Out::start();
    let store = store::Store::open(&data_dir.join("dunebot.db"))?;
    let app = Arc::new(app::App::new(out, store, data_dir));
    #[cfg(feature = "voice")]
    if let [_, flag, file] = std::env::args().collect::<Vec<_>>().as_slice() {
        if flag == "--transcribe" {
            let (app, file) = (app.clone(), file.clone());
            tokio::task::spawn_blocking(move || voice::cli(&app, &file)).await??;
            tokio::time::sleep(std::time::Duration::from_millis(100)).await; // let stdout flush
            return Ok(());
        }
    }
    let port = mcp::serve(app.clone()).await?;
    app.set_mcp_port(port);
    agent::spawn_reaper(app.clone());
    schedule::spawn(app.clone());
    // The user's Telegram bot (Settings › Phone): polls once the app hands over its token.
    telegram::spawn(app.clone());
    {
        let app = app.clone();
        tokio::task::spawn_blocking(move || history::backfill(&app));
    }
    // The chord (macOS; ⌥⌘ unless Settings picks other keys): only when the desktop app asks for it,
    // never in tests.
    if std::env::var("DUNEBOT_CHORD").as_deref() == Ok("1") {
        let chosen = app.db(|d| d.get_setting("pref.keys.chord")).ok().flatten();
        keys::choose(chosen.as_deref());
        let rt = tokio::runtime::Handle::current();
        let app2 = app.clone();
        let on = keys::watch(move |fire| {
            let app = app2.clone();
            rt.spawn(async move { on_chord(&app, fire) });
        });
        app.out.event("chord.ready", serde_json::json!({ "available": on, "keys": keys::chosen().1 }));
        // Dictation: Right ⌥ held alone types what you say (dictation.rs), watched beside the chord.
        dictation::start(&app);
    }
    app.out.event(
        "ready",
        serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "platform": std::env::consts::OS }),
    );

    // The host owns our lifetime: when it closes stdin, we stop.
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let app = app.clone();
        tokio::spawn(async move { protocol::dispatch(app, line).await });
    }
    Ok(())
}

/// Tells the desktop app; it opens the bar on a tap and, on a hold, starts listening once it has
/// checked the microphone permission (opening the mic before that would trigger the system's
/// permission box mid-sentence and lose what you said).
fn on_chord(app: &std::sync::Arc<app::App>, fire: keys::Fire) {
    use keys::Fire;
    let kind = match fire {
        Fire::Tap => "tap",
        Fire::HoldStart => "hold-start",
        Fire::HoldEnd => "hold-end",
        Fire::HoldCancel => "hold-cancel",
    };
    app.out.event("chord", serde_json::json!({ "kind": kind }));
}

/// The app was called "Deskmate" until 2026-11-16: its folder (chats, history, settings, the speech model)
/// moves to Dune Bot's once. What the new folder already has (the shell may have started it) stays;
/// the rest moves, and the old folder goes once it's empty.
fn move_renamed(old: &std::path::Path, new: &std::path::Path) {
    if !old.is_dir() {
        return;
    }
    if !new.exists() {
        if std::fs::rename(old, new).is_ok() {
            return;
        }
        let _ = std::fs::create_dir_all(new);
    }
    if let Ok(entries) = std::fs::read_dir(old) {
        for e in entries.flatten() {
            let to = new.join(e.file_name());
            if !to.exists() {
                let _ = std::fs::rename(e.path(), to);
            }
        }
    }
    let _ = std::fs::remove_dir(old); // only when empty
}

/// The database's old name (and SQLite's side files with it), once.
fn rename_old_db(dir: &std::path::Path) {
    let old = dir.join("deskmate.db");
    if !old.exists() || dir.join("dunebot.db").exists() {
        return;
    }
    for ext in ["", "-wal", "-shm"] {
        let from = dir.join(format!("deskmate.db{ext}"));
        if from.exists() {
            let _ = std::fs::rename(from, dir.join(format!("dunebot.db{ext}")));
        }
    }
}

