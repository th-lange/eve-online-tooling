import { invoke } from "@tauri-apps/api/core";

/**
 * Feedback module bridge — ratings, bug reports and feature requests.
 *
 * Submissions go into a write-only Firestore collection: once sent, nothing
 * (including this app) can read them back. The history these calls return is a
 * **local** mirror of what this install submitted, and doubles as the retry
 * queue for sends that failed offline.
 */

/** What sort of feedback a submission is. */
export type FeedbackKind = "rating" | "bug" | "feature";

/** Whether a locally-recorded submission actually reached the server. */
export type FeedbackEntryStatus = "sent" | "pending";

/** Exactly what leaves the machine — shown to the user before they send. */
export interface FeedbackPayload {
  kind: FeedbackKind;
  /** Registry module id (e.g. `"production"`), or `"general"`. */
  module: string;
  /** 1–5 stars, or 0 when the submission carries no rating. */
  rating: number;
  body: string;
  /** Character name, only when the user left the attach box ticked. */
  character: string | null;
  appVersion: string;
  os: string;
  /** Anonymous account id; null until the first successful send. */
  uid: string | null;
}

/** One row of this install's local submission history. */
export interface FeedbackEntry {
  id: string;
  /** Server-side document id, once accepted. */
  docId: string | null;
  payload: FeedbackPayload;
  submittedAt: number;
  status: FeedbackEntryStatus;
  error: string | null;
}

export interface FeedbackStatus {
  /** False when this build has no feedback endpoint — the UI then offers the
   *  GitHub-issue route instead of a send button that cannot work. */
  configured: boolean;
  /** This build's version, for the GitHub-issue fallback. */
  appVersion: string;
  uid: string | null;
  pending: number;
  submittedToday: number;
  /** Seconds until another submission is allowed; 0 when ready. */
  cooldownSecs: number;
}

/** Arguments shared by the preview and submit calls. */
export interface FeedbackDraft {
  kind: FeedbackKind;
  module: string;
  rating: number;
  body: string;
  attachCharacter: boolean;
}

/** Whether feedback can be sent from this build, plus local queue state. */
export function feedbackStatus(): Promise<FeedbackStatus> {
  return invoke<FeedbackStatus>("feedback_status");
}

/** The exact record a send would upload. Nothing leaves the machine for this
 *  call — it backs the "here's what gets sent" panel. */
export function feedbackPreview(
  draft: FeedbackDraft,
): Promise<FeedbackPayload> {
  return invoke<FeedbackPayload>("feedback_preview", { ...draft });
}

/** Validate, record locally and try to upload. A network failure resolves with
 *  a `pending` entry rather than rejecting — the text is never lost. */
export function feedbackSubmit(draft: FeedbackDraft): Promise<FeedbackEntry> {
  return invoke<FeedbackEntry>("feedback_submit", { ...draft });
}

/** This install's own submissions, newest first. */
export function feedbackHistory(): Promise<FeedbackEntry[]> {
  return invoke<FeedbackEntry[]>("feedback_history");
}

/** Re-attempt every queued submission; returns the updated history. */
export function feedbackRetryPending(): Promise<FeedbackEntry[]> {
  return invoke<FeedbackEntry[]>("feedback_retry_pending");
}

/** Drop one row from the local history (the submission itself can't be
 *  recalled). Returns the updated history. */
export function feedbackForget(id: string): Promise<FeedbackEntry[]> {
  return invoke<FeedbackEntry[]>("feedback_forget", { id });
}

/** Repo the GitHub-issue fallback files against. */
const REPO = "https://github.com/th-lange/eve-online-tooling";

/**
 * A prefilled "new issue" URL for the GitHub fallback, used when this build has
 * no feedback endpoint or a send keeps failing, so the reporter isn't retyping
 * what they already wrote here.
 *
 * Only *free-text* fields are prefilled. The templates' `area` field is a
 * dropdown whose options are coarse groupings ("Route / Local Intel") that
 * don't map to registry ids — GitHub silently ignores a value that isn't one of
 * the declared options, so the module goes into the body where it survives.
 */
export function githubIssueUrl(
  draft: Pick<FeedbackDraft, "kind" | "module" | "body">,
  appVersion: string,
  moduleTitle: string,
): string {
  const isFeature = draft.kind === "feature";
  const params = new URLSearchParams({
    template: isFeature ? "feature_request.yml" : "bug_report.yml",
  });
  const text = [`Module: ${moduleTitle}`, "", draft.body.trim()]
    .join("\n")
    .trim();
  params.set(isFeature ? "problem" : "what_happened", text);
  if (!isFeature) params.set("version", appVersion);
  return `${REPO}/issues/new?${params.toString()}`;
}
