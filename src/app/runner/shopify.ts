import { execa, type ResultPromise } from "execa";
import { isNodeError } from "#/utils/node";
import { currentInterruptSignal } from "./interrupt";

const defaultKillGraceMs = 5_000;

/**
 * Runs the Shopify CLI and forwards interrupts to it.
 *
 * The child stays in bshopify's own process group (no `detached`) so it keeps
 * the terminal as its controlling terminal and its interactive prompt (for
 * example `shopify app dev`'s `q` to quit) can still read stdin. Detaching
 * would orphan the child's process group and make terminal reads fail with
 * EIO, breaking that prompt. On interrupt we first forward the graceful
 * signal, then SIGKILL the direct child after a grace period so the caller's
 * `finally` always restores injections. Grandchildren (the cloudflared tunnel,
 * Shopify's auto-upgrade install) may be orphaned by that kill; that is the
 * deliberate trade-off over `detached: true`.
 */
export async function runShopifyCommand(args: string[], cwd: string): Promise<number> {
  const cancelSignal = currentInterruptSignal();
  const subprocess = execa("shopify", args, {
    cwd,
    localDir: cwd,
    preferLocal: true,
    stdio: "inherit",
  });
  const stopEscalation = armKillEscalation(subprocess, cancelSignal);

  try {
    const result = await subprocess;
    return result.exitCode ?? 0;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        "Shopify CLI is not available. Install it globally with npm install -g @shopify/cli@latest, or add @shopify/cli to this project.",
      );
    }

    throw error;
  } finally {
    stopEscalation();
  }
}

/**
 * On interrupt: forward the graceful signal to the child, then escalate to
 * SIGKILL after a grace period so a `shopify` that hangs on exit (for example
 * Shopify CLI 4.8.2's auto-upgrade blocking its postrun hook) cannot keep the
 * caller stuck before it restores injections.
 *
 * Returns a cleanup function that removes the listener and cancels any
 * pending escalation timer. It is safe to call after the subprocess has
 * already settled.
 */
function armKillEscalation(
  subprocess: ResultPromise,
  cancelSignal: AbortSignal | undefined,
): () => void {
  if (cancelSignal === undefined) {
    return () => undefined;
  }

  const graceMs = readKillGraceMs();
  let escalateTimer: NodeJS.Timeout | undefined;

  const onAbort = (): void => {
    const pid = subprocess.pid;

    if (pid !== undefined) {
      forwardSignal(pid, interruptSignalOf(cancelSignal.reason));
    }

    // Read the pid lazily at fire time: an abort can arrive before the child
    // has finished spawning (`subprocess.pid` is then still undefined), so the
    // escalation must not depend on the pid captured above.
    escalateTimer = setTimeout(() => {
      escalateTimer = undefined;
      const currentPid = subprocess.pid;

      if (currentPid !== undefined) {
        killChild(currentPid, subprocess);
      }
    }, graceMs);
    escalateTimer.unref();
  };

  if (cancelSignal.aborted) {
    onAbort();
  } else {
    cancelSignal.addEventListener("abort", onAbort, { once: true });
  }

  return () => {
    cancelSignal.removeEventListener("abort", onAbort);

    if (escalateTimer !== undefined) {
      clearTimeout(escalateTimer);
      escalateTimer = undefined;
    }
  };
}

function forwardSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process is already gone.
  }
}

function killChild(pid: number, subprocess: ResultPromise): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone; execa's kill below is a harmless no-op in that case.
  }

  try {
    subprocess.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

function interruptSignalOf(reason: unknown): NodeJS.Signals {
  return reason === "SIGINT" || reason === "SIGTERM" || reason === "SIGHUP"
    ? reason
    : "SIGINT";
}

function readKillGraceMs(): number {
  const raw = process.env.BSHOPIFY_KILL_GRACE_MS;
  const parsed = raw === undefined || raw === "" ? Number.NaN : Number(raw);

  if (!Number.isFinite(parsed)) {
    return defaultKillGraceMs;
  }

  return Math.max(0, Math.floor(parsed));
}
