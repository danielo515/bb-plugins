// Frontend: an "Audits" section in the thread context card with the latest background
// audit of the thread: each reviewer's status, its findings, and Apply / Dismiss.
import { useCallback, useEffect, useState } from "react";
import {
  Markdown,
  definePluginApp,
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadContextCardProps } from "@get-bb/plugin-sdk/app";
import type { AuditRun, rpcContract } from "./server";
import { cn } from "@/lib/utils";

// Must match REALTIME_CHANNEL in server.ts (only types may be imported from there).
const REALTIME_CHANNEL = "runs-changed";

function useLatestRun(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [run, setRun] = useState<AuditRun | null>(null);
  const refresh = useCallback(() => {
    rpc
      .call("runs", { threadId })
      .then(({ runs }) => setRun(runs.at(-1) ?? null))
      .catch(() => setRun(null));
  }, [rpc, threadId]);
  useEffect(refresh, [refresh]);
  useRealtime(REALTIME_CHANNEL, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) refresh();
  });
  return { run, rpc };
}

function isClean(output: string | null) {
  return output?.trim().replace(/[`.]/g, "").toLowerCase() === "no findings";
}

function AuditsSection({ threadId }: ExperimentalThreadContextCardProps) {
  const { run, rpc } = useLatestRun(threadId);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!run || run.dismissedAt !== null) return null;

  const running = run.reviews.some((review) => review.status === "running");
  const withFindings = run.reviews.filter(
    (review) => review.status === "failed" || (review.status === "done" && !isClean(review.output)),
  );
  const act = (method: "apply" | "dismiss") => {
    setBusy(true);
    void rpc.call(method, { threadId, runId: run.id }).finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-1">
      {run.reviews.map((review) => {
        const trailing =
          review.status === "running"
            ? "running…"
            : review.status === "failed"
              ? "failed"
              : isClean(review.output)
                ? "clean"
                : "findings";
        return (
          <div key={review.agent}>
            <ThreadContextCardRow
              icon={review.status === "running" ? "Loader" : review.status === "failed" ? "AlertTriangle" : isClean(review.output) ? "Check" : "Search"}
              label={review.agent}
              trailing={trailing}
              title={review.status === "done" && !isClean(review.output) ? "Show findings" : undefined}
              onClick={
                review.status === "running" || isClean(review.output)
                  ? undefined
                  : () => setOpen(open === review.agent ? null : review.agent)
              }
            />
            {open === review.agent && (
              <div className="max-h-80 overflow-auto rounded-md border border-border bg-muted/30 px-2 py-1 text-xs">
                <Markdown content={review.output ?? review.error ?? ""} />
              </div>
            )}
          </div>
        );
      })}
      {!running && run.appliedAt === null && (
        <div className="flex gap-2 pt-1 text-xs">
          {withFindings.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => act("apply")}
              className={cn("rounded-md bg-primary px-2 py-1 text-primary-foreground", busy && "opacity-50")}
            >
              Apply findings
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => act("dismiss")}
            className={cn("rounded-md border border-border px-2 py-1 text-muted-foreground", busy && "opacity-50")}
          >
            Dismiss
          </button>
        </div>
      )}
      {run.appliedAt !== null && <p className="text-xs text-muted-foreground">Sent to the agent.</p>}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextCardSection({
    id: "background-audits",
    title: "Audits",
    group: "1_audits",
    component: AuditsSection,
  });
});
