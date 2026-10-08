#!/usr/bin/env node
import * as util from "node:util";
import { run } from "../src/run.js";

const USAGE = `usage: image-dir-diff-run --command CMD --snapshots-dir DIR [options]

Run CMD to generate PNG snapshots into DIR, do the same on a base git ref in a
temporary worktree, and diff the two sets. Run it from inside the repository
(or pass --cwd); CMD and DIR are relative to that directory, which is mirrored
inside the base worktree.

options:
  -c, --command CMD         shell command that generates the snapshots
  -s, --snapshots-dir DIR   where CMD writes PNGs
      --base-command CMD    command for the base ref (default: --command)
  -b, --base-ref REF        branch, tag or SHA to compare against
                            (default: $GITHUB_BASE_REF, else master)
      --remote NAME         remote to fetch the base ref from (default: origin)
      --no-fetch            resolve the base ref locally without fetching
  -C, --cwd DIR             directory to run in (default: .)
  -o, --output DIR          report directory (default: snapshot-diff)
      --skip-head           use the snapshots already in DIR instead of running
                            CMD on the current checkout
      --clean               delete DIR before running CMD on the current checkout
      --pixel-threshold N   see image-dir-diff --help (default: 0.01)
      --image-threshold N   see image-dir-diff --help (default: 0.01)
      --concurrency N       images processed in parallel (default: 8)
      --artifacts-repo O/N  GitHub repo to read cached base snapshots from and
                            publish the report to (token: $IMAGE_DIR_DIFF_ARTIFACTS_TOKEN)
      --comment             post/update a comment on the pull request in
                            $GITHUB_EVENT_PATH (token: $GITHUB_TOKEN)
      --comment-title T     (default: Snapshot diff)
      --artifact-name NAME  name the report is uploaded as by CI, to link to
                            it from the comment
      --fail-on-diff        exit with code 1 if anything changed
  -h, --help`;

async function main() {
  let values;
  try {
    ({ values } = util.parseArgs({
      options: {
        command: { type: "string", short: "c" },
        "snapshots-dir": { type: "string", short: "s" },
        "base-command": { type: "string" },
        "base-ref": { type: "string", short: "b" },
        remote: { type: "string", default: "origin" },
        "no-fetch": { type: "boolean", default: false },
        cwd: { type: "string", short: "C", default: "." },
        output: { type: "string", short: "o", default: "snapshot-diff" },
        "skip-head": { type: "boolean", default: false },
        clean: { type: "boolean", default: false },
        "pixel-threshold": { type: "string", default: "0.01" },
        "image-threshold": { type: "string", default: "0.01" },
        concurrency: { type: "string", default: "8" },
        "artifacts-repo": { type: "string" },
        comment: { type: "boolean", default: false },
        "comment-title": { type: "string", default: "Snapshot diff" },
        "artifact-name": { type: "string" },
        "fail-on-diff": { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if ((!values.command && !values["skip-head"]) || !values["snapshots-dir"]) {
    console.error(USAGE);
    return 2;
  }
  if (values["skip-head"] && !values.command && !values["base-command"]) {
    console.error("--skip-head needs --command or --base-command to generate the base snapshots");
    return 2;
  }

  try {
    const { total } = await run({
      command: values.command,
      snapshotsDir: values["snapshots-dir"],
      baseCommand: values["base-command"] || values.command,
      baseRef: values["base-ref"] || undefined,
      remote: values.remote,
      fetch: !values["no-fetch"],
      cwd: values.cwd,
      output: values.output,
      skipHead: values["skip-head"],
      clean: values.clean,
      pixelThreshold: parseFloat(values["pixel-threshold"]),
      imageThreshold: parseFloat(values["image-threshold"]),
      concurrency: parseInt(values.concurrency, 10),
      artifactsRepo: values["artifacts-repo"] || undefined,
      comment: values.comment,
      commentTitle: values["comment-title"],
      artifactName: values["artifact-name"],
    });
    return values["fail-on-diff"] && total > 0 ? 1 : 0;
  } catch (err) {
    console.error(`[image-dir-diff] error: ${err.message}`);
    return 1;
  }
}

process.exitCode = await main();
