/**
 * Build a markdown PR comment summarising a diff output directory.
 *
 * Inline before/after/diff thumbnails are only included when the diff was
 * published to a branch of an artifacts repo (`artifactsRepo` + `branch`).
 * URLs use `github.com/{repo}/raw/{branch}/...` so they pass the viewer's
 * github.com session (required for private repos — raw.githubusercontent.com
 * is a separate origin and doesn't see the cookie). Reviewers must have read
 * access to the artifacts repo for the images to render.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Marker used to find a previous comment for in-place updates. */
export const COMMENT_MARKER = "<!-- image-dir-diff-comment -->";

function rawUrl(serverUrl, repo, branch, p) {
  const encoded = p.split("/").map(encodeURIComponent).join("/");
  return `${serverUrl}/${repo}/raw/${branch}/${encoded}`;
}

async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(p, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.outputDir directory produced by compareDirs
 * @param {string} [opts.title]
 * @param {string} [opts.runUrl] link to the CI run (for the artifact bundle)
 * @param {string} [opts.artifactName] name of the CI artifact holding the report, if uploaded
 * @param {string} [opts.serverUrl]
 * @param {string} [opts.artifactsRepo] owner/name the diff was published to
 * @param {string} [opts.branch] branch of artifactsRepo the diff was published to
 * @returns {Promise<string>}
 */
export async function buildComment({
  outputDir,
  title = "Snapshot diff",
  runUrl,
  artifactName,
  serverUrl = "https://github.com",
  artifactsRepo,
  branch,
}) {
  const manifest = await readJson(path.join(outputDir, "manifest.json"), null);
  if (!manifest) throw new Error(`manifest not found in ${outputDir}`);
  const inlineManifest = await readJson(path.join(outputDir, "inline-manifest.json"), []);

  const lines = [COMMENT_MARKER, `## ${title}`, ""];

  const total = manifest.changed.length + manifest.added.length + manifest.removed.length;
  if (total === 0) {
    lines.push("No snapshot changes detected.");
    return lines.join("\n") + "\n";
  }

  const summary = [];
  if (manifest.changed.length) summary.push(`${manifest.changed.length} changed`);
  if (manifest.added.length) summary.push(`${manifest.added.length} added`);
  if (manifest.removed.length) summary.push(`${manifest.removed.length} removed`);
  lines.push(summary.join(", ") + ".");
  lines.push("");

  const published = artifactsRepo && branch;
  const links = [];
  if (published) {
    links.push(
      `Diff images are on branch [\`${artifactsRepo}@${branch}\`](${serverUrl}/${artifactsRepo}/tree/${branch})`,
    );
  }
  if (runUrl && artifactName) links.push(`full bundle is on the [\`${artifactName}\` artifact](${runUrl}#artifacts)`);
  if (links.length) {
    const sentence = links.join("; ");
    lines.push(sentence[0].toUpperCase() + sentence.slice(1) + ".");
    lines.push("");
  }

  const shown = published ? inlineManifest : [];
  for (const entry of shown) {
    const [before, after, diff] = ["before", "after", "diff"].map((kind) =>
      rawUrl(serverUrl, artifactsRepo, branch, `inline/${entry.index}.${kind}.png`),
    );
    const pct = (entry.changed_fraction * 100).toFixed(2);
    lines.push(`### \`${entry.name}\` (${pct}% pixels changed)`);
    lines.push("");
    lines.push("| before | after | diff |");
    lines.push("|---|---|---|");
    lines.push(
      `| <img src="${before}" width="320"> | <img src="${after}" width="320"> | <img src="${diff}" width="320"> |`,
    );
    lines.push("");
  }

  const shownNames = new Set(shown.map((e) => e.name));
  const others = manifest.changed.filter((e) => !shownNames.has(e.name));
  if (others.length > 0) {
    lines.push(
      shown.length
        ? `…and ${others.length} other snapshot${others.length === 1 ? "" : "s"} changed:`
        : `**Changed** (${others.length}):`,
    );
    for (const entry of others) {
      lines.push(`- \`${entry.name}\` (${(entry.changed_fraction * 100).toFixed(2)}%)`);
    }
    lines.push("");
  }

  if (manifest.added.length) {
    lines.push(`**Added** (${manifest.added.length}):`);
    for (const n of manifest.added) lines.push(`- \`${n}\``);
    lines.push("");
  }
  if (manifest.removed.length) {
    lines.push(`**Removed** (${manifest.removed.length}):`);
    for (const n of manifest.removed) lines.push(`- \`${n}\``);
    lines.push("");
  }

  return lines.join("\n");
}
