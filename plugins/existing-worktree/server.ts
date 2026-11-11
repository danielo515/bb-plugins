// bb-plugin-existing-worktree — offer an already existing git worktree as the
// place a new thread runs. The environment picker gets an "Existing worktree"
// row; its chip (app.tsx) lists the worktrees of the project checkout on the
// selected machine and the chosen path is attached without bb owning it.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, worktreeSchema } from "./contract.js";

export const PROVIDER_ID = "existing-worktree";

export const inputsSchema = z
  .object({ path: z.string().trim().min(1, "Choose a worktree") })
  .strict();

export const rpcContract = defineRpcContract({
  worktrees_list: {
    input: z.object({ projectId: z.string().min(1), hostId: z.string().min(1) }).strict(),
    output: z.object({
      checkoutPath: z.string(),
      worktrees: z.array(worktreeSchema),
    }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function resolveCheckoutPath(projectId: string, hostId: string): Promise<string> {
    const project = await bb.sdk.projects.get({ projectId });
    const sources = project.sources.filter((source) => source.hostId === hostId);
    const source = sources.find((candidate) => candidate.isDefault) ?? sources[0];
    if (source === undefined) {
      throw new Error("This project has no checkout on the selected machine.");
    }
    return source.path;
  }

  async function listWorktrees(projectId: string, hostId: string, signal?: AbortSignal) {
    const checkoutPath = await resolveCheckoutPath(projectId, hostId);
    const { worktrees } = await host.call("listWorktrees", { checkoutPath }, { hostId, signal });
    return { checkoutPath, worktrees };
  }

  bb.rpc.register(rpcContract, {
    worktrees_list: ({ projectId, hostId }) => listWorktrees(projectId, hostId),
  });

  bb.experimental_environments.register({
    id: PROVIDER_ID,
    displayName: "Existing worktree",
    description: "Run in a git worktree that already exists for this project.",
    icon: "FolderOpen",
    requires: { gitCheckout: true },
    inputs: inputsSchema,
    // The worktree is not ours: never retire the environment row, so it stays
    // reusable from the picker after its threads are archived.
    policy: { retireGraceMs: null },
    async validate({ host: machine, projectCheckout, inputs }) {
      const { worktrees } = await host.call(
        "listWorktrees",
        { checkoutPath: projectCheckout.path },
        { hostId: machine.id },
      );
      const match = worktrees.find((worktree) => worktree.path === inputs.path);
      if (match === undefined) {
        return {
          action: "refuse",
          message: `${inputs.path} is not a worktree of ${projectCheckout.path}.`,
        };
      }
      if (match.bare) return { action: "refuse", message: "A bare repository cannot host a thread." };
      if (match.prunable) {
        return { action: "refuse", message: `${inputs.path} is missing on disk (prunable).` };
      }
      return { action: "accept" };
    },
    async create({ inputs, report }) {
      report.step(`Attaching existing worktree ${inputs.path}`);
      return { status: "created", path: inputs.path, ownsPath: false };
    },
    async remove() {
      // Nothing to clean up: the worktree belongs to the user.
      return { status: "removed" };
    },
  });

  bb.cli.register({
    name: "existing-worktree",
    summary: "List the git worktrees bb can attach a thread to",
    commands: [
      {
        name: "list",
        summary: "List worktrees of a project checkout on a machine",
        usage: "bb existing-worktree list --project <id> --host <id> [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const option = (name: string) => {
        const index = args.indexOf(name);
        return index === -1 ? undefined : args[index + 1];
      };
      const usage =
        "Usage: bb existing-worktree list --project <id> --host <id> [--json]\n" +
        "Spawn onto one with: bb thread spawn --project <id> --environment-provider existing-worktree --environment-inputs '{\"path\":\"<worktree>\"}'";
      if (args[0] !== "list") return { exitCode: 1, stderr: usage };
      const projectId = option("--project") ?? process.env.BB_PROJECT_ID;
      const hostId = option("--host");
      if (projectId === undefined || hostId === undefined) return { exitCode: 1, stderr: usage };
      try {
        const result = await listWorktrees(projectId, hostId);
        if (json) return { exitCode: 0, stdout: JSON.stringify(result) };
        const lines = result.worktrees.map(
          (worktree) =>
            `${worktree.isMain ? "* " : "  "}${worktree.path}  [${worktree.branch ?? (worktree.detached ? "detached" : "-")}]`,
        );
        return { exitCode: 0, stdout: lines.join("\n") };
      } catch (cause) {
        return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
