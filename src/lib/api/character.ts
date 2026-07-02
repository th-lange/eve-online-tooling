import { invoke } from "@tauri-apps/api/core";

export interface SkillsView {
  totalSp: number;
  unallocatedSp: number;
  trainedCount: number;
  queue: { skillName: string; level: number; finishDate: string | null }[];
}
export function characterSkills(): Promise<SkillsView> {
  return invoke<SkillsView>("character_skills");
}

export interface StandingRow {
  name: string;
  fromType: string;
  base: number;
  effective: number;
  skill: string;
}
export function characterStandings(): Promise<StandingRow[]> {
  return invoke<StandingRow[]>("character_standings");
}

export interface ResearchView {
  rows: {
    agent: string;
    skill: string;
    pointsPerDay: number;
    currentPoints: number;
  }[];
  totalPoints: number;
  pointsPerDay: number;
}
export function characterResearch(): Promise<ResearchView> {
  return invoke<ResearchView>("character_research");
}

export interface MiningView {
  units24h: number;
  units7d: number;
  units30d: number;
  value24h: number;
  value7d: number;
  value30d: number;
  rows: { name: string; quantity: number; value: number }[];
  systems: string[];
}
export function characterMining(): Promise<MiningView> {
  return invoke<MiningView>("character_mining");
}

export interface FleetView {
  inFleet: boolean;
  members: {
    name: string;
    ship: string;
    system: string;
    role: string;
    joined: string;
  }[];
}
export function characterFleet(): Promise<FleetView> {
  return invoke<FleetView>("character_fleet");
}
