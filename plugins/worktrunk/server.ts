// bb-plugin-worktrunk — a "Worktrunk" environment provider. New threads get a
// worktree from the user's own `wt switch --create`, so worktrunk decides where
// it lives and which hooks run; archiving runs `wt remove`.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginEnvironmentProviderProgress } from "@get-bb/plugin-sdk/environment-provider";
import { z } from "zod";
import { hostContract, hostSignals, type Runner, type SwitchResult } from "./contract.js";

export const PROVIDER_ID = "worktrunk";

/** Both fields optional: `{}` means "use bb's suggested branch, base from wt". */
export const inputsSchema = z
  .object({
    branch: z.string().trim().optional(),
    base: z.string().trim().optional(),
  })
  .strict();

/** What remove/restore need, stored on the environment row (private to us). */
const resourceSchema = z
  .object({ checkoutPath: z.string(), branch: z.string(), created: z.boolean(), hostId: z.string() })
  .strict();
type Resource = z.infer<typeof resourceSchema>;

const probeResultSchema = z.object({
  wtPath: z.string().nullable(),
  version: z.string().nullable(),
  error: z.string().nullable(),
});
type ProbeResult = z.infer<typeof probeResultSchema>;

export const rpcContract = defineRpcContract({
  probe: {
    input: z.object({ hostId: z.string().min(1) }).strict(),
    output: probeResultSchema,
  },
});

const SWITCH_TIMEOUT_MS = 30 * 60 * 1000; // the SDK cap; pre-start hooks may install deps
const PROBE_CACHE_MS = 60 * 1000;

