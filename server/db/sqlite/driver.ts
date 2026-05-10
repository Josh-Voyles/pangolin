import { drizzle as DrizzleSqlite } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import * as schema from "./schema/schema";
import path from "path";
import fs from "fs";
import { APP_PATH } from "@server/lib/consts";
import { existsSync, mkdirSync } from "fs";

export const location = path.join(APP_PATH, "db", "db.sqlite");
export const exists = checkFileExists(location);

bootstrapVolume();

/**
 * Calls finalize() after execution — frees native memory without waiting for GC.
 * Fixes off-heap growth under load (#2120).
 * WARNING: Statement unusable after first exec. Drizzle doesn't reuse prepared statements.
 */
function autoFinalizeStatement(
    stmt: BetterSqlite3.Statement
): BetterSqlite3.Statement {
    const wrapExec = <T extends (...args: any[]) => any>(fn: T): T => {
        return function (this: any, ...args: any[]) {
            try {
                return fn.apply(this, args);
            } finally {
                try {
                    // Not in @types/better-sqlite3 but exists at runtime
                    (stmt as any).finalize();
                } catch {
                    // Already finalized — harmless
                }
            }
        } as unknown as T;
    };

    stmt.run = wrapExec(stmt.run);
    stmt.get = wrapExec(stmt.get);
    stmt.all = wrapExec(stmt.all);

    return stmt;
}

function createDb() {
    const sqlite = new Database(location);

    if (process.env.ENABLE_SQLITE_WAL_MODE == "true") {
        // WAL: concurrent readers + single writer
        sqlite.pragma("journal_mode = WAL");
        sqlite.pragma("synchronous = NORMAL");

        // 256 MB mmap — reads served from page cache, never blocked by writers
        sqlite.pragma("mmap_size = 268435456");
    } else {
        // 128 MB mmap — reduced benefit in DELETE mode (readers blocked by writers)
        sqlite.pragma("mmap_size = 134217728");
    }

    // 5s busy timeout — prevents immediate SQLITE_BUSY failures
    sqlite.pragma("busy_timeout = 5000");

    // 64 MB page cache (default 2 MB) — fewer I/O round-trips on large JOINs
    sqlite.pragma("cache_size = -65536");

    // Auto-finalize every prepared statement after first use
    const originalPrepare = sqlite.prepare.bind(sqlite);
    (sqlite as any).prepare = function autoFinalizePrepare(source: string) {
        return autoFinalizeStatement(originalPrepare(source));
    };

    return DrizzleSqlite(sqlite, {
        schema
    });
}

export const db = createDb();
export default db;
export const primaryDb = db;
export type Transaction = Parameters<
    Parameters<(typeof db)["transaction"]>[0]
>[0];
export const DB_TYPE: "pg" | "sqlite" = "sqlite";

function checkFileExists(filePath: string): boolean {
    try {
        fs.accessSync(filePath);
        return true;
    } catch {
        return false;
    }
}

function bootstrapVolume() {
    const appPath = APP_PATH;

    const dbDir = path.join(appPath, "db");
    const logsDir = path.join(appPath, "logs");

    // check if the db directory exists and create it if it doesn't
    if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
    }

    // check if the logs directory exists and create it if it doesn't
    if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true });
    }

    // THIS IS FOR TRAEFIK; NOT REALLY NEEDED, BUT JUST IN CASE

    const traefikDir = path.join(appPath, "traefik");

    // check if the traefik directory exists and create it if it doesn't
    if (!existsSync(traefikDir)) {
        mkdirSync(traefikDir, { recursive: true });
    }
}
