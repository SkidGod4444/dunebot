//! Local SQLite store: chats, messages, settings and the action ledger.

use std::{path::Path, time::UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub title: String,
    pub agent: String,
    pub cwd: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub preview: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub text: String,
    pub meta: Value,
    pub created_at: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRow {
    pub id: i64,
    pub thread_id: Option<String>,
    pub action: String,
    pub target: String,
    pub decision: String,
    pub detail: String,
    pub at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: i64,
    pub path: String,
    pub backup: Option<String>,
    pub written_sha256: String,
    pub at: i64,
}

/// A failure and the user's fix for it. Agents read fixes as notes; a fix never changes what
/// Dune Bot allows (the gate reads settings only).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fix {
    pub id: i64,
    pub thread_id: Option<String>,
    pub failure: String,
    /// What the step printed, for the Fixes page only (agents aren't given it).
    pub detail: Option<String>,
    pub fix: String,
    pub created_at: i64,
    pub enabled: bool,
}

/// A prompt that starts a new chat at set times. `at` is minutes after midnight (local time);
/// `weekday` is 0 = Sunday … 6 = Saturday, used when `every` is "weekly".
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: i64,
    pub title: String,
    pub prompt: String,
    pub agent: String,
    pub cwd: Option<String>,
    pub every: String,
    pub at: i64,
    pub weekday: i64,
    pub enabled: bool,
    pub next_run: i64,
    pub last_run: Option<i64>,
    pub last_thread: Option<String>,
    pub created_at: i64,
}

pub struct Store {
    conn: Connection,
}

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS threads(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL, cwd TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, preview TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, action TEXT NOT NULL, target TEXT NOT NULL,
  decision TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
-- Every file an agent wrote: the copy kept of what was there (none for a new file) and a hash of
-- what was written, so the chat's changes can be undone unless the file changed since.
CREATE TABLE IF NOT EXISTS changes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, path TEXT NOT NULL, backup TEXT,
  written_sha256 TEXT NOT NULL, at INTEGER NOT NULL, undone_at INTEGER);
