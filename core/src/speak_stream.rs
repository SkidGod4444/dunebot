//! Streaming text-to-speech: one WebSocket per answer. The card opens it as soon as an answer is on
//! its way, sends each sentence the moment it's complete, and plays the audio as it arrives: the first
//! sound comes ~0.3 s after a sentence instead of after the whole sentence has been made (1–3 s).
//! Audio goes out as `voice.audio` events (base64 16-bit mono PCM at the voice's rate), which the app
//! passes to the card only; nothing is kept or logged.
//!
//! Two voices: an English answer is read by Deepgram's American voice (deepgram.rs) when its key is
//! saved, anything else by Sarvam. The stream connects to the likelier one at once (from the language
//! you last spoke) and switches before the first sentence if the answer turns out otherwise. A later
//! sentence Deepgram can't read (an Indian language) is refused at once; the stream goes on reading
//! what it has, and the card reads that sentence and the rest whole (`voice.say`, which picks the
//! voice per sentence).
//!
//! Neither sends an end-of-speech message we wait for, so the card decides when it has heard
//! everything. A stream closes when the card says so, after a minute with nothing to do, or after
//! three minutes at most.

use crate::app::App;
use crate::deepgram::is_english;
use anyhow::{anyhow, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest, http::HeaderValue};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub const TTS_WS_URL: &str = "wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v4-flash";
pub const STREAM_RATE: u32 = 22050;
const IDLE: Duration = Duration::from_secs(60);
const MAX_LIFE: Duration = Duration::from_secs(180);
/// A card speaks one answer at a time; a couple more cover one being opened while another closes.
const MAX_STREAMS: usize = 3;

pub enum Cmd {
    /// A sentence, and the voice that reads this answer (the first sentence decided it).
    Say(String, Voice),
    /// You've just been heard: connect to this voice now if nothing has been read yet.
    Hint(Voice),
    Close,
}

/** An open stream: where its sentences go, and (from its first sentence on) whose voice reads it. */
pub struct Handle {
    tx: mpsc::UnboundedSender<Cmd>,
    voice: Option<Voice>,
    /// The language its first sentence was in (a Sarvam stream is set up for it).
    lang: &'static str,
}

