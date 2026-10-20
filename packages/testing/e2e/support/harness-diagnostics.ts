import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const resultsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test-results",
  "harness-diagnostics",
);

interface Phase {
  readonly name: string;
  readonly ms: number;
  readonly eventLoopMaxMs: number;
}

/**
 * Times browser-harness startup phases and the longest event-loop stall in
 * each. The API's database pool shares this event loop, so a stall here is a
 * stall in every connection it opens.
 */
export class HarnessDiagnostics {
  readonly #label: string;
  readonly #phases: Phase[] = [];
  readonly #eventLoop = monitorEventLoopDelay({ resolution: 20 });

  constructor(label: string) {
    this.#label = label;
    this.#eventLoop.enable();
  }

  /** Runs one startup phase and records it, including when it fails. */
  async phase<T>(name: string, run: () => Promise<T>): Promise<T> {
    this.#eventLoop.reset();
    const started = performance.now();
    try {
      return await run();
    } finally {
      this.#phases.push({
        name,
        ms: Math.round(performance.now() - started),
        eventLoopMaxMs: Math.round(this.#eventLoop.max / 1e6),
      });
    }
  }

  summary(): string {
    const phases = this.#phases.map(
      (phase) =>
        `${phase.name} ${String(phase.ms)}ms (event loop max ${String(phase.eventLoopMaxMs)}ms)`,
    );
    return `${this.#label} startup: ${phases.join(", ")}`;
  }

  /** Stops sampling and keeps the phases with the Playwright results. */
  async finish(failure?: unknown): Promise<void> {
    this.#eventLoop.disable();
    await mkdir(resultsDirectory, { recursive: true });
    await writeFile(
      resolve(resultsDirectory, `${this.#label}.json`),
      `${JSON.stringify(
        {
          phases: this.#phases,
          ...(failure === undefined ? {} : { failure: String(failure) }),
        },
        null,
        2,
      )}\n`,
    );
  }
}
