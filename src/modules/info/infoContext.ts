import { createContext, useContext } from "react";

/** Unseen-alarm state for the Info Panel nav badge. */
export interface InfoAlerts {
  /** Count of alarm entries posted since the panel was last viewed. */
  unseen: number;
  /** Whether the feed currently has any entries at all (seen or not). */
  hasEntries: boolean;
  /** Mark the current feed as seen (clears the badge). */
  markSeen: () => void;
}

export const InfoAlertsContext = createContext<InfoAlerts>({
  unseen: 0,
  hasEntries: false,
  markSeen: () => {},
});

export function useInfoAlerts(): InfoAlerts {
  return useContext(InfoAlertsContext);
}
