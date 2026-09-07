import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Node's default SIGINT / SIGTERM / SIGHUP handlers call process.exit()
 * immediately, which skips the async `finally` blocks that restore
 * injections. While a dev/deploy injection session is live we replace those
 * defaults so the session can abort the Shopify child, restore files, and
 * then exit with the conventional 128+signal status.
 */

export type InterruptSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

export interface InterruptListenerHost {
  on(event: string, listener: NodeJS.SignalsListener): unknown;
  off(event: string, listener: NodeJS.SignalsListener): unknown;
}

interface InterruptState {
  controller: AbortController;
}

const interruptSignals: InterruptSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

const interruptExitCodes: Record<InterruptSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

const interruptStorage = new AsyncLocalStorage<InterruptState>();

/** AbortSignal for the current injection session, if one is running. */
export function currentInterruptSignal(): AbortSignal | undefined {
  return interruptStorage.getStore()?.controller.signal;
}

/**
 * True when the error (or the current session) represents a user interrupt
 * such as Ctrl+C, rather than a command failure.
 */
export function isActiveInterrupt(error?: unknown): boolean {
  return currentInterruptSignal()?.aborted === true || (error !== undefined && isInterruptError(error));
}

export function isInterruptError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const record = error as { isCanceled?: unknown; signal?: unknown };

  return record.isCanceled === true || isInterruptSignal(record.signal);
}

/**
 * Runs `work` with SIGINT / SIGTERM / SIGHUP converted into a clean exit
 * code instead of an uncaught kill, so callers can restore injections.
 */
export async function runInterruptible(
  work: () => Promise<number | void>,
  host: InterruptListenerHost = process,
): Promise<number> {
  return withInterruptProtection(async () => runUntilInterrupt(work), host);
}

export async function withInterruptProtection<T>(
  work: () => Promise<T>,
  host: InterruptListenerHost = process,
): Promise<T> {
  const controller = new AbortController();
  const onSignal: NodeJS.SignalsListener = (signal = "SIGINT") => {
    if (!controller.signal.aborted) {
      controller.abort(isInterruptSignal(signal) ? signal : "SIGINT");
    }
  };

  for (const signal of interruptSignals) {
    listen(host, signal, onSignal);
  }

  try {
    return await interruptStorage.run({ controller }, work);
  } finally {
    for (const signal of interruptSignals) {
      unlisten(host, signal, onSignal);
    }
  }
}

async function runUntilInterrupt(work: () => Promise<number | void>): Promise<number> {
  const signal = currentInterruptSignal();

  if (signal?.aborted) {
    return interruptExitCode(signal.reason);
  }

  try {
    const exitCode = await work();

    if (signal?.aborted) {
      return interruptExitCode(signal.reason);
    }

    return exitCode ?? 0;
  } catch (error) {
    if (isActiveInterrupt(error)) {
      abortCurrentInterrupt(error);
      return interruptExitCode(currentInterruptSignal()?.reason ?? signalOf(error));
    }

    throw error;
  }
}

function abortCurrentInterrupt(error: unknown): void {
  const state = interruptStorage.getStore();

  if (state === undefined || state.controller.signal.aborted) {
    return;
  }

  state.controller.abort(signalOf(error) ?? "SIGINT");
}

function interruptExitCode(reason: unknown): number {
  return isInterruptSignal(reason) ? interruptExitCodes[reason] : 130;
}

function signalOf(error: unknown): InterruptSignal | undefined {
  if (typeof error !== "object" || error === null || !("signal" in error)) {
    return undefined;
  }

  const signal = (error as { signal: unknown }).signal;
  return isInterruptSignal(signal) ? signal : undefined;
}

function isInterruptSignal(value: unknown): value is InterruptSignal {
  return value === "SIGINT" || value === "SIGTERM" || value === "SIGHUP";
}

function listen(
  host: InterruptListenerHost,
  signal: InterruptSignal,
  listener: NodeJS.SignalsListener,
): void {
  try {
    host.on(signal, listener);
  } catch {
    // Some platforms reject unsupported signal names.
  }
}

function unlisten(
  host: InterruptListenerHost,
  signal: InterruptSignal,
  listener: NodeJS.SignalsListener,
): void {
  try {
    host.off(signal, listener);
  } catch {
    // Matching listen(): ignore platforms that do not expose the signal.
  }
}