CREATE INDEX IF NOT EXISTS changes_thread ON changes(thread_id, id);
CREATE TABLE IF NOT EXISTS schedules(
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, prompt TEXT NOT NULL, agent TEXT NOT NULL,
  cwd TEXT, every TEXT NOT NULL, at INTEGER NOT NULL, weekday INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1, next_run INTEGER NOT NULL, last_run INTEGER, last_thread TEXT,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scheduled_chats(thread_id TEXT PRIMARY KEY, schedule_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fixes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, failure TEXT NOT NULL, fix TEXT NOT NULL,
  created_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
";

/// Whatever was in flight when Dune Bot last closed can't finish now; say so instead of spinning.
const RECOVER: &str = "
UPDATE messages SET meta = json_set(meta, '$.status', 'expired')
  WHERE role = 'approval' AND json_extract(meta, '$.status') = 'pending';
UPDATE messages SET meta = json_set(meta, '$.status', 'failed', '$.output', 'Dune Bot closed before this finished.')
  WHERE role = 'tool' AND json_extract(meta, '$.status') = 'running';
UPDATE messages SET meta = json_set(meta, '$.status', 'done')
  WHERE role = 'assistant' AND json_extract(meta, '$.status') = 'streaming';
";

fn thread_row(r: &Row) -> rusqlite::Result<Thread> {
    Ok(Thread {
        id: r.get(0)?,
        title: r.get(1)?,
        agent: r.get(2)?,
        cwd: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        preview: r.get(6)?,
    })
}

fn message_row(r: &Row) -> rusqlite::Result<Message> {
    let meta: String = r.get(4)?;
    Ok(Message {
        id: r.get(0)?,
        thread_id: r.get(1)?,
        role: r.get(2)?,
        text: r.get(3)?,
        meta: serde_json::from_str(&meta).unwrap_or(Value::Null),
        created_at: r.get(5)?,
    })
}

const THREAD_COLS: &str = "id, title, agent, cwd, created_at, updated_at, preview";

impl Store {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        // Columns added after a table first shipped (additive only).
        if !conn.prepare("SELECT 1 FROM pragma_table_info('fixes') WHERE name = 'detail'")?.exists([])? {
            conn.execute_batch("ALTER TABLE fixes ADD COLUMN detail TEXT")?;
        }
        conn.execute_batch(RECOVER)?;
        Ok(Self { conn })
    }

    pub fn create_thread(&self, t: &Thread) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO threads(id, title, agent, cwd, created_at, updated_at, preview) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![t.id, t.title, t.agent, t.cwd, t.created_at, t.updated_at, t.preview],
        )?;
        Ok(())
    }

    pub fn list_threads(&self) -> rusqlite::Result<Vec<Thread>> {
        let mut st = self
            .conn
            .prepare(&format!("SELECT {THREAD_COLS} FROM threads ORDER BY updated_at DESC"))?;
        let rows = st.query_map([], thread_row)?;
        rows.collect()
    }

    pub fn get_thread(&self, id: &str) -> rusqlite::Result<Thread> {
        self.conn.query_row(
            &format!("SELECT {THREAD_COLS} FROM threads WHERE id = ?1"),
            [id],
            thread_row,
        )
    }

    pub fn update_thread(&self, id: &str, title: Option<&str>, preview: Option<&str>) -> rusqlite::Result<()> {
        if let Some(title) = title {
            self.conn.execute("UPDATE threads SET title = ?2 WHERE id = ?1", params![id, title])?;
        }
        if let Some(preview) = preview {
            self.conn.execute("UPDATE threads SET preview = ?2 WHERE id = ?1", params![id, preview])?;
        }
        self.conn.execute("UPDATE threads SET updated_at = ?2 WHERE id = ?1", params![id, now_ms()])?;
        Ok(())
    }

    pub fn delete_thread(&self, id: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM messages WHERE thread_id = ?1", [id])?;
        self.conn.execute("DELETE FROM threads WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn add_message(&self, m: &Message) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO messages(id, thread_id, role, text, meta, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![m.id, m.thread_id, m.role, m.text, m.meta.to_string(), m.created_at],
        )?;
        Ok(())
    }

    pub fn set_message(&self, id: &str, text: &str, meta: &Value) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE messages SET text = ?2, meta = ?3 WHERE id = ?1",
            params![id, text, meta.to_string()],
        )?;
        Ok(())
    }

    pub fn get_message(&self, id: &str) -> rusqlite::Result<Message> {
        self.conn.query_row(
            "SELECT id, thread_id, role, text, meta, created_at FROM messages WHERE id = ?1",
            [id],
            message_row,
        )
    }

    pub fn messages(&self, thread_id: &str) -> rusqlite::Result<Vec<Message>> {
        let mut st = self.conn.prepare(
            "SELECT id, thread_id, role, text, meta, created_at FROM messages WHERE thread_id = ?1 ORDER BY created_at, rowid",
        )?;
        let rows = st.query_map([thread_id], message_row)?;
        rows.collect()
    }

    /// Said messages (yours and the agents' replies, never tool output) containing every word,
    /// newest first, from chats other than `exclude`, since `since` (ms). With the chat's title.
    pub fn search_messages(&self, words: &[String], since: i64, exclude: &str, limit: i64) -> rusqlite::Result<Vec<(Message, String, String)>> {
        use rusqlite::types::Value as V;
        let mut sql = String::from(
            "SELECT m.id, m.thread_id, m.role, m.text, m.meta, m.created_at, t.title, t.agent FROM messages m \
             JOIN threads t ON t.id = m.thread_id \
             WHERE m.role IN ('user', 'assistant') AND m.thread_id != ?1 AND m.created_at >= ?2",
        );
        let mut params: Vec<V> = vec![V::Text(exclude.to_string()), V::Integer(since)];
        for w in words {
            params.push(V::Text(format!("%{}%", w.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))));
            sql.push_str(&format!(" AND m.text LIKE ?{} ESCAPE '\\'", params.len()));
        }
        params.push(V::Integer(limit));
        sql.push_str(&format!(" ORDER BY m.created_at DESC LIMIT ?{}", params.len()));
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(rusqlite::params_from_iter(params), |r| Ok((message_row(r)?, r.get(6)?, r.get(7)?)))?;
        rows.collect()
    }

    pub fn get_setting(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .optional()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn ledger_add(
        &self,
        thread_id: Option<&str>,
        action: &str,
        target: &str,
        decision: &str,
        detail: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO ledger(thread_id, action, target, decision, detail, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![thread_id, action, target, decision, detail, now_ms()],
        )?;
        Ok(())
    }

    pub fn change_add(&self, thread_id: &str, path: &str, backup: Option<&str>, sha256: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO changes(thread_id, path, backup, written_sha256, at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![thread_id, path, backup, sha256, now_ms()],
        )?;
        Ok(())
    }

    /// The chat's file changes not undone yet, newest first.
    pub fn changes_open(&self, thread_id: &str) -> rusqlite::Result<Vec<Change>> {
        let mut st = self.conn.prepare(
            "SELECT id, path, backup, written_sha256, at FROM changes WHERE thread_id = ?1 AND undone_at IS NULL ORDER BY id DESC",
        )?;
        let rows = st.query_map([thread_id], |r| {
            Ok(Change { id: r.get(0)?, path: r.get(1)?, backup: r.get(2)?, written_sha256: r.get(3)?, at: r.get(4)? })
        })?;
        rows.collect()
    }

    pub fn change_undone(&self, id: i64) -> rusqlite::Result<()> {
        self.conn.execute("UPDATE changes SET undone_at = ?2 WHERE id = ?1", params![id, now_ms()])?;
        Ok(())
    }

    pub fn fix_add(&self, thread_id: Option<&str>, failure: &str, detail: Option<&str>, fix: &str) -> rusqlite::Result<Fix> {
        let at = now_ms();
        self.conn.execute(
            "INSERT INTO fixes(thread_id, failure, detail, fix, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![thread_id, failure, detail, fix, at],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(Fix {
            id,
            thread_id: thread_id.map(String::from),
            failure: failure.into(),
            detail: detail.map(String::from),
            fix: fix.into(),
            created_at: at,
            enabled: true,
        })
    }

    /// Chats a schedule started: they ask before commands and file changes even when set to Always.
    pub fn scheduled_add(&self, thread_id: &str, schedule_id: i64) -> rusqlite::Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO scheduled_chats(thread_id, schedule_id) VALUES (?1, ?2)", params![thread_id, schedule_id])?;
        Ok(())
    }

    pub fn is_scheduled(&self, thread_id: &str) -> rusqlite::Result<bool> {
        self.conn.prepare("SELECT 1 FROM scheduled_chats WHERE thread_id = ?1")?.exists([thread_id])
    }

    /// Every fix, newest first; or (with `after`) the switched-on ones made after that id, oldest first.
    pub fn fixes(&self, after: Option<i64>) -> rusqlite::Result<Vec<Fix>> {
        let sql = match after {
            None => "SELECT id, thread_id, failure, fix, created_at, enabled, detail FROM fixes WHERE ?1 IS NULL ORDER BY id DESC",
            Some(_) => "SELECT id, thread_id, failure, fix, created_at, enabled, detail FROM fixes WHERE enabled = 1 AND id > ?1 ORDER BY id",
        };
        let mut st = self.conn.prepare(sql)?;
        let rows = st.query_map(params![after], |r| {
            Ok(Fix {
                id: r.get(0)?,
                thread_id: r.get(1)?,
                failure: r.get(2)?,
                fix: r.get(3)?,
                created_at: r.get(4)?,
                enabled: r.get::<_, i64>(5)? != 0,
                detail: r.get(6)?,
            })
        })?;
        rows.collect()
    }

    pub fn fix_set(&self, id: i64, enabled: bool) -> rusqlite::Result<()> {
        self.conn.execute("UPDATE fixes SET enabled = ?2 WHERE id = ?1", params![id, enabled as i64])?;
        Ok(())
    }

    pub fn fix_delete(&self, id: i64) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM fixes WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn schedule_add(&self, s: &Schedule) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO schedules(title, prompt, agent, cwd, every, at, weekday, next_run, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![s.title, s.prompt, s.agent, s.cwd, s.every, s.at, s.weekday, s.next_run, s.created_at],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// All schedules (oldest first), or with `due` only the switched-on ones due by then.
    pub fn schedules(&self, due: Option<i64>) -> rusqlite::Result<Vec<Schedule>> {
        let mut st = self.conn.prepare(
            "SELECT id, title, prompt, agent, cwd, every, at, weekday, enabled, next_run, last_run, last_thread, created_at
             FROM schedules WHERE ?1 IS NULL OR (enabled = 1 AND next_run <= ?1) ORDER BY id",
        )?;
        let rows = st.query_map(params![due], |r| {
            Ok(Schedule {
                id: r.get(0)?,
                title: r.get(1)?,
                prompt: r.get(2)?,
                agent: r.get(3)?,
                cwd: r.get(4)?,
                every: r.get(5)?,
                at: r.get(6)?,
                weekday: r.get(7)?,
                enabled: r.get::<_, i64>(8)? != 0,
                next_run: r.get(9)?,
                last_run: r.get(10)?,
                last_thread: r.get(11)?,
                created_at: r.get(12)?,
            })
        })?;
        rows.collect()
    }

    pub fn schedule_get(&self, id: i64) -> rusqlite::Result<Schedule> {
        self.schedules(None)?.into_iter().find(|s| s.id == id).ok_or(rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn schedule_update(&self, id: i64, enabled: bool, next_run: i64) -> rusqlite::Result<()> {
        self.conn.execute("UPDATE schedules SET enabled = ?2, next_run = ?3 WHERE id = ?1", params![id, enabled as i64, next_run])?;
        Ok(())
    }

    pub fn schedule_ran(&self, id: i64, thread_id: &str) -> rusqlite::Result<()> {
        self.conn.execute("UPDATE schedules SET last_run = ?2, last_thread = ?3 WHERE id = ?1", params![id, now_ms(), thread_id])?;
        Ok(())
    }

    pub fn schedule_delete(&self, id: i64) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM schedules WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn ledger_list(&self, limit: i64) -> rusqlite::Result<Vec<LedgerRow>> {
        let mut st = self.conn.prepare(
            "SELECT id, thread_id, action, target, decision, detail, at FROM ledger ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = st.query_map([limit], |r| {
            Ok(LedgerRow {
                id: r.get(0)?,
                thread_id: r.get(1)?,
                action: r.get(2)?,
                target: r.get(3)?,
                decision: r.get(4)?,
                detail: r.get(5)?,
                at: r.get(6)?,
            })
        })?;
        rows.collect()
    }
}
