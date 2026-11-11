// Frontend: branch/base fields beside the environment picker while "Worktrunk"
// is selected. Both are optional — empty branch uses bb's suggested name and
// empty base uses worktrunk's default branch.
import { useEffect, useState } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginEnvironmentProviderInputsProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const PROVIDER_ID = "worktrunk";

function readField(value: unknown, key: "branch" | "base"): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

// Mirrors `git check-ref-format --branch` closely enough to catch typos early;
// wt itself remains the authority.
function branchProblem(name: string): string | null {
  if (name === "") return null;
  if (/\s/.test(name)) return "Branch names cannot contain spaces";
  if (/(^[-/.])|([/.]$)|\.\.|[~^:?*[\\]|@\{|\/\//.test(name) || name.endsWith(".lock")) {
    return "Not a valid git branch name";
  }
  return null;
}

function WorktrunkInputs({ value, onChange }: PluginEnvironmentProviderInputsProps) {
  const [branch, setBranch] = useState(() => readField(value, "branch"));
  const [base, setBase] = useState(() => readField(value, "base"));

  useEffect(() => {
    const trimmedBranch = branch.trim();
    const trimmedBase = base.trim();
    const problem = branchProblem(trimmedBranch);
    if (problem !== null) {
      onChange({ status: "blocked", reason: problem });
      return;
    }
    onChange({
      status: "ready",
      value: {
        ...(trimmedBranch !== "" ? { branch: trimmedBranch } : {}),
        ...(trimmedBase !== "" ? { base: trimmedBase } : {}),
      },
    });
    // onChange identity is owned by the host; re-emit only when fields change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, base]);

  const invalid = branchProblem(branch.trim()) !== null;
  return (
    <div
      className={cn(
        "inline-flex h-7 max-w-80 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs",
        invalid && "border-destructive",
      )}
      title={branchProblem(branch.trim()) ?? "wt switch --create <branch> --base <base>"}
    >
      <Icon name="GitBranch" className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        aria-label="Branch"
        className="w-32 min-w-0 bg-transparent outline-none placeholder:text-muted-foreground"
        placeholder="branch (auto)"
        spellCheck={false}
        value={branch}
        onChange={(event) => setBranch(event.target.value)}
      />
      <span className="text-muted-foreground">from</span>
      <input
        aria-label="Base branch"
        className="w-20 min-w-0 bg-transparent outline-none placeholder:text-muted-foreground"
        placeholder="default"
        spellCheck={false}
        value={base}
        onChange={(event) => setBase(event.target.value)}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: PROVIDER_ID,
    component: WorktrunkInputs,
  });
});
