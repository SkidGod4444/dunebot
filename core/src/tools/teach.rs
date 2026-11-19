//! Teaching ("show me how to…"): instead of doing a step for the user, the agent points at the
//! control they should use next. `point_at` puts a white ring with a short label around it, over
//! every app, in a window of the app's own that never takes the mouse or keyboard
//! (electron/pointer.mjs, drawn by ui/src/Pointer.tsx); `clear_pointer` takes it away. Pointing
//! changes nothing on the screen, so it never asks the user and doesn't use up the chat's picture of
//! the screen (a click after it still can).
//!
//! The highlight stays until the agent points again or clears it, the user moves on to another chat,
//! stops it or deletes the chat (the app sees those), or `STAYS` passes (here).

use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use serde_json::{json, Value};

use super::{Shot, SHOT_FRESH};
use crate::{app::App, policy::Action, store::Thread};

/// How long a highlight stays when nothing replaces or clears it.
const STAYS: Duration = Duration::from_secs(120);
/// The ring around a point when the agent gives no size, in screen points.
const RING: f64 = 44.0;
/// A box is never drawn smaller than this on a side, in screen points.
const MIN_SIDE: f64 = 12.0;
const MAX_LABEL: usize = 60;

/// The newest highlight, so a timer can't take away one that came after its own.
static NEWEST: AtomicU64 = AtomicU64::new(0);

pub fn list() -> Vec<Value> {
    let px = |what: &str| json!({ "type": "number", "description": what });
    vec![
        json!({
            "name": "point_at",
            "description": "Point at something on the user's screen to show them where it is, without doing it for them: a white ring with a short label appears around it, over every app, until you point again or call clear_pointer (it also goes by itself after 2 minutes). Use it to teach (\"show me how to…\", \"how do I … here?\", \"where's the …\"): take a picture with look_at_screen first, then give the middle of the control in that picture's pixels, its size if you can, and a label of a few words. Then tell the user that one step in a short sentence and let them do it. It never clicks, never asks the user, and doesn't use up the picture. Not available on Linux with Wayland: there, say where it is in words.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": px("The middle of the control: pixels from the left of the latest look_at_screen picture"),
                    "y": px("The middle of the control: pixels from the top of the latest look_at_screen picture"),
                    "width": px("The control's width in that picture's pixels (optional: without a size, a small ring goes round the point)"),
                    "height": px("The control's height in that picture's pixels (optional)"),
                    "label": { "type": "string", "description": "A few words shown beside the ring (\"Share\", \"the Filters button\"), up to 60 characters" }
                },
                "required": ["x", "y", "label"]
            }
        }),
        json!({
            "name": "clear_pointer",
            "description": "Take the highlight point_at drew off the user's screen: when the lesson is over, or the user moves on to something else.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
    ]
}

/// `None` when the tool isn't one of these.
pub async fn call(app: &App, thread: &Thread, name: &str, args: &Value) -> Option<(String, bool, Option<Value>)> {
    let r = match name {
        "point_at" => point_at(app, thread, args).await,
        "clear_pointer" => clear_pointer(app, thread).await,
        _ => return None,
    };
    Some(match r {
        Ok(text) => (text, false, None),
        Err(text) => (text, true, None),
    })
}

/// What the agent asked to point at: the middle of the control and its size in the picture's
/// pixels, and the label.
#[derive(Debug, PartialEq)]
struct Aim {
    x: f64,
    y: f64,
    width: Option<f64>,
    height: Option<f64>,
    label: String,
}

fn aim(args: &Value) -> Result<Aim, String> {
    let num = |k: &str| args.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
    let (Some(x), Some(y)) = (num("x"), num("y")) else {
        return Err("\"x\" and \"y\" are required: the middle of the control in the latest look_at_screen picture, in its pixels.".into());
    };
    let size = |k: &str| -> Result<Option<f64>, String> {
        match args.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(_) => match num(k) {
                Some(v) if v > 0.0 => Ok(Some(v)),
                _ => Err(format!("\"{k}\" must be a number of pixels above 0, or left out.")),
            },
        }
    };
    let (width, height) = (size("width")?, size("height")?);
    let label = tidy_label(args.get("label").and_then(Value::as_str).unwrap_or(""));
    if label.is_empty() {
        return Err("\"label\" is required: a few words shown beside the ring (\"Share\", \"the Filters button\").".into());
    }
    Ok(Aim { x, y, width, height, label })
}

/// One line of at most `MAX_LABEL` characters, nothing that isn't text.
fn tidy_label(raw: &str) -> String {
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let flat: String = flat.chars().filter(|c| !c.is_control()).collect();
    if flat.chars().count() <= MAX_LABEL {
        flat
    } else {
        format!("{}…", flat.chars().take(MAX_LABEL - 1).collect::<String>().trim_end())
    }
}