impl Handle {
    pub fn close(self) {
        let _ = self.tx.send(Cmd::Close);
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Voice {
    Sarvam,
    Deepgram,
}

impl Voice {
    fn name(self) -> &'static str {
        match self {
            Voice::Sarvam => "Sarvam",
            Voice::Deepgram => "Deepgram",
        }
    }
}

/// Which voice reads `english` (or not) text, given the keys saved. None: nothing can.
pub fn choose(english: bool, deepgram: bool, sarvam: bool) -> Option<Voice> {
    match (english, deepgram, sarvam) {
        (true, true, _) => Some(Voice::Deepgram),
        (_, _, true) => Some(Voice::Sarvam),
        _ => None, // Hindi with only Deepgram, or no key at all
    }
}

/// The voice for this text, or (None) for an answer still to come: the language last spoken.
fn pick(app: &App, text: Option<&str>) -> Option<Voice> {
    let english = text.map(is_english).unwrap_or_else(|| app.sarvam.last_heard_english());
    choose(english, app.deepgram_on(), app.sarvam_on())
        // Not known yet and only one service saved: connect to that one.
        .or_else(|| if text.is_none() && app.deepgram_on() { Some(Voice::Deepgram) } else { None })
}

/// Opens a stream (connecting starts now, before there's anything to say). Returns its id.
pub fn open(app: &Arc<App>) -> anyhow::Result<String> {
    if pick(app, None).is_none() {
        bail!("no voice to read aloud with");
    }
    let id = crate::app::new_id();
    let (tx, rx) = mpsc::unbounded_channel();
    {
        let mut streams = app.sarvam.streams.lock().unwrap();
        streams.retain(|_, h| !h.tx.is_closed());
        if streams.len() >= MAX_STREAMS {
            bail!("too many voices at once");
        }
        streams.insert(id.clone(), Handle { tx, voice: None, lang: "" });
    }
    let (app, sid) = (app.clone(), id.clone());
    tokio::spawn(async move {
        let r = run(&app, &sid, rx).await;
        app.sarvam.streams.lock().unwrap().remove(&sid);
        let (state, message) = match r {
            Ok(()) => ("closed", Value::Null),
            Err(e) => {
                let mut m = format!("{e:#}");
                for key in [app.sarvam.key().ok(), app.deepgram.key().ok()].into_iter().flatten() {
                    m = crate::sarvam::scrub(&m, &key);
                }
                ("error", json!(m.chars().take(160).collect::<String>()))
            }
        };
        app.out.event("voice.stream", json!({ "stream": sid, "state": state, "message": message }));
    });
    Ok(id)
}

/// A sentence for the stream to read. The first one decides whose voice reads the answer; a later
/// one that voice can't read (Hindi after English, for Deepgram) is refused, and the card reads it
/// whole instead.
pub fn say(app: &Arc<App>, stream: &str, text: &str) -> anyhow::Result<()> {
    let text = text.trim();
    if text.is_empty() {
        bail!("nothing to read aloud");
    }
    if text.chars().count() > crate::sarvam::MAX_SAY_CHARS {
        bail!("too long to read aloud at once");
    }
    let want = pick(app, Some(text));
    let lang = app.sarvam.language_for(text);
    let mut streams = app.sarvam.streams.lock().unwrap();
    let h = streams.get_mut(stream).ok_or_else(|| anyhow!("that voice has stopped"))?;
    let voice = match h.voice {
        None => {
            h.lang = lang;
            *h.voice.insert(want.ok_or_else(|| anyhow!("no voice for that language"))?)
        }
        Some(Voice::Deepgram) if !is_english(text) => bail!("the American voice reads English only"),
        // English inside an answer in an Indian language is read by that answer's voice.
        Some(Voice::Sarvam) if lang != "en-IN" && !crate::sarvam::same_voice(h.lang, lang) => {
            bail!("this voice is set up for another language")
        }
        Some(v) => v,
    };
    h.tx.send(Cmd::Say(text.to_string(), voice)).map_err(|_| anyhow!("that voice has stopped"))
}

/// You've just been heard (Sarvam knows the language now): a stream that hasn't read anything yet
/// moves to the voice for that language while the answer is being written, not after its first
/// sentence (a reconnect then costs ~1.3 s).
pub fn hint(app: &App) {
    let Some(v) = pick(app, None) else { return };
    for h in app.sarvam.streams.lock().unwrap().values() {
        if h.voice.is_none() {
            let _ = h.tx.send(Cmd::Hint(v));
        }
    }
}

pub fn close(app: &Arc<App>, stream: &str) {
    if let Some(h) = app.sarvam.streams.lock().unwrap().remove(stream) {
        h.close();
    }
}

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn connect(app: &App, voice: Voice) -> anyhow::Result<Ws> {
    let (url, header, value) = match voice {
        Voice::Sarvam => (TTS_WS_URL, "api-subscription-key", app.sarvam.key()?),
        Voice::Deepgram => (crate::deepgram::WS_URL, "authorization", format!("Token {}", app.deepgram.key()?)),
    };
    let mut req = url.into_client_request()?;
    req.headers_mut().insert(header, HeaderValue::from_str(&value).map_err(|_| anyhow!("bad key"))?);
    let (ws, _) = tokio::time::timeout(Duration::from_secs(8), tokio_tungstenite::connect_async(req))
        .await
        .map_err(|_| anyhow!("{}'s voice didn't answer", voice.name()))?
        .map_err(|e| anyhow!("{}'s voice couldn't be reached ({e})", voice.name()))?;
    Ok(ws)
}

async fn run(app: &Arc<App>, id: &str, mut rx: mpsc::UnboundedReceiver<Cmd>) -> anyhow::Result<()> {
    let mut voice = pick(app, None).ok_or_else(|| anyhow!("no voice to read aloud with"))?;
    let mut ws = connect(app, voice).await?;
    app.out.event("voice.stream", json!({ "stream": id, "state": "open" }));
    let born = Instant::now();
    let mut started = false;
    let mut seq = 0u64;
    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(Cmd::Say(text, want)) => {
                    if !started {
                        // The answer's first sentence decided who reads it (say()).
                        if want != voice {
                            let _ = ws.close(None).await;
                            voice = want;
                            ws = connect(app, voice).await?;
                        }
                        eprintln!("dunebot-core: voice: {} reads this answer", voice.name());
                        if voice == Voice::Sarvam {
                            let config = json!({ "type": "config", "data": {
                                "speaker": crate::sarvam::speaker_for(app.sarvam.language_for(&text)),
                                "target_language_code": app.sarvam.language_for(&text),
                                "output_audio_codec": "linear16",
                                "speech_sample_rate": STREAM_RATE,
                                "min_buffer_size": 30,
                                "max_chunk_length": 200,
                            }});
                            ws.send(Message::text(config.to_string())).await?;
                        }
                        started = true;
                    }
                    match voice {
                        Voice::Sarvam => {
                            ws.send(Message::text(json!({ "type": "text", "data": { "text": text } }).to_string())).await?;
                            ws.send(Message::text(r#"{"type":"flush"}"#)).await?;
                        }
                        Voice::Deepgram => {
                            ws.send(Message::text(json!({ "type": "Speak", "text": text }).to_string())).await?;
                            ws.send(Message::text(r#"{"type":"Flush"}"#)).await?;
                        }
                    }
                }
                Some(Cmd::Hint(want)) => {
                    if !started && want != voice {
                        let _ = ws.close(None).await;
                        voice = want;
                        ws = connect(app, voice).await?;
                        eprintln!("dunebot-core: voice: ready with {} (the language you spoke)", voice.name());
                    }
                }
                Some(Cmd::Close) | None => {
                    if voice == Voice::Deepgram {
                        let _ = ws.send(Message::text(r#"{"type":"Close"}"#)).await;
                    }
                    let _ = ws.close(None).await;
                    return Ok(());
                }
            },
            msg = ws.next() => match msg {
                // Sarvam: JSON with base64 audio in it.
                Some(Ok(Message::Text(t))) if voice == Voice::Sarvam => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
                    match v.get("type").and_then(Value::as_str) {
                        Some("audio") => {
                            let audio = v.pointer("/data/audio").and_then(Value::as_str).unwrap_or("");
                            if audio.is_empty() || !audio.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=') {
                                continue;
                            }
                            seq += 1;
                            app.out.event("voice.audio", json!({ "stream": id, "seq": seq, "rate": STREAM_RATE, "audio": audio }));
                        }
                        Some("error") => {
                            let msg = v.pointer("/data/message").and_then(Value::as_str).unwrap_or("");
                            bail!("Sarvam said: {}", msg.chars().take(160).collect::<String>());
                        }
                        _ => {}
                    }
                }
                // Deepgram: the audio itself as binary frames; JSON only for metadata and warnings.
                Some(Ok(Message::Binary(b))) if voice == Voice::Deepgram => {
                    if b.is_empty() {
                        continue;
                    }
                    seq += 1;
                    let audio = crate::deepgram::base64(&b);
                    app.out.event("voice.audio", json!({ "stream": id, "seq": seq, "rate": crate::deepgram::STREAM_RATE, "audio": audio }));
                }
                Some(Ok(Message::Text(t))) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
                    if v.get("type").and_then(Value::as_str) == Some("Warning") {
                        let what = v.get("description").and_then(Value::as_str).unwrap_or("");
                        eprintln!("dunebot-core: voice: Deepgram warns: {}", what.chars().take(160).collect::<String>());
                    }
                }
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Ok(_)) => {}
                Some(Err(e)) => bail!("{}'s voice stopped ({e})", voice.name()),
            },
            _ = tokio::time::sleep(IDLE) => {
                let _ = ws.close(None).await;
                return Ok(());
            }
        }
        if born.elapsed() > MAX_LIFE {
            let _ = ws.close(None).await;
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn who_reads() {
        // English: Deepgram's American voice when its key is saved, else Sarvam.
        assert_eq!(choose(true, true, true), Some(Voice::Deepgram));
        assert_eq!(choose(true, true, false), Some(Voice::Deepgram));
        assert_eq!(choose(true, false, true), Some(Voice::Sarvam));
        // Hindi (and other Indian languages): Sarvam only.
        assert_eq!(choose(false, true, true), Some(Voice::Sarvam));
        assert_eq!(choose(false, true, false), None);
        assert_eq!(choose(true, false, false), None);
    }
}
