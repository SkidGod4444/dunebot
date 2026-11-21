//! Push-to-talk. While you hold the chord (or the bar's mic button) the default microphone is
//! recorded into memory; on release the audio is turned into text. With a Sarvam key saved (and
//! Settings › Voice on Sarvam) it goes to Sarvam AI (sarvam.rs); otherwise, or if Sarvam doesn't
//! answer, it's turned into text on this computer with whisper.cpp (English; the model is downloaded
//! once). Audio is never saved, and silence or a blocked mic is never sent anywhere.

use std::time::Duration;

pub const MODEL_FILE: &str = "ggml-small.en-q5_1.bin";
pub const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin";
pub const MODEL_SHA256: &str = "bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30";
pub const MODEL_BYTES: u64 = 190_098_681;
/// A recording stops by itself after this (in case a key release is missed).
pub const MAX_RECORDING: Duration = Duration::from_secs(60);
pub const RATE: u32 = 16_000;

/// Interleaved frames to one channel.
pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved.chunks(channels).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect()
}

/// Resamples one channel to `to` Hz: a windowed-sinc low-pass (when going down), then linear
/// interpolation. Plenty for speech recognition.
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let filtered = if to < from {
        let cutoff = 0.45 * to as f32 / from as f32; // fraction of the input rate
        let half = 24i32;
        let taps: Vec<f32> = (-half..=half)
            .map(|n| {
                let x = n as f32;
                let sinc = if n == 0 { 2.0 * cutoff } else { (2.0 * std::f32::consts::PI * cutoff * x).sin() / (std::f32::consts::PI * x) };
                let w = 0.42 + 0.5 * (std::f32::consts::PI * x / half as f32).cos() + 0.08 * (2.0 * std::f32::consts::PI * x / half as f32).cos();
                sinc * w
            })
            .collect();
        let sum: f32 = taps.iter().sum();
        (0..input.len() as i32)
            .map(|i| {
                taps.iter()
                    .enumerate()
                    .map(|(k, t)| {
                        let j = i + k as i32 - half;
                        if j < 0 || j >= input.len() as i32 { 0.0 } else { input[j as usize] * t }
                    })
                    .sum::<f32>()
                    / sum
            })
            .collect::<Vec<f32>>()
    } else {
        input.to_vec()
    };
    let ratio = from as f64 / to as f64;
    let n = ((filtered.len() as f64) / ratio).floor() as usize;
    (0..n)
        .map(|i| {
            let pos = i as f64 * ratio;
            let j = pos.floor() as usize;
            let frac = (pos - j as f64) as f32;
            let a = filtered[j];
            let b = *filtered.get(j + 1).unwrap_or(&a);
            a + (b - a) * frac
        })
        .collect()
}

#[derive(Debug, PartialEq)]
pub enum Heard {
    Speech,
    /// The microphone gave only zeros: macOS (or the OS) is blocking it.
    Blocked,
    Silence,
    TooShort,
}

/// Whisper invents words for silence ("Thank you."), so only audio with enough loud-enough
/// 30 ms frames goes to it. Expects 16 kHz mono.
pub fn check_speech(s: &[f32]) -> Heard {
    if s.len() < (RATE as usize) * 4 / 10 {
        return Heard::TooShort;
    }
    if s.iter().all(|x| *x == 0.0) {
        return Heard::Blocked;
    }
    let frame = (RATE as usize) * 3 / 100;
    let rms: Vec<f32> = s.chunks(frame).map(|c| (c.iter().map(|x| x * x).sum::<f32>() / c.len() as f32).sqrt()).collect();
    let mut sorted = rms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let floor = sorted[sorted.len() / 10];
    let threshold = (floor * 4.0).max(0.006);
    let loud = rms.iter().filter(|r| **r > threshold).count();
    if loud * frame >= (RATE as usize) * 25 / 100 { Heard::Speech } else { Heard::Silence }
}

/// Tidies whisper output: drops "[BLANK_AUDIO]", "(music)" and the like, joins whitespace.
pub fn clean(text: &str) -> String {
    let mut out = String::new();
    let mut depth = 0i32;
    for ch in text.chars() {
        match ch {
            '[' | '(' => depth += 1,
            ']' | ')' => depth = (depth - 1).max(0),
            _ if depth > 0 => {}
            _ => out.push(ch),
        }
    }
    let joined = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().any(char::is_alphanumeric) { joined } else { String::new() }
}

