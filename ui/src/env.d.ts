/// <reference types="vite/client" />
/** Whether a voice key (Sarvam, Deepgram) is saved (pages never see the key itself). */
type SarvamStatus = { saved: boolean; canSave: boolean };
interface Window {
  dunebot: {
    platform: string;
    wayland?: boolean;
    call: (method: string, params?: Record<string, unknown>) => Promise<any>;
    pickFolder: () => Promise<string | null>;
    appleDictation: () => Promise<boolean>;
    onEvent: (fn: (msg: any) => void) => () => void;
    onNav: (fn: (view: string) => void) => () => void;
    onLook: (fn: (look: { material: "glass" | "vibrancy" | "none"; radius?: number; standin?: boolean }) => void) => () => void;
    openMain: (view?: string) => void;
    glassRadius: (radius: number) => void;
    note?: (text: string) => void;
    testTranscript?: (text: string) => void;
    testDictate?: (text: string) => void;
    sarvam: {
      status: () => Promise<SarvamStatus>;
      save: (key: string) => Promise<SarvamStatus>;
      remove: () => Promise<SarvamStatus>;
    };
    deepgram: {
      status: () => Promise<SarvamStatus>;
      save: (key: string) => Promise<SarvamStatus>;
      remove: () => Promise<SarvamStatus>;
    };
    telegram: {
      status: () => Promise<SarvamStatus>;
      save: (key: string) => Promise<SarvamStatus>;
      remove: () => Promise<SarvamStatus>;
    };
    setup: {
      status: () => Promise<import("./Setup").SetupStatus>;
      ask: (what: "mic" | "mic-test" | "notifications" | "folders" | "voice" | "screen" | "gnome-keys" | "gnome-dictate-key") => Promise<any>;
      openSettings: (what: "mic" | "notifications" | "folders" | "screen") => void;
      fit: (height: number) => void;
      finish: (done: boolean) => Promise<void>;
    };
    bar: {
      resize: (height: number) => void;
      hide: () => void;
      agents: () => Promise<import("./store").Agent[]>;
      onThread: (fn: (threadId: string) => void) => () => void;
      onFocus: (fn: (opts?: { fresh?: boolean }) => void) => () => void;
      sent: (threadId: string) => void;
      open: () => void;
      held: (h: { chat: string; text: string } | null) => void;
      onCardDone: (fn: () => void) => () => void;
      last: () => void;
    };
    caption: {
      hide: (n?: number) => void;
      mouse: (on: boolean) => void;
      onShow: (fn: (s: import("./Caption").CaptionShow) => void) => () => void;
      onHush: (fn: () => void) => () => void;
      onNext: (fn: (text: string | null) => void) => () => void;
      nextDone: () => void;
      onPlace: (fn: (p: { side: "below" | "above"; align: "left" | "right" }) => void) => () => void;
      onMoving: (fn: (moving: boolean) => void) => () => void;
      settled: (on: boolean) => void;
      testShow: (threadId: string) => void;
    };
  };
}
