//! Scheduled tasks: a prompt that starts a new chat at set times (every day, weekdays, once a week
//! or every hour, in local time). A run is an ordinary chat: it asks before commands and file
//! changes even when Permissions says Always (see App::gate), nothing is approved for it, and a card left waiting holds the run
//! there (the next run is skipped while the last one is still going). Dune Bot ships with none.

use std::{sync::Arc, time::Duration};

use anyhow::bail;
use chrono::{Datelike, Local, NaiveTime, TimeZone, Timelike};
use serde_json::{json, Value};

use crate::{agent, app::App, policy, store::{now_ms, Schedule}};

const EVERY: [&str; 4] = ["daily", "weekdays", "weekly", "hourly"];
/// A run missed by more than this (computer asleep, Dune Bot closed) is skipped, not run late.
const LATE_OK_MS: i64 = 60 * 60 * 1000;

/// The first time after `after_ms` the schedule is due, in local time.
pub fn next_after(after_ms: i64, every: &str, at: i64, weekday: i64) -> Option<i64> {
    let after = Local.timestamp_millis_opt(after_ms).single()?;
    if every == "hourly" {
        let mut t = after.with_minute((at % 60) as u32)?.with_second(0)?.with_nanosecond(0)?;
        if t <= after {
            t += chrono::Duration::hours(1);
        }
        return Some(t.timestamp_millis());
    }
    let time = NaiveTime::from_hms_opt((at / 60) as u32, (at % 60) as u32, 0)?;
    let mut day = after.date_naive();
    for _ in 0..16 {
        let wd = day.weekday().num_days_from_sunday() as i64;
        let fits = match every {
            "daily" => true,
            "weekdays" => (1..=5).contains(&wd),
            "weekly" => wd == weekday,
            _ => return None,
        };
        // A time the clock skips (summer time) runs an hour later that day.
        let local = Local.from_local_datetime(&day.and_time(time)).earliest().or_else(|| {
            Local.from_local_datetime(&(day.and_time(time) + chrono::Duration::hours(1))).earliest()
        });
        if let Some(t) = local.filter(|t| fits && *t > after) {
            return Some(t.timestamp_millis());
        }
        day = day.succ_opt()?;
    }
    None
}

pub fn add(app: &Arc<App>, p: &Value) -> anyhow::Result<Schedule> {
    let text = |k: &str| p.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("");
    let prompt = text("prompt");
    if prompt.is_empty() {
        bail!("Write what the agent should do.");
    }
    if prompt.chars().count() > 4000 {
        bail!("Keep it under 4000 characters.");
    }
    let every = text("every");
    if !EVERY.contains(&every) {
        bail!("\"every\" must be one of {}", EVERY.join(", "));
    }
    let agent = text("agent");
    if agent.is_empty() || !agent.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        bail!("bad agent id");
    }
    let at = p.get("at").and_then(Value::as_i64).unwrap_or(9 * 60);
    let weekday = p.get("weekday").and_then(Value::as_i64).unwrap_or(1);
    if !(0..24 * 60).contains(&at) || !(0..7).contains(&weekday) {
        bail!("bad time");
    }
    let cwd = match text("cwd") {
        "" => None,
        raw => {
            let path = policy::resolve(raw, &app.data_dir);
            if let Some(why) = policy::denied(&path, &app.data_dir) {
                bail!("that folder is {why}");
            }
            if !path.is_dir() {
                bail!("{} is not a folder", path.display());
            }
            Some(path.to_string_lossy().into_owned())
        }
    };
    let title = match text("title") {
        "" => prompt.lines().next().unwrap_or(prompt).chars().take(60).collect(),
        t => t.chars().take(80).collect(),
    };
    let now = now_ms();
    let next_run = next_after(now, every, at, weekday).ok_or_else(|| anyhow::anyhow!("couldn't work out the next time"))?;
    let mut s = Schedule {
        id: 0, title, prompt: prompt.into(), agent: agent.into(), cwd, every: every.into(), at, weekday,
        enabled: true, next_run, last_run: None, last_thread: None, created_at: now,
    };
    s.id = app.db(|d| d.schedule_add(&s))?;
    let _ = app.db(|d| d.ledger_add(None, "schedule", &s.title, "added", &s.prompt));
    Ok(s)
}

