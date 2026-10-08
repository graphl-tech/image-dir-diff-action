/**
 * Generate snapshots on the current checkout and on a base git ref, then diff
 * them. This is the whole GitHub Action; it also runs fine locally.
 *
 *   1. run `command` in `cwd` and copy `snapshotsDir` aside ("after")
 *   2. resolve `baseRef` (fetching it from `remote` first)
 *   3. take the base snapshots from the artifacts repo cache if present,
 *      otherwise check the base out in a temporary worktree and run
 *      `baseCommand` there ("before")
 *   4. diff before/after into `output`, write `output/comment.md`
 *   5. optionally publish `output` (plus the raw "after" snapshots, to serve
 *      as a future cache) to the artifacts repo, and post a PR comment
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compareDirs, summarize } from "./compare.js";
import { buildComment, COMMENT_MARKER } from "./comment.js";
import { readEvent, runUrl, setOutputs, upsertComment } from "./github.js";

const log = (msg) => console.error(`[image-dir-diff] ${msg}`);

function git(args, cwd, { quiet = true } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", quiet ? "pipe" : "inherit"],
  }).trim();
}

function tryGit(args, cwd, opts) {
  try {
    return git(args, cwd, opts);
  } catch {
    return null;
  }
}

/** Run a shell command, inheriting stdio. Resolves to the exit code. */
function sh(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(signal ? 128 : code));
  });
}

function resolveBase({ repoRoot, baseRef, remote, fetch }) {
  if (fetch) {
    const shallow = tryGit(["rev-parse", "--is-shallow-repository"], repoRoot) === "true";
    const args = ["fetch", "--no-tags", "--no-recurse-submodules", ...(shallow ? ["--depth=1"] : []), remote, baseRef];
    if (tryGit(args, repoRoot, { quiet: false }) !== null) {
      return git(["rev-parse", "FETCH_HEAD^{commit}"], repoRoot);
    }
    log(`could not fetch ${remote} ${baseRef}; looking for it locally`);
  }
  for (const candidate of [baseRef, `${remote}/${baseRef}`]) {
    const sha = tryGit(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], repoRoot);
    if (sha) return sha;
  }
  throw new Error(`could not resolve base ref '${baseRef}'`);
}

function artifactsUrl(repo, token, serverUrl) {
  const u = new URL(`${serverUrl}/${repo}.git`);
  if (token) {
    u.username = "x-access-token";
    u.password = token;
  }
  return u.toString();
}

const cacheBranch = (sha) => `${sha.slice(0, 10)}_snapshots`;

/** Is `dir` safe to wipe before writing a fresh report into it? */
async function isReplaceableOutput(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return true;
  }
  return entries.length === 0 || entries.includes("manifest.json");
}

/**
 * @param {object} opts
 * @param {string} opts.command shell command that generates the snapshots
 * @param {string} opts.snapshotsDir where `command` writes PNGs, relative to `cwd`
 * @param {string} [opts.baseCommand] command to run on the base ref (default: `command`)
 * @param {string} [opts.baseRef] branch, tag or SHA to compare against
 * @param {string} [opts.remote]
 * @param {boolean} [opts.fetch] fetch `baseRef` from `remote` before resolving it
 * @param {string} [opts.cwd] where to run the commands; mirrored inside the base worktree
 * @param {string} [opts.output] report directory, relative to `cwd`
 * @param {boolean} [opts.skipHead] don't run `command` on the current checkout; use the snapshots already there
 * @param {boolean} [opts.clean] delete `snapshotsDir` before running `command` on the current checkout
 * @param {number} [opts.pixelThreshold]
 * @param {number} [opts.imageThreshold]
 * @param {number} [opts.concurrency]
 * @param {string} [opts.artifactsRepo] owner/name of a repo to cache snapshots in and publish the diff to
 * @param {string} [opts.artifactsToken]
 * @param {boolean} [opts.comment] post or update a comment on the current pull request
 * @param {string} [opts.commentTitle]
 * @param {string} [opts.githubToken]
 * @param {string} [opts.artifactName] name the CI uploads the report as, for a link in the comment
 */
