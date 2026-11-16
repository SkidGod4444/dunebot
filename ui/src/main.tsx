import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Bar } from "./Bar";
import { Setup } from "./Setup";
import { Caption, showCaption, showNext } from "./Caption";
import { Speaker } from "./speak";
import { boot, bootBar, bootCaption, get, openThread, send, sendFromBar, set, startChat } from "./store";

const isBar = location.hash === "#bar";
const isSetup = location.hash.startsWith("#setup");
const isCaption = location.hash === "#caption";
// The bar and setup float over the desktop; the history window is a normal window.
document.documentElement.dataset.os = window.dunebot.platform;
if (isBar) document.documentElement.classList.add("bar", "floating");
if (isSetup) document.documentElement.classList.add("setup", "floating");
// The caption is a solid card in a see-through window: no glass behind it.
if (isCaption) {
  document.documentElement.classList.add("caption", "floating");
  document.documentElement.dataset.material = "none";
}
window.dunebot.onLook((look) => {
  const html = document.documentElement;
  html.dataset.material = look.material;
  if (look.standin) html.dataset.standin = "";
  set({ material: look.material });
});
createRoot(document.getElementById("root")!).render(isBar ? <Bar /> : isSetup ? <Setup /> : isCaption ? <Caption /> : <App />);
if (!isSetup) (isBar ? bootBar() : isCaption ? bootCaption() : boot()).catch(() => set({ coreDown: true }));
else window.dunebot.onEvent((m) => m.event === "core.exit" && set({ coreDown: true }));

// for snapshot scripts
(window as any).__dm = { get, set, openThread, send, sendFromBar, startChat, caption: (s: any) => showCaption.current?.(s), next: (t: string | null) => showNext.current?.(t), speechVolume: (v: number) => (Speaker.volume = v), Speaker };
