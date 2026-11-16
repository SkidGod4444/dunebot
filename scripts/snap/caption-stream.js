// Sarvam's streaming voice on the built page: a stand-in stream (nothing is sent) gives each sentence
// two chunks of a made-up 16-bit tone, which must play through the page's real AudioContext at volume
// 0. The log's "speech:" line says how many sentences were streamed and how soon the first sound came.
(async () => {
  const dm = window.__dm;
  const rate = 22050;
  const chunk = () => {
    const n = Math.round(rate * 0.25);
    const b = new Uint8Array(n * 2);
    const v = new DataView(b.buffer);
    for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), true);
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  };
  const listeners = new Set();
  dm.speechVolume(0);
  dm.Speaker.sarvam = true;
  dm.Speaker.fetchSarvam = async () => null; // a fetch would mean the stream failed
  dm.Speaker.stream = {
    open: async () => "made-up-stream",
    say: async (id, words) => {
      setTimeout(() => listeners.forEach((f) => (f({ stream: id, rate, audio: chunk() }), f({ stream: id, rate, audio: chunk() }))), 60);
      return true;
    },
    close: () => {},
    listen: (f) => (listeners.add(f), () => listeners.delete(f)),
  };
  const s = new dm.Speaker();
  s.feed("First made-up sentence. Second one.", true);
  await new Promise((r) => setTimeout(r, 3500));
})();
