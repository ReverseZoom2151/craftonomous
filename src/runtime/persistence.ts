/**
 * The session's half of durable state.
 *
 * `src/persistence/` knows how to turn a memory and a tracker into bytes and
 * back. It does not know when to do either, and it must not: the moments that
 * matter are lifecycle moments, and the lifecycle lives here. This module is
 * the join. It owns exactly three decisions, all of which are stated in
 * comments below because each one is a choice someone could reasonably have
 * made differently: what to do with a snapshot that will not load, what to do
 * with a save that will not write, and when a save is allowed to happen at all.
 */

import type { FileStoreOptions, Snapshot } from '../persistence/index.js';
import {
  FileStore,
  applySnapshot,
  captureSnapshot,
} from '../persistence/index.js';
import type { WorldMemory } from '../perception/memory.js';
import type { ReliabilityTracker } from '../skills/reliability.js';
import type { Clock } from './clock.js';
import type { Logger } from './logger.js';

/**
 * Somewhere a snapshot can be kept.
 *
 * Bound to its location rather than taking a path per call, so a session never
 * has to hold a path it did nothing with, and so a test can hand in a store
 * that fails on purpose without going near a filesystem. `FileStore` is the
 * production implementation, reached through {@link fileSnapshotStore}.
 */
export interface SnapshotStore {
  /** Undefined means nothing has been saved yet, which is a normal first run. */
  load(): Promise<Snapshot | undefined>;
  save(snapshot: Snapshot): Promise<void>;
  /** What to call this store in a log line. A path, usually. */
  readonly label?: string;
}

/** Bind the atomic on-disk store to one path. */
export function fileSnapshotStore(
  path: string,
  options: FileStoreOptions = {},
): SnapshotStore {
  const store = new FileStore(options);
  return {
    label: path,
    load: () => store.load(path),
    save: (snapshot: Snapshot) => store.save(path, snapshot),
  };
}

/**
 * What to do when a snapshot exists but cannot be read: it is not JSON, it is
 * the wrong shape, or it declares a schema version this build does not know.
 */
export type CorruptSnapshotPolicy = 'refuse' | 'discard';

export interface PersistenceOptions {
  /** Where the snapshot is loaded from and saved to. */
  readonly store: SnapshotStore;
  /**
   * How to treat a snapshot that will not load. Defaults to `refuse`.
   *
   * Refusing is the default because a snapshot that fails to parse is not a
   * first run: something wrote that file, and whatever is in it is the only
   * copy of what the agent knew. Starting fresh would be quiet for exactly one
   * run and then permanent, because the first save of the fresh session
   * overwrites the unreadable file and the evidence goes with it. Refusing
   * costs an operator one deliberate deletion and loses nothing; discarding
   * cannot be undone. The version case pushes the same way: a file from a
   * newer build is more likely to be readable by a newer build than by a
   * deletion.
   *
   * `discard` is offered because an unattended long-running agent may
   * legitimately prefer to keep running over keeping the file. It never fails
   * quietly: it logs at error level with the reason and what was dropped, and
   * the run continues from empty.
   */
  readonly onCorrupt?: CorruptSnapshotPolicy;
  /**
   * Checkpoint automatically on this interval, in milliseconds. Off when
   * absent. The timer is unref'd and cleared on close, so it can never be the
   * reason a process stays alive.
   */
  readonly autosaveIntervalMs?: number;
  /** Cap on observations written. Defaults to the persistence layer's own. */
  readonly maxObservations?: number;
}

/** Why a save happened, carried into the log line so a trace reads clearly. */
export type SaveReason = 'close' | 'autosave' | 'checkpoint';

export interface SaveOutcome {
  readonly saved: boolean;
  /** Observations written. Zero on a failed save. */
  readonly observations: number;
  /** Skills whose evidence was written. Zero on a failed save. */
  readonly skills: number;
  /** Present when the save failed, or when there was no store to save to. */
  readonly error?: string;
}

export interface RestoreOutcome {
  /** False when there was nothing to restore, or when it was discarded. */
  readonly restored: boolean;
  readonly observations: number;
  readonly attempts: number;
  /** Present when a snapshot was found but thrown away under `discard`. */
  readonly discarded?: string;
}

const NOTHING_RESTORED: RestoreOutcome = {
  restored: false,
  observations: 0,
  attempts: 0,
};

/**
 * Loads at the start of a session and saves at the end of it.
 *
 * Everything this class touches is live state, never a copy taken earlier. That
 * is the property the reconnect path depends on: a reconnect clears world
 * memory, and a save that wrote a snapshot captured before the clear would put
 * the forgotten world straight back on disk, undoing the forgetting at the only
 * point where it was supposed to become permanent. Capturing at save time, from
 * the same memory the reconnect emptied, makes that impossible by construction
 * rather than by ordering luck.
 */
export class SessionPersistence {
  readonly #memory: WorldMemory;
  readonly #reliability: ReliabilityTracker;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #store: SnapshotStore;
  readonly #onCorrupt: CorruptSnapshotPolicy;
  readonly #autosaveIntervalMs: number | undefined;
  readonly #maxObservations: number | undefined;

