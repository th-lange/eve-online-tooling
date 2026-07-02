import { invoke } from "@tauri-apps/api/core";

export interface JobRow {
  jobId: number;
  activity: string;
  product: string;
  runs: number;
  status: string;
  cost: number | null;
  startDate: string;
  endDate: string;
  facility: string;
  /** "You" for personal jobs, "Corp" for corporation jobs. */
  owner: string;
}

export interface Slot {
  used: number;
  total: number;
}
export interface Slots {
  manufacturing: Slot;
  science: Slot;
  reactions: Slot;
}
export interface JobsResult {
  jobs: JobRow[];
  /** Job-slot usage (used vs available), from the character's skills. */
  slots: Slots;
}

/**
 * A character's industry jobs (running + recently delivered) plus slot usage,
 * durably accumulated. `characterId` selects the roster character (default: first).
 * Requires `esi-industry.read_character_jobs.v1` (re-login if added).
 */
export function industryJobs(characterId?: number): Promise<JobsResult> {
  return invoke<JobsResult>("industry_jobs", { characterId });
}
