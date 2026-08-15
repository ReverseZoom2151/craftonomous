/**
 * Failures that can happen while reading persisted state.
 *
 * Every one of these names the file it came from. A restart that cannot read
 * its own memory must say which file it choked on, otherwise the operator is
 * left guessing between several snapshot paths.
 */

/** Base class, so a caller can catch every persistence failure at once. */
export class PersistenceError extends Error {
  /** The file, or a caller-supplied label when there is no file yet. */
  readonly source: string;

  constructor(message: string, source: string) {
    super(message);
    this.name = 'PersistenceError';
    this.source = source;
  }
}

/**
 * The snapshot is structurally wrong: not JSON, not an object, or a field of
 * the wrong type. Distinct from a version mismatch, which is a readable file
 * this build simply refuses to interpret.
 */
export class SnapshotFormatError extends PersistenceError {
  constructor(source: string, detail: string) {
    super(`Snapshot ${source} is malformed: ${detail}`, source);
    this.name = 'SnapshotFormatError';
  }
}

/**
 * The snapshot declares a schema version this build cannot read.
 *
 * Failing loudly matters more here than anywhere else in the module. Parsing a
 * future snapshot on a best-effort basis would quietly load a half-understood
 * world memory, and half-understood memory is indistinguishable from invented
 * memory once it reaches the agent.
 */
export class SnapshotVersionError extends PersistenceError {
  readonly found: number;
  readonly minSupported: number;
  readonly maxSupported: number;

  constructor(
    source: string,
    found: number,
    minSupported: number,
    maxSupported: number,
  ) {
    super(
      `Snapshot ${source} declares schema version ${found}, which this build ` +
        `cannot read (supported versions: ${minSupported} to ${maxSupported}). ` +
        'Delete the file to start fresh, or run a build that understands it.',
      source,
    );
    this.name = 'SnapshotVersionError';
    this.found = found;
    this.minSupported = minSupported;
    this.maxSupported = maxSupported;
  }
}