/// Reads a 16-bit PCM or 32-bit float WAV file to mono samples and their rate (for tests).
pub fn read_wav(bytes: &[u8]) -> anyhow::Result<(Vec<f32>, u32)> {
    anyhow::ensure!(bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE", "not a WAV file");
    let (mut fmt, mut channels, mut rate, mut bits) = (0u16, 0usize, 0u32, 0u16);
    let mut i = 12;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let len = u32::from_le_bytes(bytes[i + 4..i + 8].try_into()?) as usize;
        let body = &bytes[i + 8..(i + 8 + len).min(bytes.len())];
        if id == b"fmt " {
            fmt = u16::from_le_bytes(body[0..2].try_into()?);
            channels = u16::from_le_bytes(body[2..4].try_into()?) as usize;
            rate = u32::from_le_bytes(body[4..8].try_into()?);
            bits = u16::from_le_bytes(body[14..16].try_into()?);
        } else if id == b"data" {
            let interleaved: Vec<f32> = match (fmt, bits) {
                (1, 16) => body.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect(),
                (3, 32) => body.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect(),
                _ => anyhow::bail!("unsupported WAV format {fmt}/{bits}-bit"),
            };
            return Ok((to_mono(&interleaved, channels), rate));
        }
        i += 8 + len + (len & 1);
    }
    anyhow::bail!("no audio in the WAV file")
}

#[cfg(feature = "voice")]
pub use engine::*;

#[cfg(feature = "voice")]
mod engine {
    use super::*;
    use crate::app::App;
    use anyhow::{anyhow, bail};
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::{Arc, Mutex, mpsc};
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

    #[derive(Default)]
    pub struct Voice {
        rec: Mutex<Option<Recording>>,
        model: Mutex<Option<Arc<WhisperContext>>>,
        downloading: AtomicBool,
        progress: AtomicU8,
    }

    struct Recording {
        stop: mpsc::Sender<()>,
        done: mpsc::Receiver<Result<(Vec<f32>, u32), String>>,
        source: String,
    }

    pub(super) fn model_path(app: &App) -> PathBuf {
        app.data_dir.join("models").join(MODEL_FILE)
    }

    pub fn status(app: &App) -> serde_json::Value {
        let v = &app.voice;
        let sarvam = app.sarvam_on();
        json!({
            "available": true,
            "ready": model_path(app).exists(),
            "downloading": v.downloading.load(Ordering::SeqCst),
            "progress": v.progress.load(Ordering::SeqCst),
            "recording": v.rec.lock().unwrap().is_some(),
            "engine": if sarvam { "sarvam" } else { "local" },
            "language": if sarvam { "Indian languages and English" } else { "English" },
        })
    }

