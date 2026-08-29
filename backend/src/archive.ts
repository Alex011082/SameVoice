import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { CALL_ID_RE, type Call } from "./types.js";

/**
 * Where finished calls go.
 *
 * An ended call is over immediately, but it is not garbage: it is the record of
 * a conversation two people had, and transcripts and playback are meant to be
 * built on top of it. So the sweeper does not delete anything — after a short
 * window an ended call leaves the live map and lands here, one JSON file per
 * call.
 *
 * On disk rather than in another Map, for two reasons that the 25.08.2026
 * incident made concrete: the backend is restarted often (that restart is what
 * cleared the stale call), and an archive that a `systemctl restart` empties is
 * not an archive. The eval log the agent writes per call
 * (`logs/calls/<callId>.jsonl`) is the other half of the record and joins to
 * this one by call id.
 *
 * Access is by participant. The backend has no sessions or tokens — every route
 * takes the acting userId and checks it against the call — and the archive uses
 * exactly that rule, no weaker: a call is readable only by the two people who
 * were on it.
 */

declare module "fastify" {
  interface FastifyInstance {
    /** The one archive this process writes to. Decorated in buildApp(). */
    callArchive: CallArchive;
  }
}

export interface ArchivedCall {
  call: Call;
  /** ISO-8601. When the record left memory, NOT when the call ended. */
  archivedAt: string;
}

/** What a listing shows without opening the file. */
export interface ArchiveEntry {
  callId: string;
  createdAt: string;
  endedAt: string | null;
  archivedAt: string;
  mode: Call["mode"];
  participants: Call["participants"];
}

export interface CallArchive {
  /** (Re)read the index from disk. Safe to call on a missing directory, and to repeat. */
  load(): Promise<void>;
  /** Store one finished call. False means it is NOT safely stored — keep it in memory. */
  put(call: Call): Promise<boolean>;
  /** One record, or undefined when this user was not on that call. */
  get(callId: string, userId: string): Promise<ArchivedCall | undefined>;
  /** Everything this user was on, newest first. */
  listFor(userId: string): ArchiveEntry[];
  size(): number;
}

function entryOf(record: ArchivedCall): ArchiveEntry {
  return {
    callId: record.call.id,
    createdAt: record.call.createdAt,
    endedAt: record.call.endedAt,
    archivedAt: record.archivedAt,
    mode: record.call.mode,
    participants: record.call.participants,
  };
}

function wasOnTheCall(entry: ArchiveEntry, userId: string): boolean {
  return entry.participants.some((p) => p.userId === userId);
}

/**
 * `dir` is created on first write. The index in memory holds only the listing
 * fields; the full record is read from its file on demand, so the process does
 * not carry every call it has ever handled.
 */
export function createCallArchive(dir: string, log?: FastifyBaseLogger): CallArchive {
  const index = new Map<string, ArchiveEntry>();

  function fileFor(callId: string): string {
    return join(dir, `${callId}.json`);
  }

  async function readRecord(callId: string): Promise<ArchivedCall | undefined> {
    try {
      const raw = await readFile(fileFor(callId), "utf8");
      return JSON.parse(raw) as ArchivedCall;
    } catch (err) {
      log?.warn({ callId, err }, "archived call could not be read");
      return undefined;
    }
  }

  return {
    async load(): Promise<void> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        // No archive yet. The first put() creates it.
        return;
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const callId = name.slice(0, -".json".length);
        // The directory is ours, but a stray file must not become a route.
        if (!CALL_ID_RE.test(callId)) continue;
        const record = await readRecord(callId);
        if (record !== undefined) index.set(callId, entryOf(record));
      }
      log?.info({ dir, calls: index.size }, "call archive loaded");
    },

    async put(call: Call): Promise<boolean> {
      const record: ArchivedCall = { call, archivedAt: new Date().toISOString() };
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(fileFor(call.id), `${JSON.stringify(record, null, 2)}\n`, "utf8");
      } catch (err) {
        // Reporting the failure is the point: the caller keeps the call in
        // memory rather than dropping a record nobody wrote down.
        log?.error({ callId: call.id, dir, err }, "could not archive call");
        return false;
      }
      index.set(call.id, entryOf(record));
      return true;
    },

    async get(callId: string, userId: string): Promise<ArchivedCall | undefined> {
      const entry = index.get(callId);
      if (entry === undefined || !wasOnTheCall(entry, userId)) return undefined;
      const record = await readRecord(callId);
      if (record === undefined) return undefined;
      // The file is the source of truth; the index is only a listing cache.
      return wasOnTheCall(entryOf(record), userId) ? record : undefined;
    },

    listFor(userId: string): ArchiveEntry[] {
      return [...index.values()]
        .filter((entry) => wasOnTheCall(entry, userId))
        .sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt));
    },

    size(): number {
      return index.size;
    },
  };
}
