#![cfg_attr(not(feature = "voice"), allow(dead_code))]
//! Sarvam AI voice (the user's own key): what you say becomes text with `saaras:v4`, and answers are
//! read aloud with `bulbul:v4-flash`. Used only while a key is saved and Settings › Voice says Sarvam.
//!
//! What leaves this computer: the recording of what you said after you let go (only when it has
//! speech in it; silence and a blocked mic never go), and the words of an answer to be read aloud.
//! Nothing is saved, here or in the log. The key is handed over by the app (Electron keeps it locked
//! with the system's keychain) and lives only in this process's memory: never in a file, an
//! environment variable an agent could inherit, a command line or the log.

use anyhow::{anyhow, bail};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::Duration;

pub const STT_URL: &str = "https://api.sarvam.ai/speech-to-text";
pub const TTS_URL: &str = "https://api.sarvam.ai/text-to-speech";
pub const STT_MODEL: &str = "saaras:v4";
pub const TTS_MODEL: &str = "bulbul:v4-flash";
/// An English-Hindi voice: reads English, Hindi and the two mixed.
/// Sarvam takes up to 30 s per request; longer recordings go in parts, cut where it's quietest.
pub const MAX_PART_SECS: f32 = 29.0;
/// The most one request may ask to read aloud (pages send a sentence at a time, ~360 characters a reply).
pub const MAX_SAY_CHARS: usize = 500;
/// Words Sarvam should expect (its spelling of them wins).
const KEYTERMS: &str = r#"["Dune Bot","Claude","Codex"]"#;

#[derive(Default)]
pub struct Sarvam {
    key: Mutex<Option<String>>,
    /// Streaming voices that are open (speak_stream.rs), by id.
    pub streams: Mutex<std::collections::HashMap<String, crate::speak_stream::Handle>>,
    /// The language Sarvam last heard you speak ("en-IN", "hi-IN", …): which voice to connect to
    /// before an answer's first sentence says (speak_stream.rs).
    heard: Mutex<String>,
}

impl Sarvam {
    /// The app hands the key over (or takes it back with None).
    pub fn set_key(&self, key: Option<String>) -> anyhow::Result<()> {
        let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        if let Some(k) = &key {
            if k.len() > 200 || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                bail!("that doesn't look like a Sarvam key");
            }
        }
        if key.is_none() {
            for (_, h) in self.streams.lock().unwrap().drain() {
                h.close();
            }
        }
        *self.key.lock().unwrap() = key;
        Ok(())
    }

    pub fn has_key(&self) -> bool {
        self.key.lock().unwrap().is_some()
    }

    /// Whether you last spoke English (or haven't spoken yet).
    pub fn last_heard_english(&self) -> bool {
        let heard = self.heard.lock().unwrap();
        heard.is_empty() || heard.starts_with("en")
    }

    /// The language to read `text` in: from its script, and for Devanagari, Marathi if that's what
    /// you last spoke (Hindi otherwise).
    pub fn language_for(&self, text: &str) -> &'static str {
        language_of(text, &self.heard.lock().unwrap())
    }

    pub(crate) fn key(&self) -> anyhow::Result<String> {
        self.key.lock().unwrap().clone().ok_or_else(|| anyhow!("no Sarvam key"))
    }

    /// Text for 16 kHz mono audio. Returns the text and the language Sarvam heard.
    pub fn transcribe(&self, audio: &[f32]) -> anyhow::Result<(String, String)> {
        let key = self.key()?;
        let mut text = Vec::new();
        let mut lang = String::new();
        for (a, b) in parts(audio, crate::voice::RATE, MAX_PART_SECS) {
            let boundary = format!("dunebot{}", crate::app::new_id());
            let wav = wav_pcm16(&audio[a..b], crate::voice::RATE);
            let fields = [("model", STT_MODEL), ("mode", "codemix"), ("language_code", "unknown"), ("keyterms", KEYTERMS)];
            let body = multipart(&boundary, &fields, "speech.wav", "audio/wav", &wav);
            let reply = post(&key, STT_URL, &format!("multipart/form-data; boundary={boundary}"), body)?;
            let part = reply.get("transcript").and_then(Value::as_str).unwrap_or("").trim().to_string();
            if lang.is_empty() {
                lang = reply.get("language_code").and_then(Value::as_str).unwrap_or("").to_string();
            }
            if !part.is_empty() {
                text.push(part);
            }
        }
        if !lang.is_empty() {
            *self.heard.lock().unwrap() = lang.clone();
        }
        Ok((text.join(" "), lang))
    }

    /// Speech for `text` (one sentence or a few): base64 MP3.
    pub fn say(&self, text: &str) -> anyhow::Result<String> {
        let key = self.key()?;
        let text = text.trim();
        if text.is_empty() {
            bail!("nothing to read aloud");
        }
        if text.chars().count() > MAX_SAY_CHARS {
            bail!("too long to read aloud at once");
        }
        let body = json!({
            "text": text,
            "target_language_code": self.language_for(text),
            "speaker": speaker_for(self.language_for(text)),
            "model": TTS_MODEL,
            "speech_sample_rate": 22050,
            "output_audio_codec": "mp3",
        });
        let reply = post(&key, TTS_URL, "application/json", serde_json::to_vec(&body)?)?;
        let audio = reply.pointer("/audios/0").and_then(Value::as_str).unwrap_or("");
        if audio.is_empty() || !audio.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=') {
            bail!("Sarvam sent no audio");
        }
        Ok(audio.to_string())
    }
}

