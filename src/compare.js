/**
 * Compare two directories of PNG images and produce a diff report.
 *
 * A pixel is "changed" if any RGBA channel differs by more than
 * `pixelThreshold` (default 1% of 255). Two images are "different" if more
 * than `imageThreshold` (default 1%) of their pixels are changed.
 *
 * Output layout:
 *   output/
 *     manifest.json
 *     changed/<name>.before.png, <name>.after.png, <name>.diff.png
 *     added/<name>.png
 *     removed/<name>.png
 *     inline/<i>.before.png, <i>.after.png, <i>.diff.png   (top `maxInline`)
 *     inline-manifest.json                                  (index→name map)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";

/**
 * @typedef {{ name: string, changed_pixels: number, total_pixels: number, changed_fraction: number }} ChangeEntry
 * @typedef {{ changed: ChangeEntry[], added: string[], removed: string[], pixel_threshold: number, image_threshold: number }} Manifest
 * @typedef {{ index: number, name: string, changed_fraction: number }} InlineEntry
 */

/** @returns {Promise<Map<string, string>>} relative path → absolute path */
async function walkPngs(root, limit) {
  const out = new Map();
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      return;
    }
    await mapLimit(entries, limit, async (entry) => {
      const full = path.join(dir, entry);
      const st = await fs.promises.stat(full);
      if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile() && entry.toLowerCase().endsWith(".png")) {
        // always use "/" so names are stable across platforms
        out.set(path.relative(root, full).split(path.sep).join("/"), full);
      }
    });
  }
  await walk(root);
  return out;
}

async function readPng(p) {
  const buf = await fs.promises.readFile(p);
  return PNG.sync.read(buf);
}

/**
 * @param {PNG} before
 * @param {PNG} after
 * @param {number} pixelThreshold
 * @returns {{ changedPixels: number, totalPixels: number, diff: PNG | null }}
 */
export function comparePngs(before, after, pixelThreshold) {
  if (before.width !== after.width || before.height !== after.height) {
    const total = after.width * after.height;
    return { changedPixels: total, totalPixels: total, diff: null };
  }

  const w = after.width;
  const h = after.height;
  const total = w * h;
  const cutoff = pixelThreshold * 255;

  const diff = new PNG({ width: w, height: h });
  let changed = 0;

  const a = before.data;
  const b = after.data;
  const d = diff.data;

  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const dr = Math.abs(a[o] - b[o]);
    const dg = Math.abs(a[o + 1] - b[o + 1]);
    const db = Math.abs(a[o + 2] - b[o + 2]);
    const da = Math.abs(a[o + 3] - b[o + 3]);
    const max = Math.max(dr, dg, db, da);
    if (max > cutoff) {
      changed++;
      // red overlay on top of "after"
      d[o] = 255;
      d[o + 1] = 0;
      d[o + 2] = 0;
      d[o + 3] = 255;
    } else {
      d[o] = b[o];
      d[o + 1] = b[o + 1];
      d[o + 2] = b[o + 2];
      d[o + 3] = b[o + 3];
    }
  }

  return { changedPixels: changed, totalPixels: total, diff };
}

function safeName(rel) {
  return rel.replace(/[\\/]/g, "__");
}

/**
 * Run `fn` over `items` with at most `limit` tasks in flight at any time.
 * Results are returned in input order.
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

/**
 * Compare two image directories, writing the report to `output`.
 * A missing `before` or `after` directory is treated as empty.
 *
 * @param {object} opts
 * @param {string} opts.before
 * @param {string} opts.after
 * @param {string} opts.output
 * @param {number} [opts.pixelThreshold]
 * @param {number} [opts.imageThreshold]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.maxInline] how many of the most-changed images get stable-named copies in inline/
 * @returns {Promise<Manifest>}
 */
