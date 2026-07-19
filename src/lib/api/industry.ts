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
  characterId: number;
  characterName: string;
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
export interface CharacterSlots {
  characterId: number;
  characterName: string;
  slots: Slots;
}
export interface JobsResult {
  jobs: JobRow[];
  /** Job-slot usage (used vs available), summed across every target character. */
  slots: Slots;
  /** Per-character breakdown of the same slot pools — which character has an
   *  idle line, not just the aggregate. */
  byCharacter: CharacterSlots[];
}

/**
 * A character's industry jobs (running + recently delivered) plus slot usage,
 * durably accumulated. `characterId` selects the roster character (default:
 * the active selection — every roster character, rows tagged and slots
 * summed, when "All characters" is active).
 * Requires `esi-industry.read_character_jobs.v1` (re-login if added).
 */
export function industryJobs(characterId?: number): Promise<JobsResult> {
  return invoke<JobsResult>("industry_jobs", { characterId });
}
