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
 * Wraps better-sqlite3 Statement to call `finalize()` immediately after
 * execution, freeing native sqlite3_stmt memory deterministically instead
 * of waiting for GC. Fixes steady off-heap growth under load (#2120).
 * WARNING: Finalizes after first execution — incompatible with drizzle's
 * reusable .prepare() builders. No such usage exists in this codebase.
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
                    // finalize() exists on the native Statement at runtime but
                    // is missing from @types/better-sqlite3.
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
        // Enable WAL mode — allows concurrent readers + single writer, preventing
        // contention across subsystems (verifySession, Traefik, audit, ping).
        sqlite.pragma("journal_mode = WAL");
        // NORMAL sync mode: safe with WAL, reduces write lock hold time.
        sqlite.pragma("synchronous = NORMAL");

        // 256 MB memory-mapped I/O — OS serves reads from page cache directly,
        // reducing event-loop blocking. Full benefit in WAL mode where mmap'd
        // reads are never blocked by writers.
        sqlite.pragma("mmap_size = 268435456");
    } else {
        // 128 MB memory-mapped I/O for DELETE journal mode. Reduced from 256 MB
        // because mmap'd reads can still be blocked by writers holding the
        // exclusive lock, so the concurrency benefit is diminished while the
        // virtual address space reservation remains.
        sqlite.pragma("mmap_size = 134217728");
    }

    // Wait up to 5s on SQLITE_BUSY instead of failing — prevents audit log
    // retry loops that accumulate memory.
    sqlite.pragma("busy_timeout = 5000");

    // 64 MB page cache (default 2 MB) — reduces I/O round-trips on large
    // TraefikConfigManager JOINs that block the event loop.
    sqlite.pragma("cache_size = -65536");

    // Wrap prepare() so every drizzle-orm statement is auto-finalized after
    // first use, preventing sqlite3_stmt accumulation between GC cycles.
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