export async function compareDirs({
  before,
  after,
  output,
  pixelThreshold = 0.01,
  imageThreshold = 0.01,
  concurrency = 8,
  maxInline = 5,
}) {
  concurrency = Math.max(1, concurrency);

  const [beforeImgs, afterImgs] = await Promise.all([
    walkPngs(before, concurrency),
    walkPngs(after, concurrency),
  ]);

  await fs.promises.mkdir(output, { recursive: true });
  const changedDir = path.join(output, "changed");
  const addedDir = path.join(output, "added");
  const removedDir = path.join(output, "removed");

  const added = [...afterImgs.keys()].filter((k) => !beforeImgs.has(k)).sort();
  const removed = [...beforeImgs.keys()].filter((k) => !afterImgs.has(k)).sort();
  const inBoth = [...beforeImgs.keys()].filter((k) => afterImgs.has(k)).sort();

  if (added.length) await fs.promises.mkdir(addedDir, { recursive: true });
  if (removed.length) await fs.promises.mkdir(removedDir, { recursive: true });
  if (inBoth.length) await fs.promises.mkdir(changedDir, { recursive: true });

  // Each in-flight inBoth task holds two decoded PNGs + (usually) a diff PNG
  // in memory, so this is the dominant memory pressure point — bound it
  // explicitly. The copy-only loops are cheap by comparison but share the
  // same limit for simplicity and to cap fd usage.
  const [, , inBothResults] = await Promise.all([
    mapLimit(added, concurrency, (name) =>
      fs.promises.copyFile(afterImgs.get(name), path.join(addedDir, safeName(name))),
    ),
    mapLimit(removed, concurrency, (name) =>
      fs.promises.copyFile(beforeImgs.get(name), path.join(removedDir, safeName(name))),
    ),
    mapLimit(inBoth, concurrency, async (name) => {
      const [beforePng, afterPng] = await Promise.all([
        readPng(beforeImgs.get(name)),
        readPng(afterImgs.get(name)),
      ]);
      const { changedPixels, totalPixels, diff } = comparePngs(beforePng, afterPng, pixelThreshold);
      const fraction = totalPixels === 0 ? 0 : changedPixels / totalPixels;
      if (fraction <= imageThreshold) return null;
      const stem = safeName(name).replace(/\.png$/i, "");
      await Promise.all([
        fs.promises.copyFile(beforeImgs.get(name), path.join(changedDir, `${stem}.before.png`)),
        fs.promises.copyFile(afterImgs.get(name), path.join(changedDir, `${stem}.after.png`)),
        diff
          ? fs.promises.writeFile(path.join(changedDir, `${stem}.diff.png`), PNG.sync.write(diff))
          : Promise.resolve(),
      ]);
      return {
        name,
        changed_pixels: changedPixels,
        total_pixels: totalPixels,
        changed_fraction: fraction,
      };
    }),
  ]);
  const changed = inBothResults.filter((r) => r !== null);

  if (inBoth.length && !changed.length) await fs.promises.rm(changedDir, { recursive: true, force: true });

  /** @type {Manifest} */
  const manifest = {
    changed,
    added,
    removed,
    pixel_threshold: pixelThreshold,
    image_threshold: imageThreshold,
  };
  await fs.promises.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Stable-named copies of the most-changed snapshots so they can be
  // referenced individually (e.g. embedded in a PR comment).
  const topChanged = [...changed]
    .sort((a, b) => b.changed_fraction - a.changed_fraction)
    .slice(0, maxInline);
  if (topChanged.length > 0) {
    const inlineDir = path.join(output, "inline");
    await fs.promises.mkdir(inlineDir, { recursive: true });
    const inlineManifest = await Promise.all(
      topChanged.map(async (entry, i) => {
        const stem = safeName(entry.name).replace(/\.png$/i, "");
        await Promise.all(
          ["before", "after", "diff"].map(async (kind) => {
            const src = path.join(changedDir, `${stem}.${kind}.png`);
            try {
              await fs.promises.copyFile(src, path.join(inlineDir, `${i}.${kind}.png`));
            } catch {
              // diff may be absent if before/after sizes differ
            }
          }),
        );
        return { index: i, name: entry.name, changed_fraction: entry.changed_fraction };
      }),
    );
    await fs.promises.writeFile(
      path.join(output, "inline-manifest.json"),
      JSON.stringify(inlineManifest, null, 2) + "\n",
    );
  }

  return manifest;
}

/** @param {Manifest} manifest */
export function summarize(manifest) {
  return `${manifest.changed.length} changed, ${manifest.added.length} added, ${manifest.removed.length} removed`;
}
