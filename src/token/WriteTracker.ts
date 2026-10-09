export interface WriteResult {
  readonly operation: "write" | "delete";
  readonly path: string;
  readonly error?: unknown;
}

/**
 * Records every write and delete served for a token. A tool's exit code says
 * nothing about whether its uploads committed, so callers wait on
 * `settled` and take success or failure from the results.
 */
export class WriteTracker {
  readonly #results: WriteResult[] = [];
  readonly #waiters: Array<() => void> = [];
  #inFlight = 0;

  /** Runs `operation`, recording it as a result and as in flight until it settles. */
  async track(operation: WriteResult["operation"], path: string, run: () => Promise<void>) {
    this.#inFlight += 1;
    try {
      await run();
      this.#results.push({ operation, path });
    } catch (error) {
      this.#results.push({ operation, path, error });
      throw error;
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0) {
        for (const resolve of this.#waiters.splice(0)) {
          resolve();
        }
      }
    }
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  /** Resolves with every result so far once no write or delete is in flight. */
  async settled(): Promise<readonly WriteResult[]> {
    if (this.#inFlight > 0) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    return [...this.#results];
  }
}
