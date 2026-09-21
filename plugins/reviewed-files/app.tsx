// bb-plugin-reviewed-files — frontend entry.
//
// Replaces BB's diff renderer with the same diff plus a "Reviewed" checkbox.
// Ticking it collapses the file; the mark is bound to the diff content that was
// reviewed, so the next agent turn that edits the file expands it again.
//
// React and @get-bb/plugin-sdk/app are provided by the BB app (never bundled),
// so this file must be loaded by BB.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { definePluginApp, type PluginDiffRendererProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  clearAll,
  fingerprint,
  getMarks,
  isReviewed,
  pruneStale,
  setReviewed,
  subscribe,
} from "@/lib/reviewed-store";

/** Added/removed line counts, for the one-line summary of a collapsed file. */
function countChanges(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function ReviewedDiff({ patch, path, Original }: PluginDiffRendererProps) {
  const marks = useSyncExternalStore(subscribe, getMarks, getMarks);
  const mark = useMemo(() => fingerprint(patch), [patch]);
  const reviewed = isReviewed(marks, path, mark);
  const changes = useMemo(() => countChanges(patch), [patch]);

  // A mark for an older version of this file no longer applies — drop it so the
  // stored set stays as small as what is actually still reviewed.
  useEffect(() => {
    pruneStale(path, mark);
  }, [path, mark]);

  const toggle = (next: boolean) => setReviewed(path, mark, next);
  const checkboxId = `reviewed-files:${path}`;

  return (
    <div className="flex min-w-0 flex-col">
      <div
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 px-3 py-1.5 text-xs",
          !reviewed && "border-b border-border",
        )}
      >
        {reviewed ? (
          <span className="mr-auto flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <Icon name="Check" className="size-3.5 shrink-0" />
            <span className="truncate">
              Reviewed — hidden until this file changes again
            </span>
            <span className="shrink-0 font-mono">
              +{changes.added} −{changes.removed}
            </span>
          </span>
        ) : null}
        <label
          htmlFor={checkboxId}
          className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-muted-foreground hover:text-foreground"
        >
          Reviewed
          <Checkbox
            id={checkboxId}
            checked={reviewed}
            onCheckedChange={(checked) => toggle(checked === true)}
            aria-label={`Mark ${path} as reviewed`}
          />
        </label>
      </div>
      {reviewed ? null : (
        <div className="min-w-0">
          <Original />
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_diffRenderer({
    id: "reviewed",
    title: "Diffs with review marks",
    description:
      "BB's diff plus a Reviewed checkbox that collapses the file until an agent changes it again.",
    component: ReviewedDiff,
  });

  app.slots.commandPaletteAction({
    id: "clear-review-marks",
    title: "Reviewed files: clear all review marks",
    run: () => {
      const cleared = clearAll();
      toast.success(
        cleared === 0
          ? "No review marks to clear"
          : `Cleared ${cleared} review mark${cleared === 1 ? "" : "s"}`,
      );
    },
  });
});
