/** Minimal GitHub helpers, driven by the standard Actions environment. */

import * as fs from "node:fs";

/** The parsed webhook event, or {} outside of Actions. */
export function readEvent(env = process.env) {
  if (!env.GITHUB_EVENT_PATH) return {};
  try {
    return JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function runUrl(env = process.env) {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return undefined;
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  return `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

/** Append `key=value` pairs to $GITHUB_OUTPUT, if running in Actions. */
export function setOutputs(outputs, env = process.env) {
  if (!env.GITHUB_OUTPUT) return;
  const text = Object.entries(outputs)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
  fs.appendFileSync(env.GITHUB_OUTPUT, text);
}

async function api(method, url, token, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Create a PR comment, or update the first existing one containing `marker`.
 * @returns {Promise<string>} the comment's html_url
 */
export async function upsertComment({ repo, prNumber, body, marker, token, apiUrl = "https://api.github.com" }) {
  let existing;
  for (let page = 1; !existing; page++) {
    const comments = await api(
      "GET",
      `${apiUrl}/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      token,
    );
    existing = comments.find((c) => c.body?.includes(marker));
    if (comments.length < 100) break;
  }
  const res = existing
    ? await api("PATCH", `${apiUrl}/repos/${repo}/issues/comments/${existing.id}`, token, { body })
    : await api("POST", `${apiUrl}/repos/${repo}/issues/${prNumber}/comments`, token, { body });
  return res.html_url;
}