/// Sends one request; an error says the status and Sarvam's message, never the key.
fn post(key: &str, url: &str, content_type: &str, body: Vec<u8>) -> anyhow::Result<Value> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut resp = agent
        .post(url)
        .header("api-subscription-key", key)
        .header("content-type", content_type)
        .send(&body[..])
        .map_err(|e| anyhow!("Sarvam couldn't be reached ({})", scrub(&e.to_string(), key)))?;
    let status = resp.status().as_u16();
    let text = resp.body_mut().with_config().limit(16 << 20).read_to_string().unwrap_or_default();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status != 200 {
        let msg = v.pointer("/error/message").and_then(Value::as_str).unwrap_or("");
        let msg: String = scrub(msg, key).chars().take(160).collect();
        bail!("Sarvam said {status}{}", if msg.is_empty() { String::new() } else { format!(": {msg}") });
    }
    Ok(v)
}

pub(crate) fn scrub(s: &str, key: &str) -> String {
    if key.len() >= 8 { s.replace(key, "…") } else { s.to_string() }
}

/// en-IN, or hi-IN when the words are in Devanagari (the voice reads both, and the two mixed).
/// The language of `text` from its script (the first Indian script in it; English if none). Devanagari
/// is Hindi unless you last spoke Marathi (`heard`, Sarvam's code for it).
pub fn language_of(text: &str, heard: &str) -> &'static str {
    for c in text.chars() {
        let lang = match c {
            '\u{0900}'..='\u{097F}' => if heard.starts_with("mr") { "mr-IN" } else { "hi-IN" },
            '\u{0980}'..='\u{09FF}' => "bn-IN",
            '\u{0A00}'..='\u{0A7F}' => "pa-IN",
            '\u{0A80}'..='\u{0AFF}' => "gu-IN",
            '\u{0B00}'..='\u{0B7F}' => "od-IN",
            '\u{0B80}'..='\u{0BFF}' => "ta-IN",
            '\u{0C00}'..='\u{0C7F}' => "te-IN",
            '\u{0C80}'..='\u{0CFF}' => "kn-IN",
            '\u{0D00}'..='\u{0D7F}' => "ml-IN",
            _ => continue,
        };
        return lang;
    }
    // Hindi written in Latin letters ("Rainbow tab banta hai…"): Sarvam's English-Hindi voice reads it
    // as Hindi (checked by listening back), an American voice wouldn't.
    if hinglish(text) { "hi-IN" } else { "en-IN" }
}

/// Words that mean Hindi when written in Latin letters and hardly ever appear in English.
const HINGLISH: &[&str] = &[
    "hai", "hain", "nahi", "nahin", "kya", "kyun", "kyon", "kaise", "kaisa", "kaisi", "mein", "aur", "bhi", "yeh", "woh",
    "aap", "aapka", "aapki", "aapke", "tum", "tumhara", "hamara", "mera", "meri", "mere", "tera", "teri", "apna", "apni",
    "abhi", "kuch", "bahut", "accha", "achha", "theek", "thik", "haan", "karo", "karna", "karte", "karta", "karti",
    "raha", "rahi", "rahe", "sakte", "sakta", "sakti", "chahiye", "banta", "batao", "bataiye", "dekho", "dekhiye",
    "jaata", "jaati", "wala", "wali", "wale", "lekin", "kyunki", "toh", "matlab", "sirf", "zyada", "jaise", "yahan",
    "wahan", "kahan", "kaun", "kitna", "kitne", "paani", "hawa", "ki", "ke", "ka", "ko", "se",
];