export async function run({
  command,
  snapshotsDir,
  baseCommand = command,
  baseRef = process.env.GITHUB_BASE_REF || "master",
  remote = "origin",
  fetch = true,
  cwd = process.cwd(),
  output = "snapshot-diff",
  skipHead = false,
  clean = false,
  pixelThreshold = 0.01,
  imageThreshold = 0.01,
  concurrency = 8,
  artifactsRepo,
  artifactsToken = process.env.IMAGE_DIR_DIFF_ARTIFACTS_TOKEN,
  comment = false,
  commentTitle = "Snapshot diff",
  githubToken = process.env.GITHUB_TOKEN,
  artifactName,
}) {
  if (!command && !skipHead) throw new Error("a command is required (or skipHead)");
  if (!baseCommand) throw new Error("a base command is required");
  if (!snapshotsDir) throw new Error("snapshotsDir is required");

  cwd = fs.realpathSync(cwd);
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
  const relCwd = path.relative(repoRoot, cwd);
  const outputDir = path.resolve(cwd, output);
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";

  if (!(await isReplaceableOutput(outputDir))) {
    throw new Error(`refusing to overwrite ${outputDir}: it exists and isn't a previous report`);
  }
  await fs.promises.rm(outputDir, { recursive: true, force: true });

  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "image-dir-diff-"));
  const baseWorktree = path.join(tmp, "base");
  const afterSnaps = path.join(tmp, "after");
  let worktreeAdded = false;

  const cleanup = () => {
    if (worktreeAdded) tryGit(["worktree", "remove", "--force", baseWorktree], repoRoot);
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  const onSignal = (sig) => {
    cleanup();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    // 1. current checkout
    const headSnaps = path.resolve(cwd, snapshotsDir);
    if (!skipHead) {
      if (clean) await fs.promises.rm(headSnaps, { recursive: true, force: true });
      log(`generating snapshots: ${command}`);
      const code = await sh(command, cwd);
      if (code !== 0) throw new Error(`snapshot command failed with exit code ${code}`);
    }
    if (fs.existsSync(headSnaps)) {
      await fs.promises.cp(headSnaps, afterSnaps, { recursive: true });
    } else {
      log(`warning: ${snapshotsDir} does not exist after generating snapshots`);
    }

    // 2. base ref
    const baseSha = resolveBase({ repoRoot, baseRef, remote, fetch });
    log(`base: ${baseRef} (${baseSha.slice(0, 10)})`);

    // 3. base snapshots, from the cache or freshly generated
    let beforeSnaps = null;
    const url = artifactsRepo && artifactsUrl(artifactsRepo, artifactsToken, serverUrl);
    if (url) {
      const branch = cacheBranch(baseSha);
      const cacheDir = path.join(tmp, "cache");
      if (
        tryGit(["ls-remote", "--exit-code", "--heads", url, branch], tmp) !== null &&
        tryGit(["clone", "--quiet", "--depth=1", "--branch", branch, url, cacheDir], tmp) !== null &&
        fs.existsSync(path.join(cacheDir, "snapshots"))
      ) {
        log(`using cached base snapshots from ${artifactsRepo}@${branch}`);
        beforeSnaps = path.join(cacheDir, "snapshots");
      }
    }
    if (!beforeSnaps) {
      git(["worktree", "add", "--detach", baseWorktree, baseSha], repoRoot);
      worktreeAdded = true;
      const baseCwd = path.join(baseWorktree, relCwd);
      log(`generating base snapshots: ${baseCommand}`);
      const code = await sh(baseCommand, baseCwd);
      if (code !== 0) {
        log(`warning: base snapshot command failed with exit code ${code}; diffing whatever it produced`);
      }
      beforeSnaps = path.resolve(baseCwd, snapshotsDir);
    }

    // 4. diff
    const manifest = await compareDirs({
      before: beforeSnaps,
      after: afterSnaps,
      output: outputDir,
      pixelThreshold,
      imageThreshold,
      concurrency,
    });
    log(`snapshot diff: ${summarize(manifest)}`);

    // 5. publish
    let publishedBranch;
    if (url) {
      const headSha = git(["rev-parse", "HEAD"], repoRoot);
      const branch = cacheBranch(headSha);
      if (fs.existsSync(afterSnaps)) {
        await fs.promises.cp(afterSnaps, path.join(outputDir, "snapshots"), { recursive: true });
      }
      const pubDir = path.join(tmp, "publish");
      await fs.promises.cp(outputDir, pubDir, { recursive: true });
      const id = ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com"];
      const ok =
        tryGit(["-c", "init.defaultBranch=main", "init", "--quiet"], pubDir) !== null &&
        tryGit(["add", "-A", "."], pubDir) !== null &&
        tryGit([...id, "commit", "--quiet", "-m", `snapshot diff for ${headSha.slice(0, 10)}`], pubDir) !== null &&
        tryGit(["push", "--quiet", "--force", url, `HEAD:refs/heads/${branch}`], pubDir) !== null;
      if (ok) {
        publishedBranch = branch;
        log(`published to ${artifactsRepo}@${branch}`);
      } else {
        log(`warning: failed to publish to ${artifactsRepo}@${branch}`);
      }
    }

    const body = await buildComment({
      outputDir,
      title: commentTitle,
      runUrl: runUrl(),
      artifactName,
      serverUrl,
      artifactsRepo,
      branch: publishedBranch,
    });
    await fs.promises.writeFile(path.join(outputDir, "comment.md"), body);

    let commentUrl;
    if (comment) {
      const prNumber = readEvent().pull_request?.number;
      if (!prNumber) {
        log("not a pull request; skipping comment");
      } else if (!githubToken) {
        log("no GitHub token; skipping comment");
      } else {
        try {
          commentUrl = await upsertComment({
            repo: process.env.GITHUB_REPOSITORY,
            prNumber,
            body,
            marker: COMMENT_MARKER,
            token: githubToken,
            apiUrl: process.env.GITHUB_API_URL,
          });
          log(`commented: ${commentUrl}`);
        } catch (err) {
          log(`warning: failed to comment: ${err.message}`);
        }
      }
    }

    const total = manifest.changed.length + manifest.added.length + manifest.removed.length;
    setOutputs({
      "output-dir": outputDir,
      changed: manifest.changed.length,
      added: manifest.added.length,
      removed: manifest.removed.length,
      total,
      "base-sha": baseSha,
      branch: publishedBranch ?? "",
      "comment-url": commentUrl ?? "",
    });

    return { manifest, total, outputDir, baseSha, branch: publishedBranch, commentUrl };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    cleanup();
  }
}
