// Runs on the machine daemon: drives the user's own `wt` (worktrunk) binary so
// worktree locations, hooks and approvals all come from their worktrunk config.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { execFile, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { hostContract, hostSignals, parseSwitchJson, type Runner } from "./contract.js";

// wt usually lives outside a bare login shell's PATH (Homebrew is set up in
// .zshrc, cargo in .profile), so fall back to where installers put it.
function fallbackWtPaths(): string[] {
  const home = homedir();
  return [
    "/opt/homebrew/bin/wt",
    "/usr/local/bin/wt",
    join(home, ".cargo/bin/wt"),
    join(home, ".nix-profile/bin/wt"),
    `/etc/profiles/per-user/${userInfo().username}/bin/wt`,
    "/run/current-system/sw/bin/wt",
    "/home/linuxbrew/.linuxbrew/bin/wt",
  ];
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function shellFor(runner: Runner): string {
  if (runner.shell.trim() !== "") return runner.shell.trim();
  return process.env.SHELL && process.env.SHELL !== "" ? process.env.SHELL : "/bin/sh";
}

function capture(file: string, args: string[], cwd: string | undefined, signal?: AbortSignal) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(file, args, { cwd, signal, maxBuffer: 4 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function resolveWt(runner: Runner, signal?: AbortSignal): Promise<string> {
  const configured = runner.wtPath.trim();
  if (configured !== "") {
    if (await isExecutable(configured)) return configured;
    throw new Error(`wt not found at ${configured} (plugin setting "wt path").`);
  }
  // `command -v` in a non-interactive login shell sees the PATH hooks will see.
  const lookup = await capture(shellFor(runner), ["-lc", "command -v wt"], undefined, signal);
  const found = lookup.stdout.trim().split(/\r?\n/).pop() ?? "";
  if (lookup.code === 0 && found.startsWith("/") && (await isExecutable(found))) return found;
  for (const candidate of fallbackWtPaths()) {
    if (await isExecutable(candidate)) return candidate;
  }
  throw new Error('wt (worktrunk) not found. Install it or set the plugin\'s "wt path" setting.');
}

type LineSink = (line: string) => void;

/** Run wt through the login shell; stream human output, return stdout for JSON. */
function runWt(
  runner: Runner,
  wtPath: string,
  args: string[],
  onLine: LineSink,
  signal: AbortSignal,
): Promise<{ code: number; stdout: string; tail: string[] }> {
  return new Promise((resolve, reject) => {
    // `exec "$0" "$@"` passes every argument verbatim, no shell quoting involved.
    const child = spawn(shellFor(runner), ["-lc", 'exec "$0" "$@"', wtPath, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so cancelling also stops the hooks wt started.
      detached: true,
    });
    let stdout = "";
    const tail: string[] = [];
    const remember = (line: string) => {
      tail.push(line);
      if (tail.length > 40) tail.shift();
      onLine(line);
    };
    const splitter = (isStdout: boolean) => {
      let pending = "";
      return (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (isStdout) stdout += text;
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.replace(ANSI, "");
          // The JSON result belongs to the caller, not the log.
          if (isStdout && line.trim().startsWith("{")) continue;
          if (line.trim() !== "") remember(line);
        }
      };
    };
    child.stdout.on("data", splitter(true));
    child.stderr.on("data", splitter(false));
    const kill = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    signal.addEventListener("abort", kill, { once: true });
    child.on("error", (error) => {
      signal.removeEventListener("abort", kill);
      reject(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      if (signal.aborted) reject(new Error("Cancelled"));
      else resolve({ code: code ?? 1, stdout, tail });
    });
  });
}

function failure(prefix: string, tail: string[]): Error {
  const detail = tail.slice(-12).join("\n").trim();
  return new Error(detail === "" ? prefix : `${prefix}\n${detail}`);
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    probe: async ({ runner }, context) => {
      try {
        const wtPath = await resolveWt(runner, context.signal);
        const version = await capture(wtPath, ["--version"], undefined, context.signal);
        return { wtPath, version: version.stdout.trim() || null, error: null };
      } catch (cause) {
        return { wtPath: null, version: null, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },

    switchWorktree: async ({ runner, runId, checkoutPath, branch, base, approve }, context) => {
      // Batch output lines into signals so a chatty `pnpm install` hook does not
      // emit one event per line.
      let batch: string[] = [];
      let flushing: Promise<void> = Promise.resolve();
      const flush = () => {
        if (batch.length === 0) return flushing;
        const lines = batch;
        batch = [];
        flushing = flushing.then(() => context.experimental_emitSignal("output", { runId, lines }).catch(() => {}));
        return flushing;
      };
      const timer = setInterval(flush, 400);
      try {
        const wtPath = await resolveWt(runner, context.signal);
        const exists =
          (await capture("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], checkoutPath, context.signal))
            .code === 0;
        // An existing branch (a retry, a restore, or a branch the user named)
        // gets a worktree without --create; wt reuses one that already exists.
        const args = ["-C", checkoutPath, "switch"];
        if (!exists) args.push("--create");
        args.push(branch);
        if (!exists && base !== null) args.push("--base", base);
        args.push("--no-cd", "--format", "json");
        if (approve) args.push("--yes");
        batch.push(`$ wt ${args.join(" ")}`);
        const result = await runWt(runner, wtPath, args, (line) => batch.push(line), context.signal);
        if (result.code !== 0) throw failure(`wt switch failed (exit ${result.code}).`, result.tail);
        return parseSwitchJson(result.stdout);
      } finally {
        clearInterval(timer);
        await flush();
      }
    },

    removeWorktree: async ({ runner, runId, checkoutPath, branch, approve }, context) => {
      const lines: string[] = [];
      const listed = await capture("git", ["worktree", "list", "--porcelain"], checkoutPath, context.signal);
      if (listed.code === 0 && !listed.stdout.split(/\r?\n/).includes(`branch refs/heads/${branch}`)) {
        return { removed: true, message: `No worktree for ${branch} anymore; nothing to remove.` };
      }
      const wtPath = await resolveWt(runner, context.signal);
      const args = ["-C", checkoutPath, "remove", branch, "--foreground", "--format", "json"];
      if (approve) args.push("--yes");
      const result = await runWt(runner, wtPath, args, (line) => lines.push(line), context.signal);
      if (lines.length > 0) await context.experimental_emitSignal("output", { runId, lines }).catch(() => {});
      if (result.code !== 0) {
        return { removed: false, message: failure(`wt remove ${branch} failed (exit ${result.code}).`, result.tail).message };
      }
      return { removed: true, message: `Removed worktree for ${branch}.` };
    },
  },
});
