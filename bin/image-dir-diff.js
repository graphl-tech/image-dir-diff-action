#!/usr/bin/env node
import * as util from "node:util";
import { compareDirs, summarize } from "../src/compare.js";

const USAGE = `usage: image-dir-diff <before-dir> <after-dir> [options]

Compare two directories of PNG images (matched by relative path) and write a
report of changed, added and removed images.

options:
  -o, --output DIR          report directory (default: image-diff)
      --pixel-threshold N   max per-channel difference (0-1) for a pixel to count
                            as unchanged (default: 0.01)
      --image-threshold N   max fraction of changed pixels for an image to count
                            as unchanged (default: 0.01)
      --concurrency N       images processed in parallel (default: 8)
      --fail-on-diff        exit with code 1 if anything changed
  -h, --help`;

function main() {
  let parsed;
  try {
    parsed = util.parseArgs({
      allowPositionals: true,
      options: {
        before: { type: "string" },
        after: { type: "string" },
        output: { type: "string", short: "o", default: "image-diff" },
        "pixel-threshold": { type: "string", default: "0.01" },
        "image-threshold": { type: "string", default: "0.01" },
        concurrency: { type: "string", default: "8" },
        "fail-on-diff": { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const before = values.before ?? positionals[0];
  const after = values.after ?? positionals[1];
  if (!before || !after) {
    console.error(USAGE);
    return 2;
  }

  return compareDirs({
    before,
    after,
    output: values.output,
    pixelThreshold: parseFloat(values["pixel-threshold"]),
    imageThreshold: parseFloat(values["image-threshold"]),
    concurrency: parseInt(values.concurrency, 10),
  }).then((manifest) => {
    console.log(`image diff: ${summarize(manifest)} (report in ${values.output})`);
    const total = manifest.changed.length + manifest.added.length + manifest.removed.length;
    return values["fail-on-diff"] && total > 0 ? 1 : 0;
  });
}

process.exitCode = await main();
