# image-dir-diff

Find visual changes between two sets of PNG snapshots, and a tool
for posting a comment to GitHub with the most changed.

- **`image-dir-diff`**: a script that diffs two directories of PNGs.
- **`image-dir-diff-run`**: a script that runs your snapshot command
  on the current checkout and on a base git ref (in a temporary worktree),
  then diffs the two sets.
- **A GitHub Action** that wraps `image-dir-diff-run`, uploads the
  report and comments on the PR.

## Report

Images are matched by relative path. A pixel counts as changed when any RGBA channel differs by more than `--pixel-threshold` (default `0.01`, i.e. 1% of 255). An image counts as changed when more than `--image-threshold` (default 1%) of its pixels changed.

```
<output>/
  manifest.json          { changed: [{name, changed_fraction, ...}], added: [...], removed: [...] }
  changed/<name>.{before,after,diff}.png   diff = "after" with changed pixels in red
  added/<name>.png
  removed/<name>.png
  inline/<i>.{before,after,diff}.png       the 5 most-changed images, under stable names
  comment.md             markdown summary (image-dir-diff-run only)
```

## CLI

Requires Node 18.17 or newer.

```sh
npm install -g github:graphl-tech/image-dir-diff-action

image-dir-diff before/ after/ -o image-diff [--fail-on-diff]

# from inside a repo: generate snapshots here and on master, then diff them
image-dir-diff-run --command "make snapshots" --snapshots-dir out/snapshots --base-ref master
```

Run either one with `--help` to see all options.
Without a global install, use

```sh
npx -p github:graphl-tech/image-dir-diff-action image-dir-diff-run ...
```

`image-dir-diff-run` fetches the base ref from `origin`
(pass `--no-fetch` to use your local ref).
`--command` and `--snapshots-dir` are relative to `--cwd`,
and the same subdirectory is used inside the base worktree.
If the command fails on the current checkout, the run aborts.
If it fails on the base ref, the run only warns and diffs whatever
snapshots it produced.

## GitHub Action

Example for a DVUI app where `cd ide && zig build test`
writes snapshot images into `ide/snapshots/images`
when `DVUI_SNAPSHOT_WRITE=1` is set:

```yaml
name: snapshots

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write # for the PR comment

jobs:
  snapshots:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # add your actual setup steps
      - uses: graphl-tech/image-dir-diff-action@main # you should pin a commit
        env:
          DVUI_SNAPSHOT_WRITE: "1"
        with:
          working-directory: ide
          command: xvfb-run -a zig build test -Ddvui-backend=sdl3
          snapshots-dir: snapshots/images
          # optional: show before/after/diff images inline in the PR comment
          # (we use a repo since artifacts don't have the correct content type
          # to display in PR comments)
          artifacts-repo: graphl-tech/an-extra-repo
          artifacts-token: ${{ secrets.GRAPHL_ARTIFACTS_REPO_PAT }}
```

### Snapshots repo

GitHub doesn't serve images correctly in workflow artifacts,
so they can't be embedded in a comment. If you set `artifacts-repo`,
the action force-pushes each report, along with the raw snapshots,
to a branch `<sha10>_snapshots` of that repo. The PR comment then embeds the most-changed images from that branch. Reviewers need read access to the artifacts repo to see them.

Those branches also act as a cache. When a branch already exists for the
base commit, its snapshots are used instead of rebuilding the base.