/// Hindi in Latin letters: two or more different Hindi words, and no Indian script.
pub fn hinglish(text: &str) -> bool {
    let mut found: Vec<String> = Vec::new();
    for w in text.split(|c: char| !c.is_alphanumeric()) {
        let w = w.to_lowercase();
        if HINGLISH.contains(&w.as_str()) && !found.contains(&w) {
            found.push(w);
        }
    }
    found.len() >= 2
}

/// Sarvam's voice for each language: a native woman's voice where bulbul:v4-flash has one, else the
/// English-Hindi one (Simran; Tamil's native voices are all men's, Malayalam has none). Odia uses the
/// Bengali voice: Simran read it unusually slowly. Each was checked by reading a sentence and listening
/// to it again with Sarvam (2026-11-16: every language heard back word for word), not by ear.
pub fn speaker_for(lang: &str) -> &'static str {
    match lang {
        "bn-IN" | "od-IN" => "roopa_bn_conversational",
        "te-IN" => "kavitha_te_conversation",
        "gu-IN" => "pooja_gu_conversational",
        "kn-IN" => "chaitra_kn_conversation",
        "mr-IN" => "ishita_mr_conversational",
        "pa-IN" => "harpreet_pa_narration",
        _ => "simran_enhi_companion", // English, Hindi, Tamil, Malayalam
    }
}

/// Whether one Sarvam stream set up for `a` can also read a sentence in `b`: the same language, or
/// English and Hindi (one voice reads both, mixed too).
pub fn same_voice(a: &str, b: &str) -> bool {
    a == b || (matches!(a, "en-IN" | "hi-IN") && matches!(b, "en-IN" | "hi-IN"))
}

/// Where to cut audio into parts of at most `max_secs`: at the quietest 100 ms in the last third of
/// each part, so a word is rarely split. Short audio is one part.
pub fn parts(s: &[f32], rate: u32, max_secs: f32) -> Vec<(usize, usize)> {
    let max = (max_secs * rate as f32) as usize;
    let min = max * 2 / 3;
    let frame = (rate as usize / 10).max(1);
    let mut out = Vec::new();
    let mut start = 0;
    while s.len() - start > max {
        let mut best = start + max;
        let mut quietest = f32::MAX;
        let mut i = start + min;
        while i + frame <= start + max {
            let e: f32 = s[i..i + frame].iter().map(|x| x * x).sum();
            if e < quietest {
                quietest = e;
                best = i + frame / 2;
            }
            i += frame / 2;
        }
        out.push((start, best));
        start = best;
    }
    out.push((start, s.len()));
    out
}

