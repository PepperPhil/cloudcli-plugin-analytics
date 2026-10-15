import fs from 'node:fs';
import { createRequire } from 'node:module';

// CloudCLI hands plugins its own app session id, which differs from the id the
// tool uses on disk (Claude JSONL name, OpenCode `ses_…`). Its `sessions` table
// maps one to the other; `superseded_provider_sessions` keeps the ids a Claude
// session had before a resume moved it onto a new one.

const require = createRequire(import.meta.url);

export class CloudCliSessions {
  private db: any = null;

  constructor(readonly dbPath: string) {}

  private open(): any {
    if (this.db) return this.db;
    if (!fs.existsSync(this.dbPath)) return null;
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(this.dbPath, { readOnly: true });
    this.db.exec('PRAGMA busy_timeout = 2000');
    return this.db;
  }

  /**
   * Every id the given session is known by in the tools' own data. Accepts an
   * app id or a provider id; falls back to the id itself when CloudCLI's
   * database is missing or unreadable.
   */
  resolve(id: string): string[] {
    const ids = new Set([id]);
    try {
      const db = this.open();
      if (!db) return [...ids];
      const row = db
        .prepare('SELECT session_id, provider_session_id FROM sessions WHERE session_id = ? OR provider_session_id = ? LIMIT 1')
        .get(id, id) as { session_id: string; provider_session_id: string | null } | undefined;
      if (!row) return [...ids];
      if (row.provider_session_id) ids.add(row.provider_session_id);
      const superseded = db
        .prepare('SELECT provider_session_id FROM superseded_provider_sessions WHERE session_id = ?')
        .all(row.session_id) as { provider_session_id: string }[];
      for (const s of superseded) ids.add(s.provider_session_id);
    } catch {
      // Schema drift or a locked file: drop the handle so the next call retries.
      try {
        this.db?.close();
      } catch {
        /* already closed */
      }
      this.db = null;
    }
    return [...ids];
  }
}
