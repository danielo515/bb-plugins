// Pull/merge request references, shared by the server, host and frontend
// (no imports, so the app bundle stays free of zod and the SDK server side).

// What `wt switch` accepts for a pull/merge request: pr:N, mr:N, or the web URL.
// Anything after the number (/files, #comment, ?query) is dropped.
const PR_URL = /^(https?:\/\/[^\s/]+\/\S+?\/(?:pull|-\/merge_requests)\/\d+)(?:[/#?]\S*)?$/;

/**
 * Normalize what a user typed for a PR into the reference wt resolves: "123",
 * "#123" and "pr:123" become "pr:123"; "mr:12" and GitHub/GitLab URLs pass
 * through (trimmed to the PR's own URL). Null when it is not a PR reference.
 */
export function prReference(input: string): string | null {
  const value = input.trim();
  const number = /^(?:#|pr:)?(\d+)$/i.exec(value);
  if (number !== null) return `pr:${number[1]}`;
  const mr = /^(?:!|mr:)(\d+)$/i.exec(value);
  if (mr !== null) return `mr:${mr[1]}`;
  const url = PR_URL.exec(value);
  if (url !== null) return url[1] ?? null;
  return null;
}

/** True for a reference wt resolves itself (no --create, no --base). */
export function isPrReference(target: string): boolean {
  return /^(pr|mr):\d+$/.test(target) || PR_URL.test(target);
}
