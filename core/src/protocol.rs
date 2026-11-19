//! Host protocol: requests `{id?, method, params}` in, `{id, result}` / `{id, error}` and
//! `{event, ...}` lines out. The host sends ids and choices only; every decision is made here.

use std::sync::Arc;

use anyhow::{anyhow, bail};
use serde_json::{json, Value};
use tokio::{io::AsyncWriteExt, sync::mpsc};

use crate::{agent, app::App};

#[derive(Clone)]
pub struct Out(mpsc::UnboundedSender<String>);

impl Out {
    pub fn start() -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            let mut stdout = tokio::io::stdout();
            while let Some(mut line) = rx.recv().await {
                line.push('\n');
                if let Err(e) = stdout.write_all(line.as_bytes()).await {
                    // Every later event and answer would be lost without a word: say so once.
                    eprintln!("dunebot-core: can't write to the app any more ({e}); events stop here");
                    break;
                }
                let _ = stdout.flush().await;
            }
        });
        Out(tx)
    }

    pub fn send(&self, v: Value) {
        let _ = self.0.send(v.to_string());
    }

    pub fn event(&self, name: &str, data: Value) {
        let mut v = match data {
            Value::Object(m) => Value::Object(m),
            other => json!({ "data": other }),
        };
        v["event"] = json!(name);
        self.send(v);
    }

    fn reply(&self, id: Value, r: Result<Value, String>) {
        match r {
            Ok(result) => self.send(json!({ "id": id, "result": result })),
            Err(error) => self.send(json!({ "id": id, "error": error })),
        }
    }
}

pub async fn dispatch(app: Arc<App>, line: String) {
    let msg: Value = match serde_json::from_str(&line) {
        Ok(v) => v,
        Err(e) => {
            app.out.event("error", json!({ "message": format!("bad request line: {e}") }));
            return;
        }
    };
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
    let r = handle(&app, &method, &params).await.map_err(|e| format!("{e:#}"));
    match id {
        Some(id) => app.out.reply(id, r),
        None => {
            if let Err(message) = r {
                app.out.event("error", json!({ "method": method, "message": message }));
            }
        }
    }
}

fn s<'a>(p: &'a Value, k: &str) -> anyhow::Result<&'a str> {
    p.get(k).and_then(Value::as_str).ok_or_else(|| anyhow!("missing \"{k}\""))
}

