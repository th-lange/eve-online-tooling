import { invoke } from "@tauri-apps/api/core";

/** One in-game notification. */
export interface NotifRow {
  id: number;
  characterId: number;
  characterName: string;
  /** Humanised type, e.g. "Structure Under Attack". */
  title: string;
  /** War | Sovereignty | Structure | Industry | Wallet | Corp | Other. */
  category: string;
  sender: string;
  timestamp: string;
  isRead: boolean;
  /** Raw YAML-ish body for an expandable detail. */
  body: string;
}

/**
 * The active character's notifications (newest first), dismissed ones removed.
 * Needs the `esi-characters.read_notifications.v1` scope.
 */
export function notifications(): Promise<NotifRow[]> {
  return invoke<NotifRow[]>("notifications_list");
}

/**
 * Hide a notification from the feed (durable, per character). Pass the row's
 * owning `characterId` — dismissed sets are per character, so omitting it
 * hides the id for the primary character only.
 */
export function notificationDismiss(
  notificationId: number,
  characterId: number | null = null,
): Promise<void> {
  return invoke<void>("notifications_dismiss", { notificationId, characterId });
}

/** Un-dismiss everything so the full feed shows again. */
export function notificationsReset(): Promise<void> {
  return invoke<void>("notifications_reset");
}