/// 16-bit PCM WAV, mono.
pub fn wav_pcm16(s: &[f32], rate: u32) -> Vec<u8> {
    let data = (s.len() * 2) as u32;
    let mut w = Vec::with_capacity(44 + data as usize);
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); // PCM
    w.extend_from_slice(&1u16.to_le_bytes()); // mono
    w.extend_from_slice(&rate.to_le_bytes());
    w.extend_from_slice(&(rate * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&data.to_le_bytes());
    for x in s {
        w.extend_from_slice(&((x.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
    }
    w
}

/// A multipart/form-data body: text fields, then one file.
pub fn multipart(boundary: &str, fields: &[(&str, &str)], file_name: &str, file_type: &str, file: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(file.len() + 512);
    for (k, v) in fields {
        b.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").as_bytes());
    }
    b.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: {file_type}\r\n\r\n").as_bytes());
    b.extend_from_slice(file);
    b.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_round_trips_through_the_reader() {
        let s: Vec<f32> = (0..1600).map(|i| (i as f32 / 20.0).sin() * 0.5).collect();
        let (back, rate) = crate::voice::read_wav(&wav_pcm16(&s, 16_000)).unwrap();
        assert_eq!(rate, 16_000);
        assert_eq!(back.len(), s.len());
        assert!(back.iter().zip(&s).all(|(a, b)| (a - b).abs() < 1e-3));
    }

    #[test]
    fn long_audio_is_cut_at_the_quiet_part() {
        let rate = 16_000;
        // 50 s of tone with a quiet second at 24-25 s: one cut there, both parts at most 29 s.
        let s: Vec<f32> = (0..50 * rate).map(|i| if (24 * rate..25 * rate).contains(&i) { 0.0 } else { (i as f32 / 7.0).sin() * 0.3 }).collect();
        let p = parts(&s, rate as u32, MAX_PART_SECS);
        assert_eq!(p.len(), 2);
        assert!((24 * rate..25 * rate).contains(&p[0].1), "cut at {}", p[0].1);
        assert_eq!(p[0].1, p[1].0);
        assert_eq!(p[1].1, s.len());
        assert!(p.iter().all(|(a, b)| b - a <= (MAX_PART_SECS * rate as f32) as usize));
        assert_eq!(parts(&s[..10 * rate], rate as u32, MAX_PART_SECS), vec![(0, 10 * rate)]);
        // 60 s (the recording limit): three parts at most, none over the limit, nothing lost.
        let s: Vec<f32> = (0..60 * rate).map(|i| (i as f32 / 5.0).sin()).collect();
        let p = parts(&s, rate as u32, MAX_PART_SECS);
        assert!(p.len() <= 3 && p.last().unwrap().1 == s.len());
        assert!(p.windows(2).all(|w| w[0].1 == w[1].0));
    }

    #[test]
    fn multipart_has_fields_then_file() {
        let b = multipart("XyZ", &[("model", "saaras:v4"), ("mode", "codemix")], "a.wav", "audio/wav", b"RIFF1234");
        let s = String::from_utf8_lossy(&b);
        assert!(s.starts_with("--XyZ\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nsaaras:v4\r\n--XyZ\r\n"));
        assert!(s.contains("name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF1234\r\n--XyZ--\r\n"));
    }

    #[test]
    fn keys_and_languages() {
        let s = Sarvam::default();
        assert!(s.set_key(Some("sk_abc 123".into())).is_err());
        assert!(s.set_key(Some("x".repeat(201))).is_err());
        assert!(!s.has_key());
        s.set_key(Some(" sk_test_ABC-123 ".into())).unwrap();
        assert!(s.has_key());
        s.set_key(None).unwrap();
        assert!(!s.has_key() && s.say("hi").is_err());
        assert_eq!(language_of("Found 12 files.", ""), "en-IN");
        assert_eq!(language_of("मेरा laptop slow है", ""), "hi-IN");
        assert_eq!(language_of("आज हवामान खूप छान आहे.", "mr-IN"), "mr-IN");
        assert_eq!(language_of("आज मौसम अच्छा है।", "en-IN"), "hi-IN");
        assert_eq!(language_of("Downloads-ல் 12 கோப்புகள் உள்ளன.", ""), "ta-IN");
        assert_eq!(language_of("আজ আবহাওয়া খুব সুন্দর।", ""), "bn-IN");
        assert_eq!(language_of("ଆଜି ପାଣିପାଗ ବହୁତ ଭଲ ଅଛି।", ""), "od-IN");
        assert_eq!(language_of("ਅੱਜ ਮੌਸਮ ਬਹੁਤ ਵਧੀਆ ਹੈ।", ""), "pa-IN");
        assert_eq!(language_of("આજે હવામાન ખૂબ સરસ છે.", ""), "gu-IN");
        assert_eq!(language_of("ఈ రోజు వాతావరణం చాలా బాగుంది.", ""), "te-IN");
        assert_eq!(language_of("ಇಂದು ಹವಾಮಾನ ತುಂಬಾ ಚೆನ್ನಾಗಿದೆ.", ""), "kn-IN");
        assert_eq!(language_of("ഇന്ന് കാലാവസ്ഥ വളരെ നല്ലതാണ്.", ""), "ml-IN");
        assert!(same_voice("hi-IN", "en-IN") && same_voice("ta-IN", "ta-IN"));
        // Hinglish in Latin letters is Hindi; English isn't, even with the odd word that looks Hindi.
        assert_eq!(language_of("Rainbow tab banta hai jab sunlight hawa mein maujood hai.", ""), "hi-IN");
        assert_eq!(language_of("Haan, main check kar sakta hoon.", ""), "hi-IN");
        for english in [
            "Your Downloads folder has 12 files, and the biggest one is a video.",
            "Open a new tab and paste the key there.",
            "I'm Dune Bot, made to help with your files and apps.",
            "The agar plate is in the fridge; ask Ki if you need it.",
            "Kaizen means small changes, so start with one.",
        ] {
            assert_eq!(language_of(english, ""), "en-IN", "{english}");
        }
        assert!(!same_voice("hi-IN", "ta-IN") && !same_voice("en-IN", "bn-IN"));
        assert_eq!(scrub("bad key sk_live_1234567 here", "sk_live_1234567"), "bad key … here");
    }
}
