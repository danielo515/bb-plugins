// Frontend: a "Context" section in the thread context card (the panel pinned at
// a thread pane's upper-right) that always shows the context-window usage and
// its per-category breakdown — the same data as bb's on-demand context popover.
import { useEffect, useState } from "react";
import { definePluginApp, useSdk } from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadContextCardProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const POLL_MS = 5_000;
const DETAILS_KEY = "context-meter:details";

// Same theme variables bb's own context popover uses, so custom palettes apply.
const PALETTE = ["--ansi-4", "--ansi-1", "--ansi-3", "--ansi-5", "--ansi-6", "--ansi-2", "--ansi-8"].map(
  (name) => `var(${name})`,
);
const MUTED = "var(--muted-foreground)";

type Kind = "used" | "free" | "reserved" | "deferred";
interface Entry {
  id: string;
  label: string;
  tokens: number;
}
interface Category extends Entry {
  kind: Kind;
  entries: Entry[];
}
interface Usage {
  estimated: boolean;
  capacity: number;
  usedTokens: number;
  autoCompactAt: number | null;
  categories: Category[] | null;
}

// The SDK response is typed, but treat it as untrusted and narrow it here.
function parseUsage(raw: unknown): Usage | null {
  if (raw === null || typeof raw !== "object") return null;
  const usage = (raw as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const used = typeof u.usedTokens === "number" ? u.usedTokens : null;
  const window = typeof u.modelContextWindow === "number" ? u.modelContextWindow : null;
  if (used === null || window === null || window <= 0) return null;
  const snapshot = u.snapshot !== null && typeof u.snapshot === "object" ? (u.snapshot as Record<string, unknown>) : null;
  const categories = Array.isArray(snapshot?.categories)
    ? (snapshot.categories as unknown[]).flatMap((value): Category[] => {
        if (value === null || typeof value !== "object") return [];
        const c = value as Record<string, unknown>;
        if (typeof c.id !== "string" || typeof c.label !== "string" || typeof c.tokens !== "number") return [];
        const kind = c.kind;
        if (kind !== "used" && kind !== "free" && kind !== "reserved" && kind !== "deferred") return [];
        const entries = Array.isArray(c.entries)
          ? (c.entries as unknown[]).flatMap((e): Entry[] => {
              if (e === null || typeof e !== "object") return [];
              const r = e as Record<string, unknown>;
              return typeof r.id === "string" && typeof r.label === "string" && typeof r.tokens === "number"
                ? [{ id: r.id, label: r.label, tokens: r.tokens }]
                : [];
            })
          : [];
        return [{ id: c.id, label: c.label, tokens: c.tokens, kind, entries }];
      })
    : null;
  return {
    estimated: u.estimated === true,
    capacity: typeof snapshot?.contextWindowTokens === "number" ? snapshot.contextWindowTokens : window,
    usedTokens: typeof snapshot?.usedTokens === "number" ? snapshot.usedTokens : used,
    autoCompactAt: typeof snapshot?.autoCompactAtTokens === "number" ? snapshot.autoCompactAtTokens : null,
    categories: categories !== null && categories.length > 0 ? categories : null,
  };
}

function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}m`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function percent(part: number, whole: number): string {
  const value = (part / whole) * 100;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

function useContextUsage(threadId: string): Usage | null {
  const sdk = useSdk();
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      controller?.abort();
      controller = new AbortController();
      sdk.threads.context({ threadId, signal: controller.signal }).then(
        (result) => {
          if (!cancelled) setUsage(parseUsage(result));
        },
        () => {
          /* keep the last value; the next poll retries */
        },
      );
    };
    setUsage(null);
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [sdk, threadId]);
  return usage;
}

function CategoryRow({ category, capacity, color }: { category: Category; capacity: number; color: string }) {
  const [open, setOpen] = useState(false);
  const expandable = category.entries.length > 0;
  const line = (
    <>
      <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color }} />
      <span className="min-w-0 flex-1 truncate text-left">{category.label}</span>
      <span className="shrink-0 tabular-nums">{category.tokens.toLocaleString("en-US")}</span>
      <span className="w-11 shrink-0 text-right tabular-nums text-muted-foreground">
        {percent(category.tokens, capacity)}
      </span>
      <Icon
        name="ChevronRight"
        className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90", !expandable && "invisible")}
      />
    </>
  );
  const className = cn(
    "flex w-full items-center gap-2 py-1 text-xs",
    category.kind === "used" ? "text-foreground" : "text-muted-foreground",
  );
  return (
    <div>
      {expandable ? (
        <button type="button" className={cn(className, "cursor-pointer")} aria-expanded={open} onClick={() => setOpen(!open)}>
          {line}
        </button>
      ) : (
        <div className={className}>{line}</div>
      )}
      {open ? (
        <div className="space-y-0.5 pb-1 pl-4.5 pr-5 text-xs text-muted-foreground">
          {category.entries.map((entry) => (
            <div key={entry.id} className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              <span className="shrink-0 tabular-nums">{entry.tokens.toLocaleString("en-US")}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ContextSection({ threadId }: ExperimentalThreadContextCardProps) {
  const usage = useContextUsage(threadId);
  const [details, setDetails] = useState(() => {
    try {
      return localStorage.getItem(DETAILS_KEY) !== "hidden";
    } catch {
      return true;
    }
  });
  if (usage === null) return null;

  const { capacity, usedTokens, categories } = usage;
  const used = categories?.filter((c) => c.kind === "used") ?? [];
  const spare = categories?.filter((c) => c.kind === "free" || c.kind === "reserved") ?? [];
  const deferred = categories?.filter((c) => c.kind === "deferred") ?? [];
  const toggle = () => {
    const next = !details;
    setDetails(next);
    try {
      localStorage.setItem(DETAILS_KEY, next ? "shown" : "hidden");
    } catch {
      /* private mode: keep it in memory */
    }
  };

  return (
    <div className="flex flex-col gap-1.5 pb-1 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span>
          <span className="font-medium text-foreground">{compact(usedTokens)}</span>
          <span className="text-muted-foreground"> / {compact(capacity)} tokens{usage.estimated ? " (est.)" : ""}</span>
        </span>
        <span className="tabular-nums text-muted-foreground">{percent(usedTokens, capacity)} used</span>
      </div>

      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${percent(usedTokens, capacity)} of context used`}>
        {used.length > 0 ? (
          used.map((category, index) => (
            <div
              key={category.id}
              className="h-full"
              style={{ width: `${(category.tokens / capacity) * 100}%`, background: PALETTE[index % PALETTE.length] }}
            />
          ))
        ) : (
          <div className="h-full bg-primary" style={{ width: `${Math.min(100, (usedTokens / capacity) * 100)}%` }} />
        )}
      </div>

      {categories !== null ? (
        <>
          {details ? (
            <div className="flex flex-col">
              {used.map((category, index) => (
                <CategoryRow key={category.id} category={category} capacity={capacity} color={PALETTE[index % PALETTE.length]} />
              ))}
              {spare.length > 0 ? (
                <div className="mt-1 border-t border-border pt-1">
                  {spare.map((category) => (
                    <CategoryRow key={category.id} category={category} capacity={capacity} color={MUTED} />
                  ))}
                </div>
              ) : null}
              {deferred.length > 0 ? (
                <div className="mt-1 border-t border-border pt-1.5">
                  <div className="text-muted-foreground">Available on demand</div>
                  {deferred.map((category) => (
                    <CategoryRow key={category.id} category={category} capacity={capacity} color={MUTED} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 self-end text-muted-foreground hover:text-foreground"
            onClick={toggle}
          >
            {details ? "Hide details" : "Show details"}
            <Icon name={details ? "ChevronUp" : "ChevronDown"} className="size-3" />
          </button>
        </>
      ) : (
        <span className="text-muted-foreground">No breakdown yet for this thread.</span>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextCardSection({
    id: "context-usage",
    title: "Context",
    // Ahead of bb's own sections, so usage sits at the top of the card.
    group: "0_context",
    component: ContextSection,
  });
});
