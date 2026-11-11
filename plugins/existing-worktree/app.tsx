// Frontend: the inputs chip rendered beside the environment picker while the
// "Existing worktree" provider is selected. It lists the worktrees of the
// project checkout on the chosen machine and reports the selected path.
import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginEnvironmentProviderInputsProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Worktree } from "./contract";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const PROVIDER_ID = "existing-worktree";

function labelFor(worktree: Worktree): string {
  const name = worktree.path.split("/").filter(Boolean).pop() ?? worktree.path;
  const ref = worktree.branch ?? (worktree.detached ? "detached" : "");
  return ref === "" ? name : `${name} (${ref})`;
}

function ExistingWorktreeInputs({
  projectId,
  target,
  value,
  onChange,
}: PluginEnvironmentProviderInputsProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostId = target.kind === "existing-host" ? target.hostId : null;
  const selected =
    value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.path === "string"
      ? value.path
      : null;

  useEffect(() => {
    if (projectId === null) {
      onChange({ status: "blocked", reason: "Pick a project first" });
      return;
    }
    if (hostId === null) {
      onChange({ status: "blocked", reason: "Existing worktrees need an existing machine" });
      return;
    }
    let cancelled = false;
    setWorktrees(null);
    setError(null);
    onChange({ status: "blocked", reason: "Loading worktrees…" });
    rpc.call("worktrees_list", { projectId, hostId }).then(
      (result) => {
        if (cancelled) return;
        const usable = result.worktrees.filter((worktree) => !worktree.bare && !worktree.prunable);
        setWorktrees(usable);
        const keep = usable.find((worktree) => worktree.path === selected);
        const first = keep ?? usable.find((worktree) => !worktree.isMain) ?? usable[0];
        if (first === undefined) {
          onChange({ status: "blocked", reason: "No worktrees found for this project" });
        } else {
          onChange({ status: "ready", value: { path: first.path } });
        }
      },
      (cause: unknown) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        onChange({ status: "blocked", reason: message });
      },
    );
    return () => {
      cancelled = true;
    };
    // `selected` is intentionally not a dependency: a user pick must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, projectId, hostId]);

  const current = worktrees?.find((worktree) => worktree.path === selected) ?? null;
  return (
    <label
      className={cn(
        "inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs",
        error !== null && "border-destructive text-destructive",
      )}
      title={error ?? current?.path ?? "Choose an existing worktree"}
    >
      <Icon name="FolderOpen" className="size-3.5 shrink-0 text-muted-foreground" />
      {worktrees === null ? (
        <span className="truncate text-muted-foreground">{error ?? "Loading…"}</span>
      ) : worktrees.length === 0 ? (
        <span className="truncate text-muted-foreground">No worktrees</span>
      ) : (
        <select
          aria-label="Existing worktree"
          className="min-w-0 flex-1 truncate bg-transparent outline-none"
          value={current?.path ?? ""}
          onChange={(event) => {
            const path = event.target.value;
            if (path === "") return;
            onChange({ status: "ready", value: { path } });
          }}
        >
          {worktrees.map((worktree) => (
            <option key={worktree.path} value={worktree.path}>
              {labelFor(worktree)}
            </option>
          ))}
        </select>
      )}
    </label>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: PROVIDER_ID,
    component: ExistingWorktreeInputs,
  });
});