function nonEmpty(value: string | undefined | null): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    wtPath: {
      type: "string",
      label: "wt path",
      description: "Absolute path to the wt binary. Empty: look it up in your login shell, then Homebrew, cargo and nix.",
      default: "",
    },
    shell: {
      type: "string",
      label: "Login shell",
      description: "Shell that runs wt (as a login shell, so hooks see your PATH). Empty: $SHELL.",
      default: "",
    },
    approveHooks: {
      type: "boolean",
      label: "Auto-approve project hooks",
      description:
        "Pass --yes to wt. Off: hooks from a repo's .config/wt.toml must be approved once with `wt config approvals add`, or the launch fails with worktrunk's message.",
      default: false,
    },
    onArchive: {
      type: "select",
      label: "When the last thread is archived",
      options: ["remove", "keep"],
      experimental_optionLabels: {
        remove: "wt remove the worktree (dirty worktrees are kept)",
        keep: "Keep the worktree",
      },
      default: "remove",
    },
  });

  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });

  // runId -> the launch report that streamed wt output belongs to.
  const reports = new Map<string, PluginEnvironmentProviderProgress>();
  host.experimental_onSignal("output", ({ payload }) => {
    const report = reports.get(payload.runId);
    if (report !== undefined && payload.lines.length > 0) report.log(payload.lines.join("\n"));
  });

  async function runner(): Promise<Runner> {
    const { wtPath, shell } = await settings.get();
    return { wtPath, shell };
  }

  const probeCache = new Map<string, { at: number; result: ProbeResult }>();
  async function probe(hostId: string): Promise<ProbeResult> {
    const cached = probeCache.get(hostId);
    if (cached !== undefined && Date.now() - cached.at < PROBE_CACHE_MS) return cached.result;
    const result = await host.call("probe", { runner: await runner() }, { hostId, timeoutMs: 15_000 });
    probeCache.set(hostId, { at: Date.now(), result });
    return result;
  }
  settings.onChange(() => probeCache.clear());

  // Retries of one launch must reuse the branch chosen on the first attempt:
  // remember it per pathKey until the environment is removed.
  const launchKey = (pathKey: string) => `launch:${pathKey}`;
  async function storedLaunch(pathKey: string): Promise<Resource | null> {
    const parsed = resourceSchema.safeParse(await bb.storage.kv.get(launchKey(pathKey)));
    return parsed.success ? parsed.data : null;
  }

  async function switchInto(args: {
    hostId: string;
    checkoutPath: string;
    branch: string;
    base: string | null;
    pathKey: string;
    attempt: number;
    report: PluginEnvironmentProviderProgress;
    signal: AbortSignal;
    claimPath(path: string): Promise<boolean>;
  }) {
    const runId = `${args.pathKey}:${args.attempt}`;
    const { approveHooks } = await settings.get();
    const previous = await storedLaunch(args.pathKey);
    // Record intent before touching the repo, so remove() can clean up a
    // half-finished launch (worktree created, then a pre-start hook failed).
    await bb.storage.kv.set(launchKey(args.pathKey), {
      checkoutPath: args.checkoutPath,
      branch: args.branch,
      created: previous?.created ?? false,
      hostId: args.hostId,
    } satisfies Resource);

    args.report.step(`wt switch ${args.branch}`);
    reports.set(runId, args.report);
    let result: SwitchResult;
    try {
      result = await host.call(
        "switchWorktree",
        {
          runner: await runner(),
          runId,
          checkoutPath: args.checkoutPath,
          branch: args.branch,
          base: args.base,
          approve: approveHooks,
        },
        { hostId: args.hostId, signal: args.signal, timeoutMs: SWITCH_TIMEOUT_MS },
      );
    } finally {
      reports.delete(runId);
    }

    const created = result.action === "created" || previous?.created === true;
    const resource: Resource = { checkoutPath: args.checkoutPath, branch: result.branch, created, hostId: args.hostId };
    await bb.storage.kv.set(launchKey(args.pathKey), resource);

    if (!(await args.claimPath(result.path))) {
      return { status: "failed" as const, message: `${result.path} is already used by another bb launch.` };
    }
    args.report.step(created ? `Created worktree ${result.path}` : `Attached existing worktree ${result.path}`);
    return {
      status: "created" as const,
      path: result.path,
      // Only worktrees we created are ours to tear down (and get .bb-env-setup.sh).
      ownsPath: created,
      ...(result.baseBranch !== null ? { mergeBaseBranch: result.baseBranch } : {}),
      resource,
    };
  }

  bb.rpc.register(rpcContract, {
    probe: ({ hostId }) => probe(hostId),
  });

  bb.experimental_environments.register({
    id: PROVIDER_ID,
    displayName: "Worktrunk",
    description: "Create a worktree with your worktrunk config: its paths, hooks and approvals.",
    icon: "GitBranchPlus",
    requires: { gitCheckout: true },
    inputs: inputsSchema,
    async availability({ host: machine }) {
      try {
        const result = await probe(machine.id);
        if (result.wtPath === null) return { status: "setup-required", message: result.error ?? "wt not found" };
        return { status: "available" };
      } catch (cause) {
        return { status: "unavailable", message: messageOf(cause) };
      }
    },
    async create({ host: machine, projectCheckout, inputs, suggestedBranchName, pathKey, attempt, report, signal, experimental_claimPath }) {
      try {
        const stored = await storedLaunch(pathKey);
        return await switchInto({
          hostId: machine.id,
          checkoutPath: projectCheckout.path,
          branch: stored?.branch ?? nonEmpty(inputs.branch) ?? suggestedBranchName,
          base: nonEmpty(inputs.base),
          pathKey,
          attempt,
          report,
          signal,
          claimPath: experimental_claimPath,
        });
      } catch (cause) {
        return { status: "failed", message: messageOf(cause) };
      }
    },
    async restore({ host: machine, projectCheckout, inputs, previous, pathKey, attempt, report, signal, experimental_claimPath }) {
      // The branch outlives the worktree; check it out again with wt.
      const prior = resourceSchema.safeParse(previous.resource);
      const branch = prior.success ? prior.data.branch : nonEmpty(inputs.branch);
      if (branch === null) return { status: "failed", message: "No branch recorded for this environment." };
      try {
        return await switchInto({
          hostId: machine.id,
          checkoutPath: projectCheckout.path,
          branch,
          base: null,
          pathKey,
          attempt,
          report,
          signal,
          claimPath: experimental_claimPath,
        });
      } catch (cause) {
        return { status: "failed", message: messageOf(cause) };
      }
    },
    async remove({ resource, pathKey, attempt, report, signal }) {
      const parsed = resourceSchema.safeParse(resource ?? (await bb.storage.kv.get(launchKey(pathKey))));
      const done = async () => {
        await bb.storage.kv.delete(launchKey(pathKey));
        return { status: "removed" as const };
      };
      if (!parsed.success) return done();
      const { checkoutPath, branch, created, hostId } = parsed.data;
      if (!created) {
        report.log(`Leaving ${branch}: the worktree existed before this thread.`);
        return done();
      }
      const { onArchive, approveHooks } = await settings.get();
      if (onArchive === "keep") {
        report.log(`Keeping the ${branch} worktree (setting "When the last thread is archived").`);
        return done();
      }
      const runId = `${pathKey}:remove:${attempt}`;
      reports.set(runId, report);
      try {
        report.step(`wt remove ${branch}`);
        const result = await host.call(
          "removeWorktree",
          { runner: await runner(), runId, checkoutPath, branch, approve: approveHooks },
          { hostId, signal, timeoutMs: 5 * 60 * 1000 },
        );
        // A refusal (dirty worktree, unapproved hook) leaves the worktree in
        // place on purpose: report it rather than retry every minute forever.
        report.log(result.removed ? result.message : `Kept the worktree: ${result.message}`);
        return done();
      } catch (cause) {
        return { status: "failed", message: messageOf(cause) };
      } finally {
        reports.delete(runId);
      }
    },
  });

  bb.cli.register({
    name: "worktrunk",
    summary: "Check the Worktrunk environment provider on a machine",
    commands: [
      { name: "doctor", summary: "Show which wt bb will run on a machine", usage: "bb worktrunk doctor --host <id> [--json]" },
    ],
    async run(argv) {
      const usage = "Usage: bb worktrunk doctor --host <id> [--json]";
      const json = argv.includes("--json");
      const hostIndex = argv.indexOf("--host");
      const hostId = hostIndex === -1 ? undefined : argv[hostIndex + 1];
      if (argv[0] !== "doctor" || hostId === undefined) return { exitCode: 1, stderr: usage };
      try {
        probeCache.delete(hostId);
        const result = await probe(hostId);
        if (json) return { exitCode: result.wtPath === null ? 1 : 0, stdout: JSON.stringify(result) };
        if (result.wtPath === null) return { exitCode: 1, stderr: result.error ?? "wt not found" };
        return { exitCode: 0, stdout: `${result.wtPath}  ${result.version ?? ""}`.trim() };
      } catch (cause) {
        return { exitCode: 1, stderr: messageOf(cause) };
      }
    },
  });
}
