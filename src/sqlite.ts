import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Read-only SQLite access for the OpenCode and CloudCLI databases. Prefers the
// built-in `node:sqlite` (Node ≥ 22.5); on older runtimes it falls back to the
// `better-sqlite3` copy CloudCLI itself ships, so the plugin needs no native
// dependency of its own.

const require = createRequire(import.meta.url);

export interface ReadOnlyDb {
  prepare(sql: string): { get(...params: unknown[]): any; all(...params: unknown[]): any[] };
  exec(sql: string): void;
  close(): void;
}

/** node_modules directories of a globally installed or checked-out CloudCLI host. */
function hostModuleRoots(): string[] {
  const prefix = path.resolve(path.dirname(process.execPath), '..');
  const home = process.env.HOME || os.homedir();
  return [
    path.join(prefix, 'lib', 'node_modules', '@cloudcli-ai', 'cloudcli', 'node_modules'),
    path.join(prefix, 'node_modules', '@cloudcli-ai', 'cloudcli', 'node_modules'),
    path.join('/usr', 'lib', 'node_modules', '@cloudcli-ai', 'cloudcli', 'node_modules'),
    path.join('/usr', 'local', 'lib', 'node_modules', '@cloudcli-ai', 'cloudcli', 'node_modules'),
    path.join(home, 'claudecodeui', 'node_modules'),
    path.join(home, 'cloudcli', 'claudecodeui', 'node_modules'),
  ];
}

type Driver = (file: string) => ReadOnlyDb;
let driver: Driver | null | undefined;

function loadDriver(): Driver | null {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return (file) => new DatabaseSync(file, { readOnly: true });
  } catch {
    /* Node < 22.5 */
  }
  for (const root of hostModuleRoots()) {
    const candidate = path.join(root, 'better-sqlite3');
    if (!fs.existsSync(candidate)) continue;
    try {
      const Database = require(candidate);
      return (file) => new Database(file, { readonly: true, fileMustExist: true });
    } catch {
      /* binding built for another Node version */
    }
  }
  return null;
}

/** Opens `file` read-only; throws when no SQLite driver is available. */
export function openReadOnly(file: string): ReadOnlyDb {
  if (driver === undefined) driver = loadDriver();
  if (!driver) {
    throw new Error(`No SQLite driver: needs Node ≥ 22.5 (running ${process.version}) or CloudCLI's better-sqlite3`);
  }
  const db = driver(file);
  try {
    db.exec('PRAGMA busy_timeout = 2000');
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