/// Where the ring goes on the screen, in the app's screen points (the same ones a click uses): its
/// top left corner and size, and whether it's a plain ring round a point (no size given).
#[derive(Debug, PartialEq)]
struct Area {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    round: bool,
}

/// The aim turned into screen points by the picture it was given in, kept inside that picture.
fn area(shot: &Shot, a: &Aim) -> Result<Area, String> {
    let (cx, cy) = shot.point(a.x, a.y)?;
    let (pw, ph) = (shot.width * shot.scale, shot.height * shot.scale);
    let side = |v: Option<f64>, most: f64| v.map_or(RING, |v| (v * shot.scale).max(MIN_SIDE)).min(most);
    let (width, height) = (side(a.width, pw), side(a.height, ph));
    let x = (cx - width / 2.0).clamp(shot.x, shot.x + pw - width);
    let y = (cy - height / 2.0).clamp(shot.y, shot.y + ph - height);
    Ok(Area { x, y, width, height, round: a.width.is_none() && a.height.is_none() })
}

/// The chat's latest picture. Pointing doesn't use it up: nothing on the screen changes.
fn latest_shot(app: &App, thread: &Thread) -> Result<Shot, String> {
    let shot = app.shots.lock().unwrap().get(&thread.id).copied();
    let Some(shot) = shot else {
        return Err("Look at the screen first (look_at_screen), then point by that picture's pixels.".into());
    };
    if shot.at.elapsed() > SHOT_FRESH {
        return Err("The latest picture of the screen is a few minutes old. Look at the screen again, then point by the new picture.".into());
    }
    Ok(shot)
}

/// How long a highlight stays (`DUNEBOT_POINTER_MS` shortens it for tests).
fn stays() -> Duration {
    std::env::var("DUNEBOT_POINTER_MS").ok().and_then(|v| v.parse().ok()).map_or(STAYS, Duration::from_millis)
}

async fn point_at(app: &App, thread: &Thread, args: &Value) -> Result<String, String> {
    let a = aim(args)?;
    let shot = latest_shot(app, thread)?;
    let at = area(&shot, &a)?;
    app.gate(&thread.id, Action::Point, &a.label, &format!("at ({:.0}, {:.0}) in the picture", a.x, a.y)).await?;
    let newest = NEWEST.fetch_add(1, Ordering::SeqCst) + 1;
    let req = json!({
        "kind": "point", "x": at.x, "y": at.y, "width": at.width, "height": at.height, "round": at.round,
        "label": a.label, "threadId": thread.id, "gen": newest,
    });
    // The app draws it (or says why it can't: Wayland). It waits for the page to draw the ring.
    app.input(req, 10).await?;
    let out = app.out.clone();
    let wait = stays();
    tokio::spawn(async move {
        tokio::time::sleep(wait).await;
        if NEWEST.load(Ordering::SeqCst) == newest {
            out.event("pointer.clear", json!({ "gen": newest }));
        }
    });
    Ok(format!(
        "The user now sees a ring around {} with the label \"{}\". Tell them this one step in a short sentence, then stop and let them do it: don't click it for them unless they ask. When they say they've done it (or ask again), look at the screen again and point at the next step. Call clear_pointer when the lesson is over.",
        if at.round { "that point" } else { "it" },
        a.label
    ))
}