    fn state(app: &App, state: &str, extra: serde_json::Value) {
        let mut v = json!({ "state": state });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            o.extend(e.clone());
        }
        app.out.event("voice.state", v);
    }

    /// Starts getting the speech model if it isn't here yet (setup does this up front).
    pub fn prepare(app: &Arc<App>) -> serde_json::Value {
        if !model_path(app).exists() {
            download(app.clone());
        }
        status(app)
    }

    /// Setup's check: opens the mic for about a second and reports whether any sound reached us.
    /// A mic blocked by the system delivers exact zeros; a quiet room still has a little noise.
    pub fn test(app: &Arc<App>) -> anyhow::Result<serde_json::Value> {
        if app.voice.rec.lock().unwrap().is_some() {
            bail!("the microphone is in use");
        }
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ok_tx, ok_rx) = mpsc::channel();
        let app2 = app.clone();
        let mic = std::thread::Builder::new().name("dunebot-mic-test".into()).spawn(move || record(&app2, stop_rx, ok_tx))?;
        match ok_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => bail!(e),
            Err(_) => bail!("the microphone didn't open within 5 s"),
        }
        std::thread::sleep(Duration::from_millis(1200));
        let _ = stop_tx.send(());
        let (samples, _, _) = mic.join().map_err(|_| anyhow!("the microphone check crashed"))?.map_err(|e| anyhow!(e))?;
        let peak = samples.iter().fold(0f32, |m, x| m.max(x.abs()));
        Ok(json!({ "heard": peak > 0.0, "peak": peak, "samples": samples.len() }))
    }

    /// This computer's model is what will listen: no Sarvam key, and none on its way (the app hands
    /// the keys over while the mic already records, sarvam.rs).
    pub(super) fn listens_here(app: &App) -> bool {
        !app.sarvam_may_listen()
    }

    fn getting_ready(app: &App) -> String {
        format!("Getting voice ready: downloading the English speech model (190 MB, one time). {}% so far.", app.voice.progress.load(Ordering::SeqCst))
    }

    /// Starts recording. Without Sarvam, if the speech model isn't on this computer yet, starts
    /// getting it instead. A Sarvam key still being unlocked counts as Sarvam: the first hold after
    /// launch records (with the model missing it used to start the download and fail, 2026-11-21).
    pub fn start(app: &Arc<App>, source: &str) -> anyhow::Result<()> {
        if listens_here(app) && !model_path(app).exists() {
            download(app.clone());
            bail!("{}", getting_ready(app));
        }
        let mut rec = app.voice.rec.lock().unwrap();
        if let Some(r) = rec.as_mut() {
            // A hold to talk (or the mic button) takes over a dictation's recording (dictation.rs).
            if crate::dictation::takes_over(&r.source, source) {
                r.source = source.to_string();
            }
            return Ok(());
        }
        let (stop_tx, stop_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let (ok_tx, ok_rx) = mpsc::channel();
        let app2 = app.clone();
        let rt = tokio::runtime::Handle::current();
        std::thread::Builder::new().name("dunebot-mic".into()).spawn(move || {
            let r = record(&app2, stop_rx, ok_tx);
            let hit_limit = matches!(r, Ok((_, _, true)));
            let _ = done_tx.send(r.map(|(s, rate, _)| (s, rate)));
            if hit_limit {
                let app3 = app2.clone();
                rt.spawn(async move { stop(&app3) });
            }
        })?;
        // Wait until the microphone is open (or failed) so errors reach the caller.
        match ok_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => bail!(e),
            Err(_) => bail!("the microphone didn't open within 5 s"),
        }
        *rec = Some(Recording { stop: stop_tx, done: done_rx, source: source.to_string() });
        drop(rec);
        state(app, "listening", json!({ "source": source }));
        // Load the model while you talk, so the text is ready sooner (not when Sarvam will listen).
        if listens_here(app) {
            let app3 = app.clone();
            tokio::task::spawn_blocking(move || {
                let _ = model(&app3);
            });
        }
        Ok(())
    }

    /// Gets the microphone ready without starting it, once (the desktop app asks at launch, when
    /// the mic is already allowed). The first open after launch took 2.0 and 2.3 s on a Mac
    /// (2026-11-21), longer than a short hold: the start of what was said, or all of it, was lost.
    /// The stream is built and dropped, never started: nothing is heard, no mic light (cpal 0.18
    /// on macOS only initializes the audio unit when building; it starts on `play()`).
    /// macOS only: elsewhere building may already open a capture stream (Linux PipeWire shows its
    /// mic icon for one), and no slow first open was seen there.
    pub fn warm() {
        if !cfg!(target_os = "macos") {
            return;
        }
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let _ = std::thread::Builder::new().name("dunebot-mic-ready".into()).spawn(|| {
                let t0 = std::time::Instant::now();
                let r = (|| -> Result<Duration, String> {
                    let device = cpal::default_host().default_input_device().ok_or("no microphone found")?;
                    let config = device.default_input_config().map_err(|e| e.to_string())?;
                    let found = t0.elapsed();
                    let err = |e: cpal::Error| eprintln!("dunebot-core: microphone: {e}");
                    let stream = match config.sample_format() {
                        cpal::SampleFormat::F32 => device.build_input_stream::<f32, _, _>(config.into(), |_, _| {}, err, None),
                        cpal::SampleFormat::I16 => device.build_input_stream::<i16, _, _>(config.into(), |_, _| {}, err, None),
                        cpal::SampleFormat::I32 => device.build_input_stream::<i32, _, _>(config.into(), |_, _| {}, err, None),
                        other => return Err(format!("unsupported format {other:?}")),
                    }
                    .map_err(|e| e.to_string())?;
                    drop(stream); // never started
                    Ok(found)
                })();
                match r {
                    Ok(found) => eprintln!(
                        "dunebot-core: microphone: made ready in {} ms (finding it {}, building {}); not started, nothing heard",
                        t0.elapsed().as_millis(),
                        found.as_millis(),
                        (t0.elapsed() - found).as_millis()
                    ),
                    Err(e) => eprintln!("dunebot-core: microphone: couldn't make it ready ({e})"),
                }
            });
        });
    }

    /// Records until told to stop or MAX_RECORDING. Returns mono samples, their rate, and whether
    /// it stopped at the limit.
    fn record(app: &App, stop: mpsc::Receiver<()>, ok: mpsc::Sender<Result<(), String>>) -> Result<(Vec<f32>, u32, bool), String> {
        let t0 = std::time::Instant::now();
        let mut found = Duration::ZERO;
        let mut built = Duration::ZERO;
        let mut open = || -> Result<(cpal::Stream, Arc<Mutex<Vec<f32>>>, u32), String> {
            let host = cpal::default_host();
            let device = host.default_input_device().ok_or("no microphone found")?;
            let config = device.default_input_config().map_err(|e| format!("microphone: {e}"))?;
            found = t0.elapsed();
            let rate = config.sample_rate();
            let channels = config.channels() as usize;
            let buf = Arc::new(Mutex::new(Vec::<f32>::with_capacity(rate as usize * 10)));
            let err = |e: cpal::Error| eprintln!("dunebot-core: microphone: {e}");
            let stream = match config.sample_format() {
                cpal::SampleFormat::F32 => {
                    let b = buf.clone();
                    device.build_input_stream::<f32, _, _>(config.into(), move |d, _| b.lock().unwrap().extend(to_mono(d, channels)), err, None)
                }
                cpal::SampleFormat::I16 => {
                    let b = buf.clone();
                    device.build_input_stream::<i16, _, _>(
                        config.into(),
                        move |d, _| {
                            let f: Vec<f32> = d.iter().map(|x| *x as f32 / 32768.0).collect();
                            b.lock().unwrap().extend(to_mono(&f, channels))
                        },
                        err,
                        None,
                    )
                }
                cpal::SampleFormat::I32 => {
                    let b = buf.clone();
                    device.build_input_stream::<i32, _, _>(
                        config.into(),
                        move |d, _| {
                            let f: Vec<f32> = d.iter().map(|x| *x as f32 / 2_147_483_648.0).collect();
                            b.lock().unwrap().extend(to_mono(&f, channels))
                        },
                        err,
                        None,
                    )
                }
                other => return Err(format!("unsupported microphone format {other:?}")),
            }
            .map_err(|e| format!("couldn't open the microphone: {e}"))?;
            built = t0.elapsed();
            stream.play().map_err(|e| format!("couldn't start the microphone: {e}"))?;
            Ok((stream, buf, rate))
        };
        let (stream, buf, rate) = match open() {
            Ok(x) => {
                let _ = ok.send(Ok(()));
                // A slow open loses the start of what's said (the first after launch took ~2 s on a
                // Mac, 2026-11-21): which step it was, in milliseconds.
                let all = t0.elapsed();
                if all.as_millis() >= 300 {
                    eprintln!(
                        "dunebot-core: microphone: open took {} ms (finding it {}, building {}, starting {})",
                        all.as_millis(),
                        found.as_millis(),
                        (built - found).as_millis(),
                        (all - built).as_millis()
                    );
                }
                x
            }
            Err(e) => {
                let _ = ok.send(Err(e.clone()));
                return Err(e);
            }
        };
        let started = std::time::Instant::now();
        let mut hit_limit = false;
        loop {
            match stop.recv_timeout(Duration::from_millis(70)) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if started.elapsed() >= MAX_RECORDING {
                hit_limit = true;
                break;
            }
            let level = {
                let b = buf.lock().unwrap();
                let tail = &b[b.len().saturating_sub(rate as usize / 14)..];
                if tail.is_empty() { 0.0 } else { (tail.iter().map(|x| x * x).sum::<f32>() / tail.len() as f32).sqrt() }
            };
            app.out.event("voice.level", json!({ "level": (level * 8.0).min(1.0) }));
        }
        drop(stream);
        let samples = std::mem::take(&mut *buf.lock().unwrap());
        Ok((samples, rate, hit_limit))
    }

    /// Takes the recording, unless `only` names a source other than the one recording.
    fn take(app: &App, only: Option<&str>) -> Option<Recording> {
        let mut slot = app.voice.rec.lock().unwrap();
        if only.is_some_and(|s| slot.as_ref().is_some_and(|r| r.source != s)) {
            return None;
        }
        slot.take()
    }

    /// Stops recording and turns it into text (emits `voice.transcript`; a dictation's is typed).
    pub fn stop(app: &Arc<App>) {
        end(app, None)
    }

    /// Stops only a recording `source` started (dictation's keys never end a hold to talk).
    pub fn stop_from(app: &Arc<App>, source: &str) {
        end(app, Some(source))
    }

    fn end(app: &Arc<App>, only: Option<&str>) {
        let Some(rec) = take(app, only) else { return };
        let _ = rec.stop.send(());
        state(app, "transcribing", json!({}));
        let app = app.clone();
        tokio::task::spawn_blocking(move || {
            let result = rec
                .done
                .recv_timeout(Duration::from_secs(10))
                .map_err(|_| "the microphone didn't stop".to_string())
                .and_then(|r| r)
                .and_then(|(samples, rate)| {
                    // The mic stopped when asked; the text waits while the app unlocks the voice keys.
                    let waited = app.sarvam.wait_for_keys(Duration::from_secs(60));
                    if waited.as_millis() >= 300 {
                        eprintln!("dunebot-core: voice: waited {:.1} s for the voice keys", waited.as_secs_f32());
                    }
                    // The key didn't come (the keychain said no), and this computer has no model yet.
                    if !app.sarvam_on() && !model_path(&app).exists() {
                        download(app.clone());
                        return Err(getting_ready(&app));
                    }
                    transcribe(&app, &samples, rate, crate::dictation::words_for(&rec.source)).map_err(|e| e.to_string())
                });
            match result {
                Ok((text, note)) => {
                    // Dictation types what was said where the text cursor is; it never reaches the bar.
                    if rec.source == crate::dictation::SOURCE {
                        crate::dictation::heard(&app, text, note);
                    } else {
                        app.out.event("voice.transcript", json!({ "text": text, "note": note, "source": rec.source }));
                    }
                    state(&app, "idle", json!({}));
                }
                Err(e) => state(&app, "error", json!({ "message": e })),
            }
        });
    }

    pub fn cancel(app: &Arc<App>) {
        if let Some(rec) = take(app, None) {
            let _ = rec.stop.send(());
        }
        state(app, "idle", json!({}));
    }

    /// Cancels only a recording `source` started; anything else listening carries on.
    pub fn cancel_from(app: &Arc<App>, source: &str) {
        if let Some(rec) = take(app, Some(source)) {
            let _ = rec.stop.send(());
            state(app, "idle", json!({}));
        }
    }

    /// Returns the text, or "" and a note saying why there's none. `words`: as said, or English (dictation;
    /// this computer's model is English-only, so its text is English either way).
    pub fn transcribe(app: &App, samples: &[f32], rate: u32, words: crate::sarvam::Words) -> anyhow::Result<(String, Option<&'static str>)> {
        let audio = resample(samples, rate, RATE);
        match check_speech(&audio) {
            Heard::Speech => {}
            Heard::Blocked => {
                return Ok((String::new(), Some("Dune Bot can't hear the microphone. Allow it in System Settings › Privacy & Security › Microphone.")));
            }
            Heard::Silence => return Ok((String::new(), Some("Didn't hear anything."))),
            Heard::TooShort => return Ok((String::new(), Some("Hold the keys while you talk."))),
        }
        // Only speech gets here: silence and a blocked mic were turned back above, before any upload.
        if app.sarvam_on() {
            let t0 = std::time::Instant::now();
            match app.sarvam.transcribe(&audio, words) {
                Ok((text, lang)) => {
                    // Numbers only, never words.
                    eprintln!("dunebot-core: sarvam: {:.1} s of {lang} speech in {:.1} s", audio.len() as f32 / RATE as f32, t0.elapsed().as_secs_f32());
                    crate::speak_stream::hint(app);
                    let text = clean(&text);
                    let note = if text.is_empty() { Some("Didn't catch that.") } else { None };
                    return Ok((text, note));
                }
                Err(e) if model_path(app).exists() => eprintln!("dunebot-core: sarvam: {e}; this computer's model listened instead"),
                Err(e) => bail!("{e}"),
            }
        }
        let ctx = model(app)?;
        let mut st = ctx.create_state().map_err(|e| anyhow!("speech model: {e}"))?;
        let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        p.set_language(Some("en"));
        p.set_n_threads(std::thread::available_parallelism().map(|n| n.get().min(6) as i32).unwrap_or(4));
        p.set_no_context(true);
        p.set_no_timestamps(true);
        p.set_suppress_blank(true);
        p.set_suppress_nst(true);
        p.set_temperature(0.0);
        p.set_print_special(false);
        p.set_print_progress(false);
        p.set_print_realtime(false);
        p.set_print_timestamps(false);
        st.full(p, &audio).map_err(|e| anyhow!("speech recognition failed: {e}"))?;
        let text: String = st.as_iter().filter_map(|seg| seg.to_str_lossy().ok().map(|c| c.into_owned())).collect::<Vec<_>>().join(" ");
        let text = clean(&text);
        let note = if text.is_empty() { Some("Didn't catch that.") } else { None };
        Ok((text, note))
    }

    /// `dunebot-core --transcribe <file.wav>`: the same path as push-to-talk, from a file (tests).
    pub fn cli(app: &Arc<App>, file: &str) -> anyhow::Result<()> {
        let path = model_path(app);
        if !path.exists() {
            fetch(app, &path)?;
        }
        let (samples, rate) = read_wav(&std::fs::read(file)?)?;
        let t0 = std::time::Instant::now();
        let (text, note) = transcribe(app, &samples, rate, crate::sarvam::Words::AsSaid)?;
        println!("{}", json!({ "transcript": text, "note": note, "rate": rate, "secs": t0.elapsed().as_secs_f32() }));
        Ok(())
    }

    fn model(app: &App) -> anyhow::Result<Arc<WhisperContext>> {
        let mut slot = app.voice.model.lock().unwrap();
        if let Some(m) = slot.as_ref() {
            return Ok(m.clone());
        }
        let path = model_path(app);
        if !path.exists() {
            bail!("the speech model isn't downloaded yet");
        }
        whisper_rs::install_logging_hooks();
        let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default()).map_err(|e| anyhow!("couldn't load the speech model: {e}"))?;
        let ctx = Arc::new(ctx);
        *slot = Some(ctx.clone());
        Ok(ctx)
    }

    /// Downloads the model once (in the background), checking its size and SHA-256.
    pub fn download(app: Arc<App>) {
        if app.voice.downloading.swap(true, Ordering::SeqCst) {
            return;
        }
        tokio::task::spawn_blocking(move || {
            let path = model_path(&app);
            let r = fetch(&app, &path);
            app.voice.downloading.store(false, Ordering::SeqCst);
            match r {
                Ok(()) => state(&app, "ready", json!({ "message": format!("Voice is ready. Hold {} (or the mic button) and talk.", crate::keys::chosen().1) })),
                Err(e) => state(&app, "error", json!({ "message": format!("Couldn't get the speech model: {e}") })),
            }
        });
    }

    fn fetch(app: &App, path: &Path) -> anyhow::Result<()> {
        let dir = path.parent().ok_or_else(|| anyhow!("bad model path"))?;
        std::fs::create_dir_all(dir)?;
        let part = dir.join(format!("{MODEL_FILE}.part"));
        let mut resp = ureq::get(MODEL_URL).call()?;
        let mut reader = resp.body_mut().with_config().limit(MODEL_BYTES + 1).reader();
        let mut file = std::fs::File::create(&part)?;
        let mut hash = Sha256::new();
        let mut got: u64 = 0;
        let mut buf = vec![0u8; 1 << 16];
        let mut last_pct = u8::MAX;
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
            file.write_all(&buf[..n])?;
            got += n as u64;
            let pct = ((got * 100) / MODEL_BYTES).min(100) as u8;
            if pct != last_pct {
                last_pct = pct;
                app.voice.progress.store(pct, Ordering::SeqCst);
                state(app, "downloading", json!({ "progress": pct }));
            }
        }
        file.sync_all()?;
        drop(file);
        let digest = format!("{:x}", hash.finalize());
        if got != MODEL_BYTES || digest != MODEL_SHA256 {
            let _ = std::fs::remove_file(&part);
            bail!("the download didn't match (got {got} bytes, sha256 {digest})");
        }
        std::fs::rename(&part, path)?;
        Ok(())
    }
}

