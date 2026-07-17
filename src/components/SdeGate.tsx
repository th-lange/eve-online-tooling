import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { errorMessage, sdeStatus } from "../lib/api";
import { Page, PageHeader, Centered } from "./page";
import { SdeSetup } from "./SdeSetup";

/**
 * Gates a module page behind the SDE install check: owns the
 * `["sde","status"]` query and renders a loading notice, a backend-error
 * notice, or the SDE download flow in its place — falling through to
 * `children` once the SDE is installed. `PageHeader` renders on every
 * return path per the page.tsx convention.
 */
export function SdeGate({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });

  if (status.isLoading) {
    return (
      <Page>
        <PageHeader title={title} subtitle={subtitle} />
        <Centered>Checking static data…</Centered>
      </Page>
    );
  }
  if (status.isError) {
    return (
      <Page>
        <PageHeader title={title} subtitle={subtitle} />
        <Centered>
          <span className="text-rose-400">
            Couldn't reach the backend: {errorMessage(status.error)}
          </span>
        </Centered>
      </Page>
    );
  }
  if (!status.data?.installed) {
    return (
      <Page>
        <PageHeader title={title} subtitle={subtitle} />
        <SdeSetup onInstalled={() => status.refetch()} />
      </Page>
    );
  }
  return <>{children}</>;
}
