// Settings › Connectors: Slack, Gmail, Notion, Google Calendar and X, none connected, with Slack's
// form open (its client ID, and the Redirect URL its Slack app must list). Nothing is connected:
// a snapshot never signs in or touches the keychain.
(async () => {
  const dm = window.__dm;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + 5000;
  while (Date.now() < end && !dm.get().modes.length) await sleep(100);
  dm.set({ view: "settings" });
  const rowOf = (label) => [...document.querySelectorAll("span")].find((s) => s.textContent === label)?.closest("div.px-4");
  const until = Date.now() + 12000;
  let row;
  while (Date.now() < until && !(row = rowOf("Slack"))?.querySelector("button")) await sleep(100);
  [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Connect")?.click();
  let input;
  while (Date.now() < until && !(input = document.querySelector('input[placeholder="Client ID"]'))) await sleep(100);
  const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent === "Connectors");
  // Held still until it stays put for 500 ms (a part above it can draw late).
  const settle = Date.now() + 4000;
  let last = NaN, since = Date.now();
  while (heading && Date.now() < settle) {
    heading.scrollIntoView({ block: "start" });
    const top = Math.round(heading.getBoundingClientRect().top);
    if (top !== last) (last = top), (since = Date.now());
    else if (Date.now() - since >= 500) break;
    await sleep(100);
  }
  await sleep(300);
  const accounts = ["Slack", "Gmail", "Notion", "Google Calendar", "X"].filter((l) => rowOf(l)).length;
  return { found: !!row, form: !!input, accounts, redirect: !!document.querySelector("code")?.textContent?.includes("localhost:51735") };
})();
