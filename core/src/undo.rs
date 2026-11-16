//! Undo a chat's file changes. Every file its agent wrote goes back to what it was, newest change
//! first: a replaced file gets its kept copy back, a new file is moved out of the way (into the
//! chat's journal, never deleted). A file that changed after the agent wrote it is left alone, and
//! so is anything the gate protects. Commands the agent ran are not undone; the UI says so.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::bail;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{app::App, policy, store::now_ms};

pub fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn undo(app: &Arc<App>, thread_id: &str) -> anyhow::Result<Value> {
    if app.busy.lock().unwrap().contains(thread_id) {
        bail!("The agent is still working in this chat. Stop it first, then undo.");
    }
    let changes = app.db(|d| d.changes_open(thread_id))?;
    let journal = app.data_dir.join("journal").join(thread_id);
    let (mut restored, mut removed) = (0, 0);
    let mut skipped = Vec::new();
    let mut skip = |path: &str, why: &str| skipped.push(json!({ "path": path, "why": why }));

    for c in changes {
        let path = PathBuf::from(&c.path);
        // The same rule as when the agent wrote it: protected places are never touched.
        if let Some(what) = policy::denied(&policy::resolve(&c.path, Path::new("/")), &app.data_dir) {
            skip(&c.path, &format!("it's {what}"));
            continue;
        }
        let now = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if c.backup.is_none() {
                    // A new file that's already gone: nothing left to undo.
                    app.db(|d| d.change_undone(c.id))?;
                } else {
                    skip(&c.path, "it was deleted after the agent wrote it");
                }
                continue;
            }
            Err(e) => {
                skip(&c.path, &format!("it can't be read ({e})"));
                continue;
            }
        };
        if sha256(&now) != c.written_sha256 {
            skip(&c.path, "it changed after the agent wrote it");
            continue;
        }
        if let Some(b) = &c.backup {
            if !Path::new(b).is_file() {
                skip(&c.path, "the copy kept of the old version is missing");
                continue;
            }
        }
        // Keep what's there now, so this undo can itself be undone by hand.
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        // The change id keeps two copies made in the same millisecond apart.
        let keep = journal.join(format!("{}-undone-{}-{name}", now_ms(), c.id));
        tokio::fs::create_dir_all(&journal).await?;
        tokio::fs::write(&keep, &now).await?;
        let keep_s = keep.to_string_lossy().into_owned();
        match &c.backup {
            Some(b) => {
                if let Err(e) = tokio::fs::copy(b, &path).await {
                    skip(&c.path, &format!("it couldn't be written back ({e})"));
                    continue;
                }
                restored += 1;
                let _ = app.db(|d| d.ledger_add(Some(thread_id), "undo", &c.path, "restored", &keep_s));
            }
            None => {
                if let Err(e) = tokio::fs::remove_file(&path).await {
                    skip(&c.path, &format!("it couldn't be moved away ({e})"));
                    continue;
                }
                removed += 1;
                let _ = app.db(|d| d.ledger_add(Some(thread_id), "undo", &c.path, "new file moved to the journal", &keep_s));
            }
        }
        app.db(|d| d.change_undone(c.id))?;
    }
    Ok(json!({ "restored": restored, "removed": removed, "skipped": skipped }))
}
