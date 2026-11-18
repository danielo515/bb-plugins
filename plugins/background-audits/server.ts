// Background audits: runs the Claude Code review gates (~/.claude/hooks/*-review-gate.sh)
// at the end of each bb turn and, for every agent a gate asks for, a hidden reviewer
// thread that follows ~/.claude/agents/<agent>.md. By default the findings are then
// sent to the agent as an agent-only message so it applies them right away, and the
// user reviews the result; with "Apply automatically" off they wait in the thread
// context card instead. The gates are the scripts Claude Code's settings.json runs as
// `<script> snapshot` on UserPromptSubmit and `<script> check` on Stop, unless the
// "Gate scripts" setting lists them; the agents directory is a setting too.
//
// The gate scripts stay the single source of truth for *when* to audit and *what*
// scope to give each agent. Inside bb they skip themselves (BB_THREAD_ID is set), so
// this plugin runs them without that variable.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const CLAUDE_SETTINGS = "~/.claude/settings.json";
const DEFAULT_AGENTS_DIR = "~/.claude/agents";
const GATE_TIMEOUT_MS = 20_000;
const REVIEW_TIMEOUT_MS = 15 * 60_000;
const KEPT_RUNS = 5;
export const REALTIME_CHANNEL = "runs-changed";
const TOOL_NAME = "audit_findings";

const reviewSchema = z.object({
  agent: z.string(),
  reviewerThreadId: z.string().nullable(),
  status: z.enum(["running", "done", "failed"]),
  output: z.string().nullable(),
  error: z.string().nullable(),
});
const runSchema = z.object({
  id: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  gateReasons: z.array(z.string()),
  reviews: z.array(reviewSchema),
  appliedAt: z.number().nullable(),
  dismissedAt: z.number().nullable(),
});
export type AuditRun = z.infer<typeof runSchema>;
type Review = z.infer<typeof reviewSchema>;