pub fn set(app: &Arc<App>, id: i64, enabled: bool) -> anyhow::Result<Schedule> {
    let s = app.db(|d| d.schedule_get(id))?;
    let next = next_after(now_ms(), &s.every, s.at, s.weekday).unwrap_or(i64::MAX);
    app.db(|d| d.schedule_update(id, enabled, next))?;
    Ok(app.db(|d| d.schedule_get(id))?)
}

fn still_going(app: &App, s: &Schedule) -> bool {
    s.last_thread.as_ref().is_some_and(|t| app.busy.lock().unwrap().contains(t))
}

/// Starts one run now: a new chat with the schedule's prompt.
pub async fn run(app: &Arc<App>, s: &Schedule) -> anyhow::Result<Value> {
    if still_going(app, s) {
        bail!("The last run is still going (it may be waiting for your OK).");
    }
    let t = app.create_thread(&s.agent, &s.title, s.cwd.as_deref())?;
    app.db(|d| d.scheduled_add(&t.id, s.id))?;
    app.db(|d| d.schedule_ran(s.id, &t.id))?;
    let _ = app.db(|d| d.ledger_add(Some(&t.id), "schedule", &s.title, "started", &s.prompt));
    app.out.event("schedule.ran", json!({ "scheduleId": s.id, "threadId": t.id, "title": s.title }));
    agent::send(app.clone(), &t.id, &s.prompt, false).await?;
    Ok(json!({ "threadId": t.id }))
}

async fn run_due(app: &Arc<App>) {
    let now = now_ms();
    for s in app.db(|d| d.schedules(Some(now))).unwrap_or_default() {
        let next = next_after(now, &s.every, s.at, s.weekday).unwrap_or(i64::MAX);
        // Move the clock on first, so a run that fails isn't retried every tick.
        if app.db(|d| d.schedule_update(s.id, true, next)).is_err() {
            continue;
        }
        let skip = |why: &str| {
            let _ = app.db(|d| d.ledger_add(None, "schedule", &s.title, "skipped", why));
        };
        if now - s.next_run > LATE_OK_MS {
            skip("missed while the computer slept or Dune Bot was closed");
        } else if still_going(app, &s) {
            skip("the last run was still going (maybe waiting for your OK)");
        } else if let Err(e) = run(app, &s).await {
            let _ = app.db(|d| d.ledger_add(None, "schedule", &s.title, "failed", &format!("{e:#}")));
        }
    }
}

pub fn spawn(app: Arc<App>) {
    let tick = std::env::var("DUNEBOT_SCHEDULE_TICK_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(tick)).await;
            run_due(&app).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        let t = NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, mi, 0).unwrap();
        Local.from_local_datetime(&t).earliest().unwrap().timestamp_millis()
    }

    #[test]
    fn next_times_in_local_time() {
        // 2026-11-13 is a Friday.
        let fri_10 = local(2026, 11, 13, 10, 0);
        assert_eq!(next_after(fri_10, "daily", 9 * 60, 0), Some(local(2026, 11, 14, 9, 0)));
        assert_eq!(next_after(fri_10, "daily", 10 * 60 + 30, 0), Some(local(2026, 11, 13, 10, 30)));
        assert_eq!(next_after(fri_10, "weekdays", 9 * 60, 0), Some(local(2026, 11, 16, 9, 0)), "skips the weekend");
        assert_eq!(next_after(fri_10, "weekly", 8 * 60, 3), Some(local(2026, 11, 18, 8, 0)), "next Wednesday");
        assert_eq!(next_after(fri_10, "weekly", 11 * 60, 5), Some(local(2026, 11, 13, 11, 0)), "later the same Friday");
        assert_eq!(next_after(fri_10, "hourly", 15, 0), Some(local(2026, 11, 13, 10, 15)));
        assert_eq!(next_after(local(2026, 11, 13, 10, 15), "hourly", 15, 0), Some(local(2026, 11, 13, 11, 15)), "never the same minute twice");
        assert_eq!(next_after(fri_10, "yearly", 0, 0), None);
    }
}
