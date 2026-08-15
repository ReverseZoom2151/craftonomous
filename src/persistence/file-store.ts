/**
 * A snapshot file on disk, written so that a crash cannot poison the next
 * start.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PersistenceError, SnapshotFormatError } from './errors.js';
import type { Snapshot } from './snapshot.js';
import { decodeSnapshot } from './snapshot.js';

export interface FileStoreOptions {
  /**
   * How many times a rename may be retried when the destination is
   * momentarily locked. See {@link FileStore.save}.
   */
  readonly renameAttempts?: number;
  /** Base backoff between rename attempts, in milliseconds. */
  readonly renameBackoffMs?: number;
  /**
   * Pretty-print the JSON. Off by default: snapshots are machine-written and
   * machine-read, and indentation roughly doubles a large file.
   */
  readonly pretty?: boolean;
}

const DEFAULT_RENAME_ATTEMPTS = 5;
const DEFAULT_RENAME_BACKOFF_MS = 10;

/** Errors that mean "someone else is holding the file, try again shortly". */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);

export class FileStore {
  readonly #renameAttempts: number;
  readonly #renameBackoffMs: number;
  readonly #pretty: boolean;

  constructor(options: FileStoreOptions = {}) {
    this.#renameAttempts = options.renameAttempts ?? DEFAULT_RENAME_ATTEMPTS;
    this.#renameBackoffMs = options.renameBackoffMs ?? DEFAULT_RENAME_BACKOFF_MS;
    this.#pretty = options.pretty ?? false;
    if (this.#renameAttempts < 1) {
      throw new RangeError(
        `renameAttempts must be at least 1, got ${this.#renameAttempts}`,
      );
    }
  }

  /**
   * Write a snapshot atomically.
   *
   * The payload goes to a uniquely named temporary file in the same directory,
   * is flushed to the device, and only then replaces the target by rename.
   * Same directory matters: rename is only atomic within a filesystem, and a
   * temporary file elsewhere would degrade into a copy.
   *
   * Windows differs from POSIX here in two ways that this method handles.
   * First, Node's rename maps to MoveFileEx with MOVEFILE_REPLACE_EXISTING, so
   * replacing an existing destination does work, but only for a plain file.
   * Second, the destination can be transiently locked by a virus scanner, a
   * search indexer, or a reader that has not closed yet, which surfaces as
   * EPERM or EBUSY rather than as success. Those are retried with a short
   * backoff instead of being reported as corruption. If every attempt fails,
   * the temporary file is removed, so a failed save leaves the previous good
   * snapshot in place and no debris beside it.
   */
  async save(path: string, snapshot: Snapshot): Promise<void> {
    let json: string;
    try {
      json = this.#pretty
        ? JSON.stringify(snapshot, null, 2)
        : JSON.stringify(snapshot);
    } catch (error) {
      // Nothing has been written yet, so the previous snapshot is untouched.
      throw new PersistenceError(
        `Snapshot for ${path} could not be serialised to JSON: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        path,
      );
    }

    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const temporary = join(
      directory,
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(json, 'utf8');
        // Flush before the rename. Without this the rename can land while the
        // contents are still in the page cache, which on a power loss yields
        // an entry pointing at an empty file: exactly the corrupt snapshot the
        // temporary file was meant to prevent.
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#renameWithRetry(temporary, path);
    } catch (error) {
      await discard(temporary);
      throw error;
    }
  }

  /**
   * Read a snapshot back.
   *
   * A missing file yields undefined rather than an error: the first run of an
   * agent has no snapshot, and that is the normal case, not a fault.
   */
  async load(path: string): Promise<Snapshot | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (error) {
      throw new SnapshotFormatError(
        path,
        `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return decodeSnapshot(raw, path);
  }

  async #renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(from, to);
        return;
      } catch (error) {
        const code = errorCode(error);
        const retryable = code !== undefined && TRANSIENT_RENAME_CODES.has(code);
        if (!retryable || attempt >= this.#renameAttempts) throw error;
        await delay(this.#renameBackoffMs * attempt);
      }
    }
  }
}

/** Best-effort cleanup. A leftover temporary must not mask the real failure. */
async function discard(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already gone, or not ours to remove. Nothing useful to do either way.
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