export const rpcContract = defineRpcContract({
  runs: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ runs: z.array(runSchema) }),
  },
  apply: {
    input: z.object({ threadId: z.string(), runId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  dismiss: {
    input: z.object({ threadId: z.string(), runId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
});

function runIsFinished(run: AuditRun): boolean {
  return run.reviews.every((review) => review.status !== "running");
}

function runIsPending(run: AuditRun): boolean {
  return runIsFinished(run) && run.appliedAt === null && run.dismissedAt === null;
}

/** The agents a gate's block reason names, limited to agents that exist on disk. */
function agentsNamedIn(reason: string, agentsDir: string): string[] {
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -".md".length))
    .filter((agent) => new RegExp(`(^|[^\\w-])${agent}([^\\w-]|$)`).test(reason));
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

const hookEntriesSchema = z.array(
  z.object({ hooks: z.array(z.object({ command: z.string().optional() }).loose()).optional() }).loose(),
);
const claudeSettingsSchema = z
  .object({ hooks: z.object({ UserPromptSubmit: hookEntriesSchema.optional(), Stop: hookEntriesSchema.optional() }).loose().optional() })
  .loose();

/** The scripts a hook event's commands run as `[bash|sh] <script> <mode>`. */
function scriptsRunAs(entries: z.infer<typeof hookEntriesSchema> | undefined, mode: string): Set<string> {
  const pattern = new RegExp(`^(?:(?:ba)?sh\\s+)?(?:'([^']+)'|"([^"]+)"|(\\S+))\\s+${mode}\\s*$`);
  const scripts = new Set<string>();
  for (const entry of entries ?? []) {
    for (const hook of entry.hooks ?? []) {
      const match = hook.command?.trim().match(pattern);
      const script = match?.[1] ?? match?.[2] ?? match?.[3];
      if (script) scripts.add(expandHome(script));
    }
  }
  return scripts;
}

/**
 * The review gates registered in Claude Code's settings: every script run as
 * `<script> snapshot` on UserPromptSubmit and as `<script> check` on Stop.
 */
function detectGateScripts(): { scripts: string[]; problem: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(expandHome(CLAUDE_SETTINGS), "utf8"));
  } catch (error) {
    return { scripts: [], problem: `cannot read ${CLAUDE_SETTINGS}: ${describeError(error)}` };
  }
  const parsed = claudeSettingsSchema.safeParse(raw);
  if (!parsed.success) return { scripts: [], problem: `unexpected hooks in ${CLAUDE_SETTINGS}: ${parsed.error.message}` };
  const snapshots = scriptsRunAs(parsed.data.hooks?.UserPromptSubmit, "snapshot");
  const scripts = [...scriptsRunAs(parsed.data.hooks?.Stop, "check")].filter((script) => snapshots.has(script));
  return {
    scripts,
    problem: scripts.length === 0 ? `no hook in ${CLAUDE_SETTINGS} runs a script as \`snapshot\` and \`check\`` : null,
  };
}

/** A reviewer's answer when it found nothing to fix. */
function isClean(review: Review): boolean {
  return review.status === "done" && review.output?.trim().replace(/[`.]/g, "").toLowerCase() === "no findings";
}

function hasFindings(run: AuditRun): boolean {
  return run.reviews.some((review) => review.status === "done" && !isClean(review));
}

function reviewerPrompt(agent: string, gateRequest: string, workspacePath: string, agentsDir: string): string {
  return [
    `You are the ${agent} subagent. Read ${join(agentsDir, `${agent}.md`)} and follow its body as your instructions (ignore its frontmatter).`,
    "",
    `The review gate in ${workspacePath} asked for this review. Review only what this request scopes:`,
    "",
    "<gate-request>",
    gateRequest,
    "</gate-request>",
    "",
    "You run in the background as a read-only reviewer: do not edit, create, format or commit files, and do not spawn bb threads.",
    "End with your findings as your final answer: one item per finding with file:line, the problem, and the concrete fix. If there is nothing to fix, answer exactly `No findings.`",
  ].join("\n");
}

function formatFindings(run: AuditRun): string {
  return run.reviews
    .filter((review) => !isClean(review))
    .map((review) => {
      const body =
        review.status === "done"
          ? (review.output ?? "No output.")
          : `Review failed: ${review.error ?? "unknown error"}`;
      return `## ${review.agent}\n\n${body}`;
    })
    .join("\n\n");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    gateScripts: {
      type: "string",
      label: "Gate scripts",
      description:
        "Empty: detected from ~/.claude/settings.json (scripts run as `<script> snapshot` on UserPromptSubmit and `<script> check` on Stop). Otherwise one path per line (~ allowed), each run the same way with the hook JSON on stdin.",
      experimental_multiline: true,
      default: "",
    },
    agentsDir: {
      type: "string",
      label: "Agents directory",
      description: "Where the agents named by the gates live, as <name>.md.",
      default: DEFAULT_AGENTS_DIR,
    },
    autoApply: {
      type: "boolean",
      label: "Apply automatically",
      description:
        "Send findings to the agent as soon as the audit finishes, so you review the fixes instead of the findings. Off: findings wait in the thread context card.",
      default: true,
    },
  });

  // Last detection result logged, so each turn doesn't log it again.
  let lastDetection: string | null = null;

  async function config() {
    const values = await settings.get();
    const listed = values.gateScripts
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(expandHome);
    let gateScripts = listed;
    if (listed.length === 0) {
      const detected = detectGateScripts();
      const summary = detected.problem ?? detected.scripts.join(", ");
      if (summary !== lastDetection) {
        lastDetection = summary;
        if (detected.problem) bb.log.warn(`No gate scripts, so no audits: ${detected.problem}`);
        else bb.log.info(`Gate scripts from ${CLAUDE_SETTINGS}: ${summary}`);
      }
      gateScripts = detected.scripts;
    }
    return {
      gateScripts: gateScripts.filter((script) => existsSync(script)),
      agentsDir: expandHome(values.agentsDir.trim()),
      autoApply: values.autoApply,
    };
  }

  // Threads whose next idle ends our own "apply" turn: auditing it again would loop,
  // just as the hooks let the turn end after one block (stop_hook_active).
  const skipNextIdle = new Set<string>();

  function runGate(script: string, mode: "snapshot" | "check", workspacePath: string, threadId: string) {
    const env = { ...process.env };
    delete env.BB_THREAD_ID;
    return new Promise<string>((resolve) => {
      const child = execFile(
        "bash",
        [script, mode],
        { cwd: workspacePath, env, timeout: GATE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) bb.log.warn(`${script} ${mode} failed: ${describeError(error)} ${stderr}`);
          resolve(stdout);
        },
      );
      child.stdin?.end(
        JSON.stringify({ cwd: workspacePath, session_id: `bb-${threadId}`, stop_hook_active: false }),
      );
    });
  }

  async function workspacePathOf(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    return environment.path && existsSync(environment.path) ? environment.path : null;
  }

  async function readRuns(threadId: string): Promise<AuditRun[]> {
    const metadata: Record<string, unknown> = await bb.sdk.threads.getPluginMetadata({ threadId });
    const parsed = z.array(runSchema).safeParse(metadata.runs);
    return parsed.success ? parsed.data : [];
  }

  // One writer per thread, so reviewers finishing together do not overwrite each other.
  const writeChains = new Map<string, Promise<unknown>>();
  function updateRuns(threadId: string, change: (runs: AuditRun[]) => AuditRun[]): Promise<void> {
    const next = (writeChains.get(threadId) ?? Promise.resolve()).then(async () => {
      const runs = change(await readRuns(threadId)).slice(-KEPT_RUNS);
      await bb.sdk.threads.updatePluginMetadata({ threadId, set: { runs } });
      bb.realtime.publish(REALTIME_CHANNEL, { threadId });
    });
    writeChains.set(threadId, next.catch(() => undefined));
    return next;
  }

  function updateRun(threadId: string, runId: string, change: (run: AuditRun) => AuditRun) {
    return updateRuns(threadId, (runs) => runs.map((run) => (run.id === runId ? change(run) : run)));
  }

  function updateReview(threadId: string, runId: string, agent: string, patch: Partial<Review>) {
    return updateRun(threadId, runId, (run) => {
      const next = {
        ...run,
        reviews: run.reviews.map((review) => (review.agent === agent ? { ...review, ...patch } : review)),
      };
      return runIsFinished(next) && next.finishedAt === null ? { ...next, finishedAt: Date.now() } : next;
    });
  }

  async function runReviewer(
    primaryThreadId: string,
    runId: string,
    agent: string,
    gateRequest: string,
    workspacePath: string,
    agentsDir: string,
  ) {
    try {
      const [primary, defaults] = await Promise.all([
        bb.sdk.threads.get({ threadId: primaryThreadId }),
        bb.sdk.threads.defaultExecutionOptions({ threadId: primaryThreadId }),
      ]);
      if (!primary.environmentId) throw new Error("the thread has no environment");
      const reviewer = await bb.sdk.threads.spawn({
        projectId: primary.projectId,
        providerId: primary.providerId,
        ...(defaults?.model ? { model: defaults.model } : {}),
        ...(defaults?.permissionMode ? { permissionMode: defaults.permissionMode } : {}),
        environment: { type: "reuse", environmentId: primary.environmentId },
        visibility: "hidden",
        // bb archives and deletes the reviewer together with its primary thread.
        lifecycleOwnerThreadId: primaryThreadId,
        title: `Audit ${agent}: ${primary.title ?? primaryThreadId}`,
        prompt: reviewerPrompt(agent, gateRequest, workspacePath, agentsDir),
      });
      await updateReview(primaryThreadId, runId, agent, { reviewerThreadId: reviewer.id });
      await bb.sdk.threads.wait({ threadId: reviewer.id, status: "idle", timeoutMs: REVIEW_TIMEOUT_MS });
      const { output } = await bb.sdk.threads.output({ threadId: reviewer.id });
      await updateReview(primaryThreadId, runId, agent, {
        status: "done",
        output: output?.trim() || "No output.",
      });
      await bb.sdk.threads.archive({ threadId: reviewer.id }).catch(() => undefined);
    } catch (error) {
      bb.log.warn(`Reviewer ${agent} for ${primaryThreadId} failed: ${describeError(error)}`);
      await updateReview(primaryThreadId, runId, agent, { status: "failed", error: describeError(error) });
    }
  }

  async function auditTurn(threadId: string) {
    const workspacePath = await workspacePathOf(threadId);
    if (!workspacePath) return;
    const { gateScripts, agentsDir, autoApply } = await config();
    const gateRequests: string[] = [];
    for (const script of gateScripts) {
      const stdout = (await runGate(script, "check", workspacePath, threadId)).trim();
      if (!stdout) continue;
      try {
        const decision = JSON.parse(stdout) as { decision?: unknown; reason?: unknown };
        if (decision.decision === "block" && typeof decision.reason === "string") {
          gateRequests.push(decision.reason);
        }
      } catch {
        bb.log.warn(`${script} printed something that is not JSON: ${stdout.slice(0, 200)}`);
      }
    }
    const jobs = gateRequests.flatMap((gateRequest) =>
      agentsNamedIn(gateRequest, agentsDir).map((agent) => ({ agent, gateRequest })),
    );
    if (jobs.length === 0) return;
    bb.log.info(`Audit of ${threadId}: ${jobs.length} reviewer(s) from ${gateRequests.length} gate(s)`);

    const run: AuditRun = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: Date.now(),
      finishedAt: null,
      gateReasons: gateRequests,
      reviews: jobs.map(({ agent }) => ({
        agent,
        reviewerThreadId: null,
        status: "running" as const,
        output: null,
        error: null,
      })),
      appliedAt: null,
      dismissedAt: null,
    };
    await updateRuns(threadId, (runs) => [...runs, run]);
    await Promise.all(
      jobs.map(({ agent, gateRequest }) =>
        runReviewer(threadId, run.id, agent, gateRequest, workspacePath, agentsDir),
      ),
    );
    if (autoApply) await sendFindings(threadId, run.id, "automatic");
  }

  /**
   * Sends a finished run's findings to the agent as an agent-only message, queued
   * behind any turn in progress. Runs without findings are not sent.
   */
  async function sendFindings(threadId: string, runId: string, trigger: "automatic" | "user") {
    const run = await takePendingRun(threadId, runId);
    if (!run || !hasFindings(run)) return false;
    const intro =
      trigger === "automatic"
        ? "Background audits of your last turn found the issues below. Apply the fixes now. The user reviews your changes afterwards and may revert some, so keep each fix focused and end with one line per finding saying what you changed, or that you skipped it and why."
        : "The user asked you to apply these background audit findings. Fix them, or say which ones you decided not to fix and why.";
    await bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      input: [{ type: "text", visibility: "agent-only", text: `${intro}\n\n${formatFindings(run)}`, mentions: [] }],
    });
    return true;
  }

  /** Marks a finished, unapplied run (the newest one by default) as applied and returns it. */
  async function takePendingRun(threadId: string, runId?: string): Promise<AuditRun | null> {
    const runs = await readRuns(threadId);
    const run = runId
      ? runs.find((candidate) => candidate.id === runId && runIsPending(candidate))
      : [...runs].reverse().find(runIsPending);
    if (!run) return null;
    await updateRun(threadId, run.id, (current) => ({ ...current, appliedAt: Date.now() }));
    return run;
  }

  function isAuditable(thread: { visibility: string; originPluginId: string | null }) {
    return thread.visibility !== "hidden" && thread.originPluginId === null;
  }

  // Threads whose current turn already has its worktree snapshot.
  const snapshotted = new Set<string>();
  async function snapshot(threadId: string, workspacePath: string) {
    for (const script of (await config()).gateScripts) {
      await runGate(script, "snapshot", workspacePath, threadId);
    }
    snapshotted.add(threadId);
  }

  // Snapshot the worktree before the turn runs, as the UserPromptSubmit hook did.
  bb.experimental_hooks.on("message.dispatch", async (context) => {
    try {
      const workspacePath = context.environment?.path;
      if (context.attempt === "start-turn" && isAuditable(context.thread)) {
        if (context.originPluginId === bb.pluginId) {
          skipNextIdle.add(context.thread.id);
        } else if (workspacePath && existsSync(workspacePath)) {
          await snapshot(context.thread.id, workspacePath);
        }
      }
    } catch (error) {
      bb.log.warn(`Snapshot failed for ${context.thread.id}: ${describeError(error)}`);
    }
    return { action: "proceed" };
  });

  // A thread's first message dispatches before bb has created its worktree, so the
  // snapshot waits until the turn starts.
  bb.events.on("thread.active", async ({ thread }) => {
    if (snapshotted.has(thread.id) || skipNextIdle.has(thread.id) || !isAuditable(thread)) return;
    try {
      const workspacePath = await workspacePathOf(thread.id);
      if (workspacePath) await snapshot(thread.id, workspacePath);
    } catch (error) {
      bb.log.warn(`Snapshot failed for ${thread.id}: ${describeError(error)}`);
    }
  });

  // Check after the turn, as the Stop hook did, but without blocking the turn.
  bb.events.on("thread.idle", async ({ thread }) => {
    const hadSnapshot = snapshotted.delete(thread.id);
    if (skipNextIdle.delete(thread.id) || !isAuditable(thread) || !hadSnapshot) return;
    try {
      await auditTurn(thread.id);
    } catch (error) {
      bb.log.error(`Audit failed for ${thread.id}: ${describeError(error)}`);
    }
  });

  bb.agents.registerTool({
    name: TOOL_NAME,
    description:
      "Return the findings of the latest background audit of this thread (naming, Effect and other reviewers) so you can apply them.",
    presentation: { label: { pending: "Reading audit findings", completed: "Read audit findings" } },
    parameters: z.object({}),
    async execute(_input, { threadId }) {
      const run = await takePendingRun(threadId);
      if (run && hasFindings(run)) {
        // This turn applies findings; auditing its own fixes again would loop.
        skipNextIdle.add(threadId);
        return `${formatFindings(run)}\n\nFix these findings, or tell the user which ones you decided not to fix and why.`;
      }
      const runs = await readRuns(threadId);
      return runs.some((candidate) => !runIsFinished(candidate))
        ? "A background audit is still running. Tell the user to ask again when it finishes."
        : "There are no pending audit findings for this thread.";
    },
  });

  bb.agents.configure((context) => {
    if (context.origin.pluginId !== null) return { tools: [], skills: [] };
    return {
      tools: [TOOL_NAME],
      skills: [],
      instructions: `Background audits (naming, Effect and other reviewers) run on their own after your turns; when they find something, you get the findings in a later message. Do not run those reviews yourself, even if a hook asks you to. When the user asks you to apply pending audit findings, call ${TOOL_NAME} and act on what it returns.`,
    };
  });

  bb.rpc.register(rpcContract, {
    async runs({ threadId }) {
      return { runs: await readRuns(threadId) };
    },
    async apply({ threadId, runId }) {
      return { ok: await sendFindings(threadId, runId, "user") };
    },
    async dismiss({ threadId, runId }) {
      await updateRun(threadId, runId, (run) => ({ ...run, dismissedAt: Date.now() }));
      return { ok: true };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