async fn clear_pointer(app: &App, thread: &Thread) -> Result<String, String> {
    app.gate(&thread.id, Action::Point, "the highlight", "taken off the screen").await?;
    let newest = NEWEST.fetch_add(1, Ordering::SeqCst) + 1;
    app.input(json!({ "kind": "unpoint", "gen": newest }), 10).await?;
    Ok("Took the highlight off the user's screen.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    // A Retina display's right half (points 1512..3024) pictured at 1568 pixels wide, as in tools.rs.
    fn shot() -> Shot {
        Shot { x: 1512.0, y: 0.0, width: 1568.0, height: 1019.0, scale: 1512.0 / 1568.0, at: Instant::now() }
    }

    #[test]
    fn the_arguments_are_checked() {
        let a = aim(&json!({ "x": 100, "y": 50.5, "width": 80, "height": 24, "label": "  the\nShare   button " })).unwrap();
        assert_eq!(a, Aim { x: 100.0, y: 50.5, width: Some(80.0), height: Some(24.0), label: "the Share button".into() });
        let bare = aim(&json!({ "x": 0, "y": 0, "label": "Here", "width": null })).unwrap();
        assert_eq!((bare.width, bare.height), (None, None));
        for (bad, needle) in [
            (json!({ "y": 5, "label": "x" }), "\"x\" and \"y\" are required"),
            (json!({ "x": "10", "y": 5, "label": "x" }), "\"x\" and \"y\" are required"),
            (json!({ "x": 1, "y": 5 }), "\"label\" is required"),
            (json!({ "x": 1, "y": 5, "label": " \u{7}\n " }), "\"label\" is required"),
            (json!({ "x": 1, "y": 5, "label": "a", "width": 0 }), "\"width\" must be"),
            (json!({ "x": 1, "y": 5, "label": "a", "height": -3 }), "\"height\" must be"),
            (json!({ "x": 1, "y": 5, "label": "a", "width": "wide" }), "\"width\" must be"),
        ] {
            let e = aim(&bad).unwrap_err();
            assert!(e.contains(needle), "{bad}: {e}");
        }
    }

    #[test]
    fn labels_are_one_short_line() {
        assert_eq!(tidy_label("Save\u{7}  as…"), "Save as…");
        let long = tidy_label(&"word ".repeat(40));
        assert!(long.chars().count() <= MAX_LABEL && long.ends_with('…'), "{long}");
    }

    #[test]
    fn the_ring_lands_where_a_click_would() {
        let s = shot();
        let k = s.scale;
        // A box: centred where a click at the same point would land, its size scaled to points.
        let a = area(&s, &aim(&json!({ "x": 784, "y": 500, "width": 200, "height": 40, "label": "Tab" })).unwrap()).unwrap();
        let (cx, cy) = s.point(784.0, 500.0).unwrap();
        assert!((a.x + a.width / 2.0 - cx).abs() < 0.01 && (a.y + a.height / 2.0 - cy).abs() < 0.01, "{a:?}");
        assert!((a.width - 200.0 * k).abs() < 0.01 && (a.height - 40.0 * k).abs() < 0.01 && !a.round, "{a:?}");
        // No size: a ring of RING points round the point.
        let r = area(&s, &aim(&json!({ "x": 784, "y": 500, "label": "Here" })).unwrap()).unwrap();
        assert!(r.round && r.width == RING && r.height == RING, "{r:?}");
        // A tiny box is drawn big enough to see.
        let t = area(&s, &aim(&json!({ "x": 784, "y": 500, "width": 2, "height": 2, "label": "Dot" })).unwrap()).unwrap();
        assert_eq!((t.width, t.height), (MIN_SIDE, MIN_SIDE));
    }

    #[test]
    fn the_ring_stays_inside_the_picture() {
        let s = shot();
        let (right, bottom) = (s.x + s.width * s.scale, s.y + s.height * s.scale);
        // Near the top left corner: moved in, not cut off.
        let a = area(&s, &aim(&json!({ "x": 3, "y": 2, "width": 100, "height": 60, "label": "Menu" })).unwrap()).unwrap();
        assert_eq!((a.x, a.y), (s.x, s.y));
        // Near the bottom right corner.
        let b = area(&s, &aim(&json!({ "x": 1566, "y": 1018, "label": "Clock" })).unwrap()).unwrap();
        assert!((b.x + b.width - right).abs() < 0.01 && (b.y + b.height - bottom).abs() < 0.01, "{b:?}");
        // Larger than the picture: the whole picture.
        let c = area(&s, &aim(&json!({ "x": 784, "y": 500, "width": 9000, "height": 9000, "label": "All" })).unwrap()).unwrap();
        assert!((c.x - s.x).abs() < 0.01 && (c.width - s.width * s.scale).abs() < 0.01 && (c.height - s.height * s.scale).abs() < 0.01, "{c:?}");
        // The middle must be in the picture, as for a click.
        let e = area(&s, &aim(&json!({ "x": 1569, "y": 5, "label": "Off" })).unwrap()).unwrap_err();
        assert!(e.contains("isn't in the picture"), "{e}");
    }

    #[test]
    fn the_tools_are_listed_with_their_arguments() {
        let tools = list();
        let point = tools.iter().find(|t| t["name"] == "point_at").expect("point_at");
        assert_eq!(point["inputSchema"]["required"], json!(["x", "y", "label"]));
        for k in ["x", "y", "width", "height", "label"] {
            assert!(point["inputSchema"]["properties"].get(k).is_some(), "{k}");
        }
        assert!(tools.iter().any(|t| t["name"] == "clear_pointer"));
    }

    #[test]
    fn pointing_never_asks() {
        assert_eq!(Action::Point.default_mode(), crate::policy::Mode::Always);
        assert_eq!(Action::from_key("point"), Some(Action::Point));
    }
}