async fn handle(app: &Arc<App>, method: &str, p: &Value) -> anyhow::Result<Value> {
    Ok(match method {
        "hello" => json!({
            "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "dataDir": app.data_dir,
        }),
        "threads.list" => json!(app.db(|d| d.list_threads())?),
        "threads.create" => {
            let agent = p.get("agent").and_then(Value::as_str).unwrap_or("claude");
            let title = p.get("title").and_then(Value::as_str).unwrap_or("New chat");
            json!(app.create_thread(agent, title, p.get("cwd").and_then(Value::as_str))?)
        }
        "threads.get" => {
            let id = s(p, "id")?;
            let thread = app.db(|d| d.get_thread(id))?;
            let messages = app.db(|d| d.messages(id))?;
            json!({ "thread": thread, "messages": messages })
        }
        "threads.delete" => {
            agent::cancel(app, s(p, "id")?).await?;
            app.delete_thread(s(p, "id")?).await?;
            json!({ "ok": true })
        }
        "threads.send" => {
            // From the bar: the answer is spoken and shown as a caption by the pointer (agent::SPOKEN_NOTE).
            let spoken = p.get("spoken").and_then(Value::as_bool).unwrap_or(false);
            agent::send(app.clone(), s(p, "id")?, s(p, "text")?, spoken, crate::asked::Origin::User).await?
        }
        "threads.cancel" => {
            agent::cancel(app, s(p, "id")?).await?;
            json!({ "ok": true })
        }
        "threads.changes" => {
            let id = s(p, "id")?;
            json!(app.db(|d| d.changes_open(id))?)
        }
        "threads.undo" => crate::undo::undo(app, s(p, "id")?).await?,
        "approvals.respond" => app.respond(s(p, "id")?, s(p, "decision")?)?,
        // The app only (never a window): the picture asked for by a `screen.capture` event.
        "screen.result" => app.capture_result(p)?,
        // The app only: where the computer is, asked for by a `location.request` event.
        "location.result" => app.location_result(p)?,
        // The app only: whether the click asked for by an `input.click` event was made.
        "input.result" => app.input_result(p)?,
        "settings.get" => app.settings_json(),
        // The user's accounts (connectors/). Pages see states and names, never a sign-in.
        "connectors.list" => crate::connectors::list(app),
        "connectors.connect" => crate::connectors::connect(app, p)?,
        "connectors.cancel" => crate::connectors::cancel(app, p)?,
        "connectors.disconnect" => crate::connectors::disconnect(app, p)?,
        // The app only (never a page): a saved sign-in it unlocked, for a `connectors.need` event.
        "connectors.secret" => crate::connectors::receive(app, p)?,
        "settings.set" => {
            app.set_mode(s(p, "action")?, s(p, "mode")?)?;
            app.settings_json()
        }
        "prefs.set" => {
            app.set_pref(s(p, "key")?, s(p, "value")?)?;
            app.settings_json()
        }
        "voice.status" => crate::voice::status(app),
        "voice.prepare" => crate::voice::prepare(app),
        "voice.test" => {
            let app = app.clone();
            tokio::task::spawn_blocking(move || crate::voice::test(&app)).await??
        }
        "voice.start" => {
            crate::voice::start(app, p.get("source").and_then(Value::as_str).unwrap_or("button"))?;
            json!({ "ok": true })
        }
        "voice.stop" => {
            crate::voice::stop(app);
            json!({ "ok": true })
        }
        "voice.cancel" => {
            crate::voice::cancel(app);
            json!({ "ok": true })
        }
        // The app only (never a page): hands over the Sarvam key, or takes it back with null.
        "voice.key" => {
            app.sarvam.set_key(p.get("key").and_then(Value::as_str).map(String::from))?;
            crate::voice::status(app)
        }
        // The app only (never a page): hands over the Deepgram key (English answers in an American
        // voice), or takes it back with null.
        "voice.deepgramKey" => {
            let key = p.get("key").and_then(Value::as_str).map(String::from);
            if key.is_none() {
                for (_, h) in app.sarvam.streams.lock().unwrap().drain() {
                    h.close();
                }
            }
            app.deepgram.set_key(key)?;
            json!({ "ok": true })
        }
        // A sentence or two of an answer, read aloud whole: base64 MP3. English by Deepgram's American
        // voice when its key is saved (Sarvam if Deepgram fails), anything else by Sarvam.
        "voice.say" => {
            let text = s(p, "text")?.to_string();
            let sarvam = app.sarvam_on();
            // An answer to a Hindi or Hinglish question: English on the card, Hinglish aloud.
            if sarvam && app.sarvam.hinglish_answer() && crate::deepgram::is_english(&text) {
                let spoken = crate::speak_stream::hinglish_or_english(app, &text).await;
                let app = app.clone();
                let audio = tokio::task::spawn_blocking(move || app.sarvam.say_as(&spoken, "hi-IN", 1500)).await??;
                return Ok(json!({ "audio": audio, "type": "audio/mpeg" }));
            }
            let american = app.deepgram_on() && crate::deepgram::is_english(&text);
            if !american && !sarvam {
                anyhow::bail!("Sarvam is off");
            }
            let app = app.clone();
            let audio = tokio::task::spawn_blocking(move || {
                if american {
                    match app.deepgram.say(&text) {
                        Err(e) if sarvam => {
                            eprintln!("dunebot-core: voice: Deepgram couldn't read a sentence ({e:#}); Sarvam reads it");
                            app.sarvam.say(&text)
                        }
                        r => r,
                    }
                } else {
                    app.sarvam.say(&text)
                }
            })
            .await??;
            json!({ "audio": audio, "type": "audio/mpeg" })
        }
        // Streaming reading aloud: open one per answer (connects at once), then a sentence at a time.
        // Audio arrives as `voice.audio` events; no "done" is waited for, so the card decides.
        "voice.streamOpen" => {
            if !app.sarvam_on() && !app.deepgram_on() {
                anyhow::bail!("Sarvam is off");
            }
            json!({ "stream": crate::speak_stream::open(app)? })
        }
        "voice.streamSay" => {
            if !app.sarvam_on() && !app.deepgram_on() {
                anyhow::bail!("Sarvam is off");
            }
            crate::speak_stream::say(app, s(p, "stream")?, s(p, "text")?).await?;
            json!({ "ok": true })
        }
        "voice.streamClose" => {
            crate::speak_stream::close(app, s(p, "stream")?);
            json!({ "ok": true })
        }
        // The app only, for tests: a WAV file through the same path as push-to-talk.
        "voice.transcribeFile" => {
            let file = s(p, "path")?.to_string();
            let app = app.clone();
            tokio::task::spawn_blocking(move || -> anyhow::Result<Value> {
                let (samples, rate) = crate::voice::read_wav(&std::fs::read(&file)?)?;
                let (text, note) = crate::voice::transcribe(&app, &samples, rate)?;
                Ok(json!({ "text": text, "note": note }))
            })
            .await??
        }
        "agents.list" => agent::list_agents().await,
        // Stops every chat that's working: its command's process group, the agent's turn, open cards.
        "agents.stopAll" => {
            let ids: Vec<String> = app.busy.lock().unwrap().iter().cloned().collect();
            for id in &ids {
                agent::cancel(app, id).await?;
            }
            json!({ "stopped": ids.len() })
        }
        "ledger.list" => json!(app.db(|d| d.ledger_list(200))?),
        "schedules.list" => json!(app.db(|d| d.schedules(None))?),
        "schedules.add" => json!(crate::schedule::add(app, p)?),
        "schedules.set" => {
            let id = p.get("id").and_then(Value::as_i64).ok_or_else(|| anyhow::anyhow!("missing \"id\""))?;
            let on = p.get("enabled").and_then(Value::as_bool).ok_or_else(|| anyhow::anyhow!("missing \"enabled\""))?;
            json!(crate::schedule::set(app, id, on)?)
        }
        "schedules.delete" => {
            let id = p.get("id").and_then(Value::as_i64).ok_or_else(|| anyhow::anyhow!("missing \"id\""))?;
            app.db(|d| d.schedule_delete(id))?;
            json!({ "ok": true })
        }
        "schedules.run" => {
            let id = p.get("id").and_then(Value::as_i64).ok_or_else(|| anyhow::anyhow!("missing \"id\""))?;
            let s = app.db(|d| d.schedule_get(id))?;
            crate::schedule::run(app, &s).await?
        }
        "fixes.list" => json!(app.db(|d| d.fixes(None))?),
        "fixes.add" => {
            let thread = p.get("threadId").and_then(Value::as_str);
            let text = |k: &str| p.get(k).and_then(Value::as_str);
            json!(crate::fixes::add(app, thread, text("failure").unwrap_or(""), text("detail"), s(p, "fix")?)?)
        }
        "fixes.set" => {
            let id = p.get("id").and_then(Value::as_i64).ok_or_else(|| anyhow::anyhow!("missing \"id\""))?;
            let on = p.get("enabled").and_then(Value::as_bool).ok_or_else(|| anyhow::anyhow!("missing \"enabled\""))?;
            app.db(|d| d.fix_set(id, on))?;
            json!({ "ok": true })
        }
        "fixes.delete" => {
            let id = p.get("id").and_then(Value::as_i64).ok_or_else(|| anyhow::anyhow!("missing \"id\""))?;
            app.db(|d| d.fix_delete(id))?;
            json!({ "ok": true })
        }
        "" => bail!("missing \"method\""),
        _ => bail!("unknown method \"{method}\""),
    })
}
