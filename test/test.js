import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { compareDirs } from "../src/compare.js";
import { run } from "../src/run.js";

const binDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin");

const tmpdirs = [];
after(() => tmpdirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-dir-diff-test-"));
  tmpdirs.push(dir);
  return dir;
}

function writePng(file, w, h, rgba) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set(rgba(i), i * 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}

const solid = (c) => () => c;

test("compareDirs classifies changed, added, removed and unchanged images", async () => {
  const dir = tmpdir();
  const before = path.join(dir, "before");
  const after = path.join(dir, "after");
  writePng(path.join(before, "same.png"), 4, 4, solid([1, 2, 3, 255]));
  writePng(path.join(after, "same.png"), 4, 4, solid([1, 2, 3, 255]));
  // one channel off by 1/255 is below the default pixel threshold
  writePng(path.join(before, "nearly.png"), 4, 4, solid([100, 100, 100, 255]));
  writePng(path.join(after, "nearly.png"), 4, 4, solid([101, 100, 100, 255]));
  writePng(path.join(before, "sub/changed.png"), 4, 4, solid([0, 0, 0, 255]));
  writePng(path.join(after, "sub/changed.png"), 4, 4, (i) => (i < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  writePng(path.join(before, "resized.png"), 4, 4, solid([0, 0, 0, 255]));
  writePng(path.join(after, "resized.png"), 2, 2, solid([0, 0, 0, 255]));
  writePng(path.join(before, "gone.png"), 1, 1, solid([0, 0, 0, 255]));
  writePng(path.join(after, "new.png"), 1, 1, solid([0, 0, 0, 255]));

  const output = path.join(dir, "out");
  const manifest = await compareDirs({ before, after, output });

  assert.deepEqual(
    manifest.changed.map((c) => [c.name, c.changed_fraction]),
    [["resized.png", 1], ["sub/changed.png", 0.5]],
  );
  assert.deepEqual(manifest.added, ["new.png"]);
  assert.deepEqual(manifest.removed, ["gone.png"]);
  assert.ok(fs.existsSync(path.join(output, "changed/sub__changed.diff.png")));
  assert.ok(!fs.existsSync(path.join(output, "changed/resized.diff.png")));
  assert.ok(fs.existsSync(path.join(output, "added/new.png")));
  assert.ok(fs.existsSync(path.join(output, "removed/gone.png")));
  const inline = JSON.parse(fs.readFileSync(path.join(output, "inline-manifest.json"), "utf8"));
  assert.deepEqual(inline.map((e) => e.name), ["resized.png", "sub/changed.png"]);

  const diff = PNG.sync.read(fs.readFileSync(path.join(output, "changed/sub__changed.diff.png")));
  assert.deepEqual([...diff.data.subarray(0, 4)], [255, 0, 0, 255]); // changed → red
  assert.deepEqual([...diff.data.subarray(32, 36)], [0, 0, 0, 255]); // unchanged → after
});

test("image-dir-diff CLI exits 1 with --fail-on-diff", () => {
  const dir = tmpdir();
  writePng(path.join(dir, "a/x.png"), 1, 1, solid([0, 0, 0, 255]));
  fs.mkdirSync(path.join(dir, "b"));
  const cli = path.join(binDir, "image-dir-diff.js");
  const args = [cli, path.join(dir, "a"), path.join(dir, "b"), "-o", path.join(dir, "out")];
  execFileSync("node", args, { stdio: "pipe" });
  assert.throws(() => execFileSync("node", [...args, "--fail-on-diff"], { stdio: "pipe" }), { status: 1 });
});

test("run diffs a subdirectory's snapshots against a base ref", async () => {
  const repo = tmpdir();
  const g = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  g("init", "-q", "-b", "master");
  // snapshot generator: one PNG per line of colors.txt, colored by the line
  const gen = `
    const fs = require("fs"), { PNG } = require(${JSON.stringify(require_pngjs())});
    fs.mkdirSync("out/snaps", { recursive: true });
    for (const line of fs.readFileSync("colors.txt", "utf8").trim().split("\\n")) {
      const [name, v] = line.split(" ");
      const png = new PNG({ width: 2, height: 2 });
      png.data.fill(Number(v));
      fs.writeFileSync("out/snaps/" + name + ".png", PNG.sync.write(png));
    }`;
  fs.mkdirSync(path.join(repo, "app"));
  fs.writeFileSync(path.join(repo, "app/gen.cjs"), gen);
  fs.writeFileSync(path.join(repo, ".gitignore"), "out\nsnapshot-diff\n");
  fs.writeFileSync(path.join(repo, "app/colors.txt"), "a 10\nb 20\nc 30\n");
  g("add", "-A");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  g("checkout", "-qb", "feature");
  fs.writeFileSync(path.join(repo, "app/colors.txt"), "a 10\nb 200\nd 40\n");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "change");

  const { manifest, outputDir } = await run({
    command: "node gen.cjs",
    snapshotsDir: "out/snaps",
    baseRef: "master",
    fetch: false,
    cwd: path.join(repo, "app"),
  });
  assert.equal(outputDir, fs.realpathSync(path.join(repo, "app/snapshot-diff")));
  assert.deepEqual(manifest.changed.map((c) => c.name), ["b.png"]);
  assert.deepEqual(manifest.added, ["d.png"]);
  assert.deepEqual(manifest.removed, ["c.png"]);
  assert.match(fs.readFileSync(path.join(outputDir, "comment.md"), "utf8"), /1 changed, 1 added, 1 removed/);
  // the temporary base worktree is cleaned up
  assert.equal(g("worktree", "list").toString().trim().split("\n").length, 1);

  // refuses to clobber a directory that isn't a previous report
  await assert.rejects(
    run({ command: "true", snapshotsDir: "out/snaps", baseRef: "master", fetch: false, cwd: repo, output: "app" }),
    /refusing to overwrite/,
  );
});

function require_pngjs() {
  return path.dirname(fileURLToPath(import.meta.resolve("pngjs/package.json")));
}
