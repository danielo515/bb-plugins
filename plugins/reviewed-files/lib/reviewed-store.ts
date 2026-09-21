// Per-client store of "I have reviewed this file" marks.
//
// A mark is a path plus a fingerprint of the diff content that was reviewed, so
// it means "I reviewed THIS version of the file". When a later agent turn edits
// the file its patch changes, the fingerprint no longer matches, and the mark
// stops applying — no invalidation pass needed. Stale entries are pruned when
// the file is next rendered.
//
// State lives in localStorage (per client, like BB's own renderer choice) and is
// shared live between components and windows through a subscription.

const STORAGE_KEY = "bb-plugin-reviewed-files:v1";
/** Bound on persisted entries so a long-lived client cannot grow without limit. */
const MAX_ENTRIES = 2000;

/** path → fingerprint of the reviewed patch. */
export type ReviewMarks = Readonly<Record<string, string>>;

const EMPTY: ReviewMarks = Object.freeze({});

const listeners = new Set<() => void>();
let cache: ReviewMarks | null = null;

/**
 * cyrb53 — a short, fast, non-cryptographic content hash. This only has to
 * detect "the patch changed", not resist an attacker.
 */
export function fingerprint(patch: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < patch.length; index += 1) {
    const ch = patch.charCodeAt(index);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${patch.length.toString(36)}.${value.toString(36)}`;
}

/** Persisted values are untrusted input: keep only string → string pairs. */
function parse(raw: string | null): ReviewMarks {
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return EMPTY;
    }
    const marks: Record<string, string> = {};
    for (const [path, mark] of Object.entries(parsed)) {
      if (typeof path === "string" && path.length > 0 && typeof mark === "string") {
        marks[path] = mark;
      }
    }
    return Object.freeze(marks);
  } catch {
    return EMPTY;
  }
}

function read(): ReviewMarks {
  if (cache) return cache;
  try {
    cache = parse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    cache = EMPTY;
  }
  return cache;
}

function commit(next: ReviewMarks): void {
  cache = Object.freeze({ ...next });
  try {
    if (Object.keys(cache).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    }
  } catch {
    // A full or unavailable localStorage costs persistence, not correctness:
    // the in-memory cache still drives this session.
  }
  for (const listener of [...listeners]) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    cache = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Stable snapshot for useSyncExternalStore — same identity until a write. */
export function getMarks(): ReviewMarks {
  return read();
}

export function isReviewed(marks: ReviewMarks, path: string, mark: string): boolean {
  return marks[path] === mark;
}

export function setReviewed(path: string, mark: string, reviewed: boolean): void {
  const current = read();
  if (!reviewed) {
    if (!(path in current)) return;
    const next = { ...current };
    delete next[path];
    commit(next);
    return;
  }
  if (current[path] === mark) return;
  const next = { ...current, [path]: mark };
  const paths = Object.keys(next);
  if (paths.length > MAX_ENTRIES) {
    // Oldest insertion order first; drop the front of the window.
    for (const stale of paths.slice(0, paths.length - MAX_ENTRIES)) delete next[stale];
  }
  commit(next);
}

/** Drop a mark that no longer describes the file's current content. */
export function pruneStale(path: string, mark: string): void {
  const current = read();
  const stored = current[path];
  if (stored === undefined || stored === mark) return;
  const next = { ...current };
  delete next[path];
  commit(next);
}

export function clearAll(): number {
  const count = Object.keys(read()).length;
  if (count > 0) commit(EMPTY);
  return count;
}
