import { createContext, useContext } from "react";

/** Unseen-alarm state for the Info Panel nav badge. */
export interface InfoAlerts {
  /** Count of alarm entries posted since the panel was last viewed. */
  unseen: number;
  /** Mark the current feed as seen (clears the badge). */
  markSeen: () => void;
}

export const InfoAlertsContext = createContext<InfoAlerts>({
  unseen: 0,
  markSeen: () => {},
});

export function useInfoAlerts(): InfoAlerts {
  return useContext(InfoAlertsContext);
}
