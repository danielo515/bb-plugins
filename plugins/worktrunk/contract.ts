// Shared contract between server.ts (bb server) and host.ts (machine daemon).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** How the host locates and runs `wt`. Empty strings mean "auto-detect". */
const runnerSchema = z
  .object({
    /** Absolute path to the wt binary; "" searches the login shell PATH and common install dirs. */
    wtPath: z.string(),
    /** Login shell used to run wt so hooks see the user's PATH (direnv, nix, ...); "" uses $SHELL. */
    shell: z.string(),
  })
  .strict();
export type Runner = z.infer<typeof runnerSchema>;

export const switchResultSchema = z
  .object({
    /** "created" when wt made a new worktree, "existing" when it reused one. */
    action: z.string(),
    branch: z.string(),
    path: z.string(),
    baseBranch: z.string().nullable(),
    createdBranch: z.boolean(),
  })
  .strict();
export type SwitchResult = z.infer<typeof switchResultSchema>;

export const hostContract = defineRpcContract({
  /** Resolve wt and report its version; used for picker availability. */
  probe: {
    input: z.object({ runner: runnerSchema }).strict(),
    output: z
      .object({ wtPath: z.string().nullable(), version: z.string().nullable(), error: z.string().nullable() })
      .strict(),
    experimental_retryable: true,
  },
  /** `wt switch [--create] <branch>` in the project checkout. Streams output as `output` signals. */
  switchWorktree: {
    input: z
      .object({
        runner: runnerSchema,
        runId: z.string().min(1),
        checkoutPath: z.string().min(1),
        branch: z.string().min(1),
        base: z.string().nullable(),
        approve: z.boolean(),
      })
      .strict(),
    output: switchResultSchema,
  },
  /** `wt remove <branch>`; never forces a dirty worktree away. */
  removeWorktree: {
    input: z
      .object({
        runner: runnerSchema,
        runId: z.string().min(1),
        checkoutPath: z.string().min(1),
        branch: z.string().min(1),
        approve: z.boolean(),
      })
      .strict(),
    output: z.object({ removed: z.boolean(), message: z.string() }).strict(),
  },
});

export const hostSignals = {
  /** A batch of wt output lines for one run, forwarded into the provisioning log. */
  output: { payload: z.object({ runId: z.string(), lines: z.array(z.string()) }).strict() },
} as const;

/** Pull the JSON object wt prints on stdout with `--format json`. Exported for tests. */
export function parseSwitchJson(stdout: string): SwitchResult {
  const line = stdout
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .reverse()
    .find((candidate) => candidate.startsWith("{"));
  if (line === undefined) throw new Error("wt printed no JSON result");
  const raw = z
    .object({
      action: z.string(),
      branch: z.string(),
      path: z.string(),
      base_branch: z.string().nullish(),
      created_branch: z.boolean().nullish(),
    })
    .parse(JSON.parse(line));
  return {
    action: raw.action,
    branch: raw.branch,
    path: raw.path,
    baseBranch: raw.base_branch ?? null,
    createdBranch: raw.created_branch ?? false,
  };
}
