import { useApplyTheme } from "../lib/useTheme";

/** Renders nothing; applies the appearance preference to <html>. Mount once. */
export function ThemeApplier() {
  useApplyTheme();
  return null;
}
