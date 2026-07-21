import { Heart } from "lucide-react";
import {
  CopyRow,
  LinkRow,
  CorpRow,
  CREATOR_CODE,
} from "../../components/SupportMyWork";
import { Page, PageHeader } from "../../components/page";

// The "Support my work" module: the EVE content-creator code + buddy invite
// link, with a short pitch. A registry module (hideable like any other from the
// sidebar), not a bespoke sidebar panel.
export function SupportPage() {
  return (
    <Page width="narrow">
      <PageHeader
        title={
          <>
            <Heart size={22} className="text-rose-400" /> Support my work
          </>
        }
      />
      <p className="mt-3 text-sm leading-relaxed text-zinc-400">
        This app is free and built in my spare time. If it's useful and you — or
        a friend — are making a new EVE account, signing up with my buddy link
        or using my creator code sends a few coins my way, at no cost to you. o7
      </p>

      <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <CopyRow label="Creator code" value={CREATOR_CODE} note="(pending)" />
        <LinkRow />
        <CorpRow />
      </div>

      <p className="mt-6 text-xs leading-relaxed text-zinc-500">
        Not interested? No worries — you can hide this from the sidebar (hover
        the entry and click the eye-off). It'd make me sad, just so you know.
      </p>
    </Page>
  );
}
