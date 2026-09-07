#!/usr/bin/env node
// Pull the feedback corpus out of Firestore and write it somewhere an agent (or
// a human) can read it.
//
// Feedback submitted from the app is write-only: the client API cannot read it
// back. Reading needs a **service account**, whose key bypasses security rules
// by design — so that key never goes in the repo and never ships in a build.
//
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
//     npm run feedback:pull
//
// Outputs (both git-ignored, under .local/):
//   feedback.json  every submission, newest first — the machine-readable copy
//   feedback.md    a digest grouped by module and kind — the one to skim
//
// Zero dependencies: the service-account OAuth exchange is a signed JWT, which
// node:crypto can do on its own.

import { createSign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(REPO_ROOT, ".local");
const COLLECTION = "feedback";
const SCOPE = "https://www.googleapis.com/auth/datastore";

/** Base64url, as JWTs want it. */
function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Sign a service-account assertion and trade it for an access token. */
async function accessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: credentials.client_email,
    scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify(claims),
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer
    .sign(credentials.private_key, "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `token exchange failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()).access_token;
}

/** Unwrap Firestore's one-key "typed value" objects into plain JS. */
export function plain(value) {
  if (value == null) return null;
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("mapValue" in value) return fields(value.mapValue.fields ?? {});
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(plain);
  return null;
}

function fields(raw) {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, plain(v)]));
}

/** Page through the whole collection. */
async function fetchAll(projectId, token) {
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${COLLECTION}`;
  const out = [];
  let pageToken;
  do {
    const url = new URL(base);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(
        `fetch failed: ${response.status} ${await response.text()}`,
      );
    }
    const page = await response.json();
    for (const doc of page.documents ?? []) {
      out.push({
        id: doc.name.split("/").pop(),
        // Firestore's own stamp — a client cannot forge or backdate it.
        createdAt: doc.createTime,
        ...fields(doc.fields ?? {}),
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/** Group submissions into a digest worth skimming. */
export function digest(entries) {
  const byModule = new Map();
  for (const e of entries) {
    const bucket = byModule.get(e.module) ?? {
      rating: [],
      bug: [],
      feature: [],
    };
    (bucket[e.kind] ?? []).push(e);
    byModule.set(e.module, bucket);
  }

  const lines = [
    "# Feedback digest",
    "",
    `${entries.length} submission(s), pulled ${new Date().toISOString()}.`,
    "",
    "| Module | Ratings | Avg | Bugs | Ideas |",
    "| --- | --- | --- | --- | --- |",
  ];

  const modules = [...byModule.entries()].sort(
    (a, b) =>
      b[1].rating.length +
      b[1].bug.length +
      b[1].feature.length -
      (a[1].rating.length + a[1].bug.length + a[1].feature.length),
  );
  for (const [name, b] of modules) {
    const scores = b.rating.map((e) => e.rating).filter((n) => n > 0);
    const avg = scores.length
      ? (scores.reduce((a, n) => a + n, 0) / scores.length).toFixed(1)
      : "—";
    lines.push(
      `| ${name} | ${b.rating.length} | ${avg} | ${b.bug.length} | ${b.feature.length} |`,
    );
  }

  for (const [heading, kind] of [
    ["Bugs", "bug"],
    ["Feature requests", "feature"],
    ["Ratings with comments", "rating"],
  ]) {
    const rows = entries
      .filter((e) => e.kind === kind && (kind !== "rating" || e.body?.trim()))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (rows.length === 0) continue;
    lines.push("", `## ${heading}`, "");
    for (const e of rows) {
      const who = e.character ? ` — ${e.character}` : "";
      const stars = e.rating > 0 ? ` ${"★".repeat(e.rating)}` : "";
      lines.push(
        `- **${e.module}**${stars} · ${e.createdAt?.slice(0, 10)} · v${e.appVersion} · ${e.os}${who}`,
        `  ${(e.body ?? "").replace(/\n+/g, " ").trim()}`,
        `  <sub>${e.id}</sub>`,
      );
    }
  }
  return lines.join("\n");
}

async function main() {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) {
    console.error(
      "Set GOOGLE_APPLICATION_CREDENTIALS to a Firebase service-account JSON key.",
    );
    process.exit(1);
  }
  const credentials = JSON.parse(await readFile(keyPath, "utf8"));
  const projectId =
    process.env.EVE_TOOLING_FIREBASE_PROJECT_ID ?? credentials.project_id;
  if (!projectId) {
    console.error("No project id — set EVE_TOOLING_FIREBASE_PROJECT_ID.");
    process.exit(1);
  }

  const token = await accessToken(credentials);
  const entries = await fetchAll(projectId, token);
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    resolve(OUT_DIR, "feedback.json"),
    `${JSON.stringify(entries, null, 2)}\n`,
  );
  await writeFile(resolve(OUT_DIR, "feedback.md"), `${digest(entries)}\n`);
  console.log(
    `${entries.length} submission(s) → .local/feedback.json and .local/feedback.md`,
  );
}

// Only pull when run as a command; importing the file (to test the pure
// helpers above) must not hit the network.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