#[cfg(not(feature = "voice"))]
mod engine_off {
    use crate::app::App;
    use std::sync::Arc;
    #[derive(Default)]
    pub struct Voice;
    /// No microphone in this build, but answers can still be read aloud by Sarvam.
    pub fn status(app: &App) -> serde_json::Value {
        serde_json::json!({ "available": false, "engine": if app.sarvam_on() { "sarvam" } else { "local" } })
    }
    pub fn transcribe(_: &App, _: &[f32], _: u32, _: crate::sarvam::Words) -> anyhow::Result<(String, Option<&'static str>)> {
        anyhow::bail!("this build of Dune Bot has no voice")
    }
    pub fn start(_: &Arc<App>, _: &str) -> anyhow::Result<()> {
        anyhow::bail!("this build of Dune Bot has no voice")
    }
    pub fn prepare(app: &Arc<App>) -> serde_json::Value {
        status(app)
    }
    pub fn test(_: &Arc<App>) -> anyhow::Result<serde_json::Value> {
        anyhow::bail!("this build of Dune Bot has no voice")
    }
    pub fn stop(_: &Arc<App>) {}
    pub fn warm() {}
    pub fn cancel(_: &Arc<App>) {}
    pub fn stop_from(_: &Arc<App>, _: &str) {}
    pub fn cancel_from(_: &Arc<App>, _: &str) {}
}
#[cfg(not(feature = "voice"))]
pub use engine_off::*;

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, secs: f32, hz: f32, amp: f32) -> Vec<f32> {
        (0..(rate as f32 * secs) as usize).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin()).collect()
    }

    #[cfg(feature = "voice")]
    #[tokio::test]
    async fn a_key_on_its_way_counts_as_sarvam() {
        use crate::app::App;
        use super::engine::{listens_here, model_path};
        let dir = std::env::temp_dir().join(format!("dunebot-listens-{}", crate::app::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = crate::store::Store::open(&dir.join("t.db")).unwrap();
        let app = App::new(crate::protocol::Out::start(), store, dir.clone());
        assert!(!model_path(&app).exists(), "no model on this computer");
        assert!(listens_here(&app), "no key and none coming: this computer's model listens (so it's fetched first)");
        app.sarvam.keys_coming(true);
        assert!(!listens_here(&app), "a key being unlocked: record now, no download, no model loaded");
        app.sarvam.keys_coming(false);
        assert!(listens_here(&app), "the keychain said no: back to this computer's model");
        app.sarvam.set_key(Some("sk_test_key".into())).unwrap();
        assert!(!listens_here(&app), "a key in: Sarvam listens");
        app.set_pref("voice.engine", "local").unwrap();
        app.sarvam.keys_coming(true);
        assert!(listens_here(&app), "this computer's voice picked: its model listens, key or not");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resample_keeps_length_and_pitch() {
        for from in [48_000, 44_100, 16_000, 8_000] {
            let out = resample(&tone(from, 1.0, 440.0, 0.5), from, RATE);
            assert!((out.len() as i64 - RATE as i64).abs() <= 2, "{from}: {}", out.len());
            // zero crossings of a 440 Hz tone over 1 s ≈ 880
            let zc = out.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
            assert!((870..=890).contains(&zc), "{from}: {zc} crossings");
        }
    }

    #[test]
    fn resample_removes_tones_above_8khz() {
        let out = resample(&tone(48_000, 0.5, 11_000.0, 0.5), 48_000, RATE);
        let peak = out[400..out.len() - 400].iter().fold(0f32, |m, x| m.max(x.abs()));
        assert!(peak < 0.05, "aliased peak {peak}");
    }

    #[test]
    fn mono_mix() {
        assert_eq!(to_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
    }

    #[test]
    fn silence_and_blocked_mic_are_not_speech() {
        assert_eq!(check_speech(&vec![0.0; RATE as usize * 2]), Heard::Blocked);
        let hiss: Vec<f32> = (0..RATE as usize * 2).map(|i| 0.002 * ((i * 7919 % 1000) as f32 / 500.0 - 1.0)).collect();
        assert_eq!(check_speech(&hiss), Heard::Silence);
        assert_eq!(check_speech(&tone(RATE, 0.2, 200.0, 0.3)), Heard::TooShort);
        let mut talk = hiss.clone();
        talk.extend(tone(RATE, 0.8, 220.0, 0.2));
        assert_eq!(check_speech(&talk), Heard::Speech);
    }

    #[test]
    fn clean_drops_annotations() {
        assert_eq!(clean(" [BLANK_AUDIO] "), "");
        assert_eq!(clean("(music)"), "");
        assert_eq!(clean(" Open my   Downloads folder. [typing]"), "Open my Downloads folder.");
        assert_eq!(clean(" ..."), "");
    }
}
