#!/usr/bin/env node
/**
 * Fallback deploy for when GitHub Actions Pages is unavailable: commits the contents of dist/ (plus
 * .nojekyll) as the next commit of the gh-pages branch through a temporary git worktree, and pushes
 * it. Pages then serves the branch ("Deploy from a branch", gh-pages, / (root)). No dependencies.
 *   pnpm deploy:gh-pages                      (builds first)
 *   node scripts/deploy-gh-pages.mjs [--remote=origin] [--branch=gh-pages] [--no-push]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const arg = (n, d) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const REMOTE = arg("remote", "origin");
const BRANCH = arg("branch", "gh-pages");
const PUSH = !process.argv.includes("--no-push");

// Built files are committed byte for byte, whatever the user's core.autocrlf says.
const git = (args, cwd = ROOT) =>
  execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const tryGit = (args, cwd) => {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
};
const fail = (msg) => {
  console.error(`deploy-gh-pages: ${msg}`);
  process.exit(1);
};

let wt = null;
const cleanup = () => {
  if (!wt) return;
  const dir = wt;
  wt = null;
  if (tryGit(["worktree", "remove", "--force", dir]) === null) {
    fs.rmSync(dir, { recursive: true, force: true });
    tryGit(["worktree", "prune"]);
  }
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
for (const ev of ["uncaughtException", "unhandledRejection"])
  process.on(ev, (e) => fail(e?.stderr?.toString().trim() || e?.message || String(e)));

if (!fs.existsSync(path.join(DIST, "index.html"))) fail("dist/index.html is missing; run pnpm build first.");
const remoteUrl = tryGit(["remote", "get-url", REMOTE]);
if (PUSH && !remoteUrl) fail(`no git remote "${REMOTE}"; add it first, or pass --no-push.`);

const source = git(["rev-parse", "--short", "HEAD"]);
if (git(["status", "--porcelain", "--untracked-files=no"]))
  console.warn(`deploy-gh-pages: the working tree has uncommitted changes; dist/ may not match ${source}.`);

// Build on the remote branch when there is one, so the push is a fast-forward; a first deploy is a root commit.
let base = null;
if (PUSH && git(["ls-remote", "--heads", REMOTE, BRANCH])) {
  const tracking = `refs/remotes/${REMOTE}/${BRANCH}`;
  git(["fetch", "--no-tags", REMOTE, `+refs/heads/${BRANCH}:${tracking}`]);
  base = git(["rev-parse", tracking]);
} else {
  base = tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}^{commit}`]);
}

wt = path.join(os.tmpdir(), `bay-ride-${BRANCH}-${process.pid}-${Date.now()}`);
git(["worktree", "add", "--detach", "--no-checkout", wt, base ?? "HEAD"]);
git(["read-tree", "--empty"], wt);
fs.cpSync(DIST, wt, { recursive: true });
fs.writeFileSync(path.join(wt, ".nojekyll"), "");
git(["add", "--all", "--force", "."], wt);
const tree = git(["write-tree"], wt);
const files = git(["ls-files"], wt).split("\n").filter(Boolean).length;

let commit = base;
if (base && git(["rev-parse", `${base}^{tree}`]) === tree) {
  console.log(`${BRANCH} already holds this build (${base.slice(0, 7)}); nothing new to commit.`);
} else {
  const message = `Deploy ${source}: the built site (dist/) for GitHub Pages`;
  commit = git(["commit-tree", tree, ...(base ? ["-p", base] : []), "-m", message]);
  git(["update-ref", `refs/heads/${BRANCH}`, commit]);
  console.log(`Committed ${commit.slice(0, 7)} to ${BRANCH}: ${files} files from dist/ (source ${source}).`);
}
cleanup();

if (!PUSH) {
  console.log(`Not pushed (--no-push). Inspect with: git show --stat ${BRANCH}`);
  process.exit(0);
}
git(["push", REMOTE, `${commit}:refs/heads/${BRANCH}`]);
console.log(`Pushed ${BRANCH} to ${REMOTE}.`);
const slug = remoteUrl.match(/github\.com[:/](.+?\/.+?)(?:\.git)?\/?$/)?.[1];
if (slug) {
  const [owner, repo] = slug.split("/");
  console.log(
    `If Pages does not serve ${BRANCH} yet:\n` +
      `  gh api -X POST repos/${slug}/pages -f build_type=legacy -f "source[branch]=${BRANCH}" -f "source[path]=/"\n` +
      `  (use -X PUT instead of POST if Pages is already set up for Actions)\n` +
      `Site: https://${owner.toLowerCase()}.github.io/${repo}/`,
  );
}
