//! Deepgram's American English voice (Aura-2 "Thalia", `aura-2-thalia-en`), with the user's own key: English answers are
//! read aloud by it, answers in Hindi and other Indian languages by Sarvam (sarvam.rs). Streaming is
//! in speak_stream.rs; this keeps the key and reads a sentence whole (the fallback). The key is handed
//! over by the app on stdin: never an environment variable, a command line, a reply or a log line.

use crate::sarvam::{MAX_SAY_CHARS, scrub};
use anyhow::{anyhow, bail};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::Duration;

pub const STREAM_RATE: u32 = 24000;
pub const WS_URL: &str = "wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=24000";
const REST_URL: &str = "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3";

#[derive(Default)]
pub struct Deepgram {
    key: Mutex<Option<String>>,
}

impl Deepgram {
    /// The app hands the key over (or takes it back with None).
    pub fn set_key(&self, key: Option<String>) -> anyhow::Result<()> {
        let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        if let Some(k) = &key {
            if !(20..=200).contains(&k.len()) || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                bail!("that doesn't look like a Deepgram key");
            }
        }
        *self.key.lock().unwrap() = key;
        Ok(())
    }

    pub fn has_key(&self) -> bool {
        self.key.lock().unwrap().is_some()
    }

    pub(crate) fn key(&self) -> anyhow::Result<String> {
        self.key.lock().unwrap().clone().ok_or_else(|| anyhow!("no Deepgram key"))
    }

    /// Speech for `text` (one sentence or a few), whole: base64 MP3.
    pub fn say(&self, text: &str) -> anyhow::Result<String> {
        let key = self.key()?;
        let text = text.trim();
        if text.is_empty() {
            bail!("nothing to read aloud");
        }
        if text.chars().count() > MAX_SAY_CHARS {
            bail!("too long to read aloud at once");
        }
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(20)))
            .http_status_as_error(false)
            .build()
            .into();
        let mut resp = agent
            .post(REST_URL)
            .header("authorization", &format!("Token {key}"))
            .header("content-type", "application/json")
            .send(&serde_json::to_vec(&json!({ "text": text }))?[..])
            .map_err(|e| anyhow!("Deepgram couldn't be reached ({})", scrub(&e.to_string(), &key)))?;
        let status = resp.status().as_u16();
        if status != 200 {
            let body = resp.body_mut().with_config().limit(64 << 10).read_to_string().unwrap_or_default();
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let msg = ["/err_msg", "/message", "/error"].iter().find_map(|p| v.pointer(p).and_then(Value::as_str)).unwrap_or("");
            let msg: String = scrub(msg, &key).chars().take(160).collect();
            bail!("Deepgram said {status}{}", if msg.is_empty() { String::new() } else { format!(": {msg}") });
        }
        let audio = resp.body_mut().with_config().limit(8 << 20).read_to_vec()?;
        if audio.len() < 64 {
            bail!("Deepgram sent no audio");
        }
        Ok(base64(&audio))
    }
}

/// English, which Deepgram's American voice reads: no Indian script, and not Hindi written in Latin
/// letters (Hinglish). Anything else goes to Sarvam.
pub fn is_english(text: &str) -> bool {
    !text.chars().any(|c| ('\u{0900}'..='\u{0DFF}').contains(&c)) && !crate::sarvam::hinglish(text)
}

/// Standard base64 (with padding).
pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_or_not() {
        assert!(is_english("Your downloads folder has twelve files."));
        assert!(is_english("I'm Dune Bot — 17 × 23 = 391."));
        assert!(!is_english("आपके फ़ोल्डर में 12 फ़ाइलें हैं।"));
        assert!(!is_english("Downloads में 960 files हैं।"));
        assert!(!is_english("உங்கள் கோப்புகள்")); // Tamil
        assert!(!is_english("Indradhanush tab banta hai jab sooraj ki roshni paani mein jaati hai."));
    }

    #[test]
    fn base64_matches() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0, 255, 254, 1]), "AP/+AQ==");
    }

    #[test]
    fn keys() {
        let d = Deepgram::default();
        assert!(d.set_key(Some("short".into())).is_err());
        assert!(d.set_key(Some("has spaces in it but is long enough".into())).is_err());
        assert!(d.set_key(Some("0123456789abcdef0123456789abcdef01234567".into())).is_ok());
        assert!(d.has_key());
        d.set_key(None).unwrap();
        assert!(!d.has_key());
    }
}