  #timer: ReturnType<typeof setInterval> | undefined;
  /** Serialises saves, so an autosave and a close cannot interleave writes. */
  #queue: Promise<unknown> = Promise.resolve();
  /**
   * Saving is refused until a restore has succeeded. Without this a session
   * that refused to start because its snapshot was unreadable would overwrite
   * that same unreadable snapshot on its way out, which is precisely the loss
   * refusing to start exists to prevent.
   */
  #armed = false;

  constructor(
    memory: WorldMemory,
    reliability: ReliabilityTracker,
    clock: Clock,
    log: Logger,
    options: PersistenceOptions,
  ) {
    this.#memory = memory;
    this.#reliability = reliability;
    this.#clock = clock;
    this.#log = log;
    this.#store = options.store;
    this.#onCorrupt = options.onCorrupt ?? 'refuse';
    this.#autosaveIntervalMs = options.autosaveIntervalMs;
    this.#maxObservations = options.maxObservations;
  }

  /** Where this session's snapshot lives, for a log line or an error. */
  get label(): string {
    return this.#store.label ?? 'snapshot';
  }

  /**
   * Read the snapshot and hand it to memory and the tracker.
   *
   * Throws only under the `refuse` policy, and only for a file that exists and
   * will not load. A missing file is the ordinary first run and returns an
   * empty outcome.
   */
  async restore(): Promise<RestoreOutcome> {
    let snapshot: Snapshot | undefined;
    try {
      snapshot = await this.#store.load();
    } catch (error) {
      const reason = messageOf(error);
      if (this.#onCorrupt === 'refuse') {
        this.#log.error('snapshot could not be read, refusing to start', {
          store: this.label,
          error: reason,
        });
        throw error;
      }
      // Loud, and specific about what is gone. An operator reading this line
      // must not have to guess whether the run started empty on purpose.
      this.#log.error('snapshot discarded, starting with an empty memory', {
        store: this.label,
        error: reason,
      });
      this.#armed = true;
      return { ...NOTHING_RESTORED, discarded: reason };
    }

    this.#armed = true;
    if (snapshot === undefined) {
      this.#log.info('no snapshot found, starting fresh', { store: this.label });
      return NOTHING_RESTORED;
    }

    const result = applySnapshot(this.#memory, this.#reliability, snapshot);
    this.#log.info('snapshot restored', {
      store: this.label,
      savedAt: snapshot.savedAt,
      observations: result.observations,
      attempts: result.attempts,
    });
    return {
      restored: true,
      observations: result.observations,
      attempts: result.attempts,
    };
  }

  /**
   * Capture the current state and write it.
   *
   * This never throws, and that is deliberate. A snapshot is a copy of what a
   * run produced; the run is the thing that produced it. A full disk, a
   * read-only mount or a directory someone moved is a real problem worth
   * shouting about, but killing a session that is otherwise healthy turns a
   * lost checkpoint into a lost run plus a lost checkpoint. The failure is
   * logged at error level and returned in the outcome, so a caller that does
   * want to treat it as fatal has everything it needs to decide that itself.
   */
  save(reason: SaveReason): Promise<SaveOutcome> {
    const run = (): Promise<SaveOutcome> => this.#saveNow(reason);
    // Chained through both settlements so one failure cannot wedge the queue.
    const next = this.#queue.then(run, run);
    this.#queue = next;
    return next;
  }

  /** Begin autosaving, when an interval was configured. */
  startAutosave(): void {
    const interval = this.#autosaveIntervalMs;
    if (interval === undefined || this.#timer !== undefined) return;
    if (!(interval > 0)) {
      throw new RangeError(
        `autosaveIntervalMs must be positive, got ${interval}`,
      );
    }
    const timer = setInterval(() => {
      void this.save('autosave');
    }, interval);
    // A checkpoint timer must never hold the process open.
    timer.unref?.();
    this.#timer = timer;
  }

  stopAutosave(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #saveNow(reason: SaveReason): Promise<SaveOutcome> {
    if (!this.#armed) {
      return {
        saved: false,
        observations: 0,
        skills: 0,
        error: 'no snapshot has been loaded, so none may be written',
      };
    }
    try {
      const snapshot = captureSnapshot(this.#memory, this.#reliability, {
        savedAt: this.#clock.now(),
        ...(this.#maxObservations === undefined
          ? {}
          : { maxObservations: this.#maxObservations }),
      });
      await this.#store.save(snapshot);
      const observations = snapshot.memory.observations.length;
      const skills = snapshot.reliability.skills.length;
      this.#log.info('snapshot saved', {
        store: this.label,
        reason,
        observations,
        skills,
      });
      return { saved: true, observations, skills };
    } catch (error) {
      const message = messageOf(error);
      this.#log.error('snapshot could not be saved, the run continues', {
        store: this.label,
        reason,
        error: message,
      });
      return { saved: false, observations: 0, skills: 0, error: message };
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
