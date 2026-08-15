export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly at: number;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Discards everything. The default, so libraries stay silent unless asked. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/**
 * Collects records in memory. Used by tests to assert on what was logged and
 * by run manifests to attach a trace to a result.
 */
export class MemoryLogger implements Logger {
  readonly records: LogRecord[] = [];

  constructor(
    private readonly now: () => number = () => 0,
    private readonly bound: Readonly<Record<string, unknown>> = {},
  ) {}

  #write(level: LogLevel, message: string, fields?: Record<string, unknown>) {
    const merged = { ...this.bound, ...fields };
    const record: LogRecord = {
      level,
      message,
      at: this.now(),
      ...(Object.keys(merged).length > 0 ? { fields: merged } : {}),
    };
    this.records.push(record);
  }

  debug(m: string, f?: Record<string, unknown>): void {
    this.#write('debug', m, f);
  }
  info(m: string, f?: Record<string, unknown>): void {
    this.#write('info', m, f);
  }
  warn(m: string, f?: Record<string, unknown>): void {
    this.#write('warn', m, f);
  }
  error(m: string, f?: Record<string, unknown>): void {
    this.#write('error', m, f);
  }

  child(fields: Record<string, unknown>): Logger {
    const c = new MemoryLogger(this.now, { ...this.bound, ...fields });
    // Share the sink so a run's trace stays in one place.
    Object.defineProperty(c, 'records', { value: this.records });
    return c;
  }
}
