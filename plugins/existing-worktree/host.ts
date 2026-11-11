// Runs on the machine daemon: lists git worktrees of a project checkout.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { execFile } from "node:child_process";
import { hostContract, parseWorktreeList } from "./contract.js";

function git(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, signal, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() !== "" ? stderr.trim() : error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    listWorktrees: async ({ checkoutPath }, context) => {
      const output = await git(["worktree", "list", "--porcelain"], checkoutPath, context.signal);
      return { worktrees: parseWorktreeList(output) };
    },
  },
});
