// Shared contract between server.ts (bb server) and host.ts (machine daemon).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const worktreeSchema = z.object({
  /** Absolute path of the worktree on the host. */
  path: z.string(),
  /** Checked-out branch name, or null when detached or bare. */
  branch: z.string().nullable(),
  head: z.string().nullable(),
  /** True for the main working tree (the project checkout itself). */
  isMain: z.boolean(),
  detached: z.boolean(),
  bare: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
});
export type Worktree = z.infer<typeof worktreeSchema>;

export const hostContract = defineRpcContract({
  listWorktrees: {
    input: z.object({ checkoutPath: z.string().min(1) }).strict(),
    output: z.object({ worktrees: z.array(worktreeSchema) }).strict(),
  },
});

/** Parse `git worktree list --porcelain` output. Exported for tests. */
export function parseWorktreeList(porcelain: string): Worktree[] {
  const blocks = porcelain
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block !== "");
  return blocks.flatMap((block, index) => {
    const lines = block.split(/\r?\n/);
    let path: string | null = null;
    let branch: string | null = null;
    let head: string | null = null;
    let detached = false;
    let bare = false;
    let locked = false;
    let prunable = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      } else if (line === "detached") detached = true;
      else if (line === "bare") bare = true;
      else if (line === "locked" || line.startsWith("locked ")) locked = true;
      else if (line === "prunable" || line.startsWith("prunable ")) prunable = true;
    }
    if (path === null) return [];
    return [{ path, branch, head, isMain: index === 0, detached, bare, locked, prunable }];
  });
}
