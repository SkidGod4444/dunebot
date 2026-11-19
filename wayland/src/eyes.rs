//! The screen, from the desktop's video stream (PipeWire, through the portal's private remote).
//! Each picture opens the monitor's stream, takes the first full frame and closes it again: the
//! desktop sends a fresh frame when a stream starts (40-200 ms in the GNOME 46 spike), and nothing
//! streams while Dune Bot isn't looking. Frames come as shared memory (no GPU modifiers offered),
//! and are written as tightly packed BGRA rows.

use pipewire as pw;
use pw::spa;
use std::{
    cell::RefCell,
    collections::HashMap,
    io::Write,
    os::{fd::OwnedFd, unix::fs::OpenOptionsExt},
    rc::Rc,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

type Reply = oneshot::Sender<Result<(u32, u32), String>>;

enum Cmd {
    Frame { node: u32, path: String, reply: Reply },
    Quit,
}

pub struct Eyes {
    tx: pw::channel::Sender<Cmd>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Eyes {
    pub fn start(fd: OwnedFd) -> Result<Eyes, String> {
        let (tx, rx) = pw::channel::channel::<Cmd>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let thread = std::thread::Builder::new()
            .name("pipewire".into())
            .spawn(move || run(fd, rx, ready_tx))
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Eyes { tx, thread: Some(thread) }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("PipeWire didn't answer".into()),
        }
    }

    pub async fn frame(&self, node: u32, path: &str) -> Result<(u32, u32), String> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::Frame { node, path: path.to_string(), reply })
            .map_err(|_| "The screen stream stopped.".to_string())?;
        match tokio::time::timeout(Duration::from_secs(6), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("The screen stream stopped.".into()),
            Err(_) => Err("The desktop sent no picture of the screen.".into()),
        }
    }

    pub fn stop(mut self) {
        let _ = self.tx.send(Cmd::Quit);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Eyes {
    fn drop(&mut self) {
        let _ = self.tx.send(Cmd::Quit);
    }
}

/// One picture being taken: its stream, and what to do with the first frame.
struct Pending {
    stream: pw::stream::StreamRc,
    _listener: pw::stream::StreamListener<Shared>,
    started: Instant,
    state: Shared,
}

/// What the stream's callbacks fill in.
type Shared = Rc<RefCell<Grab>>;

struct Grab {
    format: Option<spa::param::video::VideoInfoRaw>,
    path: String,
    reply: Option<Reply>,
    done: bool,
}

fn run(fd: OwnedFd, rx: pw::channel::Receiver<Cmd>, ready: std::sync::mpsc::Sender<Result<(), String>>) {
    pw::init();
    let setup = (|| {
        let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(|e| e.to_string())?;
        let context = pw::context::ContextRc::new(&mainloop, None).map_err(|e| e.to_string())?;
        let core = context.connect_fd_rc(fd, None).map_err(|e| e.to_string())?;
        Ok::<_, String>((mainloop, context, core))
    })();
    let (mainloop, _context, core) = match setup {
        Ok(v) => {
            let _ = ready.send(Ok(()));
            v
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let pending: Rc<RefCell<HashMap<u64, Pending>>> = Rc::new(RefCell::new(HashMap::new()));
    let next_id = Rc::new(RefCell::new(0u64));

    let _commands = {
        let ml = mainloop.clone();
        let core = core.clone();
        let pending = pending.clone();
        rx.attach(mainloop.loop_(), move |cmd| match cmd {
            Cmd::Quit => ml.quit(),
            Cmd::Frame { node, path, reply } => {
                let id = {
                    let mut n = next_id.borrow_mut();
                    *n += 1;
                    *n
                };
                match open_stream(&core, node, path, reply) {
                    Ok(p) => {
                        pending.borrow_mut().insert(id, p);
                    }
                    Err((reply, e)) => {
                        let _ = reply.send(Err(e));
                    }
                }
            }
        })
    };

    // Streams are closed from here, never inside their own callbacks; slow ones give up.
    let sweep = {
        let pending = pending.clone();
        mainloop.loop_().add_timer(move |_| {
            let mut p = pending.borrow_mut();
            let finished: Vec<u64> = p
                .iter()
                .filter(|(_, v)| v.state.borrow().done || v.started.elapsed() > Duration::from_secs(5))
                .map(|(k, _)| *k)
                .collect();
            for k in finished {
                if let Some(v) = p.remove(&k) {
                    if let Some(r) = v.state.borrow_mut().reply.take() {
                        let _ = r.send(Err("The desktop sent no picture of the screen.".into()));
                    }
                    let _ = v.stream.disconnect();
                }
            }
        })
    };
    let _ = sweep.update_timer(Some(Duration::from_millis(50)), Some(Duration::from_millis(50)));

    mainloop.run();
    pending.borrow_mut().clear();
}

fn open_stream(core: &pw::core::CoreRc, node: u32, path: String, reply: Reply) -> Result<Pending, (Reply, String)> {
    let props = pw::properties::properties! {
        *pw::keys::MEDIA_TYPE => "Video",
        *pw::keys::MEDIA_CATEGORY => "Capture",
        *pw::keys::MEDIA_ROLE => "Screen",
    };
    let stream = match pw::stream::StreamRc::new(core.clone(), "dunebot-screen", props) {
        Ok(s) => s,
        Err(e) => return Err((reply, e.to_string())),
    };
    let state: Shared = Rc::new(RefCell::new(Grab { format: None, path, reply: Some(reply), done: false }));
    let listener = stream
        .add_local_listener_with_user_data(state.clone())
        .state_changed(|_, g, _, new| {
            if let pw::stream::StreamState::Error(e) = new {
                let mut g = g.borrow_mut();
                if let Some(r) = g.reply.take() {
                    let _ = r.send(Err(format!("screen stream: {e}")));
                }
                g.done = true;
            }
        })
        .param_changed(|_, g, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let mut info = spa::param::video::VideoInfoRaw::default();
            if info.parse(param).is_ok() {
                g.borrow_mut().format = Some(info);
            }
        })
        .process(|stream, g| {
            let Some(mut buffer) = stream.dequeue_buffer() else { return };
            let mut g = g.borrow_mut();
            if g.done || g.reply.is_none() {
                return;
            }
            let Some(info) = g.format else { return };
            let datas = buffer.datas_mut();
            let Some(d) = datas.first_mut() else { return };
            let (size, offset, stride, corrupted) = {
                let c = d.chunk();
                (c.size() as usize, c.offset() as usize, c.stride(), c.flags().contains(spa::buffer::ChunkFlags::CORRUPTED))
            };
            // Cursor-only or damaged updates carry no picture: wait for the next one.
            if size == 0 || corrupted {
                return;
            }
            let Some(bytes) = d.data() else { return };
            let w = info.size().width;
            let h = info.size().height;
            let stride = if stride > 0 { stride as usize } else { w as usize * 4 };
            let result = write_bgra(&g.path, info.format(), w, h, stride, &bytes[offset.min(bytes.len())..]).map(|_| (w, h));
            if let Some(r) = g.reply.take() {
                let _ = r.send(result);
            }
            g.done = true;
        })
        .register();
    let listener = match listener {
        Ok(l) => l,
        Err(e) => {
            let r = state.borrow_mut().reply.take();
            return Err((r.expect("reply"), e.to_string()));
        }
    };
    let format = format_pod();
    let Ok(pod) = spa::pod::Pod::from_bytes(&format).ok_or(()) else {
        let r = state.borrow_mut().reply.take();
        return Err((r.expect("reply"), "bad format".into()));
    };
    if let Err(e) = stream.connect(
        spa::utils::Direction::Input,
        Some(node),
        pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
        &mut [pod],
    ) {
        let r = state.borrow_mut().reply.take();
        return Err((r.expect("reply"), e.to_string()));
    }
    Ok(Pending { stream, _listener: listener, started: Instant::now(), state })
}

/// Raw 4-byte formats only, and no DMA-BUF modifiers: the desktop then hands frames over as
/// shared memory the CPU can read on any GPU.
fn format_pod() -> Vec<u8> {
    use spa::param::{format::FormatProperties as F, video::VideoFormat as V};
    let obj = spa::pod::object!(
        spa::utils::SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        spa::pod::property!(F::MediaType, Id, spa::param::format::MediaType::Video),
        spa::pod::property!(F::MediaSubtype, Id, spa::param::format::MediaSubtype::Raw),
        spa::pod::property!(F::VideoFormat, Choice, Enum, Id, V::BGRx, V::BGRx, V::BGRA, V::RGBx, V::RGBA, V::xRGB, V::ARGB, V::xBGR, V::ABGR),
        spa::pod::property!(
            F::VideoSize,
            Choice,
            Range,
            Rectangle,
            spa::utils::Rectangle { width: 1920, height: 1080 },
            spa::utils::Rectangle { width: 1, height: 1 },
            spa::utils::Rectangle { width: 16384, height: 16384 }
        ),
        spa::pod::property!(
            F::VideoFramerate,
            Choice,
            Range,
            Fraction,
            spa::utils::Fraction { num: 30, denom: 1 },
            spa::utils::Fraction { num: 0, denom: 1 },
            spa::utils::Fraction { num: 1000, denom: 1 }
        ),
    );
    spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &spa::pod::Value::Object(obj))
        .map(|(c, _)| c.into_inner())
        .unwrap_or_default()
}

/// Rows of B, G, R, 255 for the app (Electron's nativeImage bitmap order), to a file only this
/// user can read; never through a link.
fn write_bgra(path: &str, format: spa::param::video::VideoFormat, w: u32, h: u32, stride: usize, src: &[u8]) -> Result<(), String> {
    use spa::param::video::VideoFormat as V;
    let (w, h) = (w as usize, h as usize);
    if w == 0 || h == 0 || stride < w * 4 || src.len() < stride * (h - 1) + w * 4 {
        return Err(format!("The screen frame was incomplete ({w}x{h}, {} bytes).", src.len()));
    }
    // Where B, G, R sit in each 4-byte pixel.
    let (b, g, r) = match format {
        V::BGRx | V::BGRA => (0, 1, 2),
        V::RGBx | V::RGBA => (2, 1, 0),
        V::xRGB | V::ARGB => (3, 2, 1),
        V::xBGR | V::ABGR => (1, 2, 3),
        other => return Err(format!("The desktop sent an unexpected pixel format ({other:?}).")),
    };
    let mut out = vec![0u8; w * h * 4];
    for y in 0..h {
        let row = &src[y * stride..y * stride + w * 4];
        let dst = &mut out[y * w * 4..(y + 1) * w * 4];
        for (s, d) in row.chunks_exact(4).zip(dst.chunks_exact_mut(4)) {
            d[0] = s[b];
            d[1] = s[g];
            d[2] = s[r];
            d[3] = 255;
        }
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| format!("Couldn't write the screen picture: {e}"))?;
    f.write_all(&out).map_err(|e| format!("Couldn't write the screen picture: {e}"))
}
