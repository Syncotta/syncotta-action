import { describe, expect, it } from "vitest";
import type { DiscoverContext, Git } from "../src/discover.js";
import { discoverTexts } from "../src/discover.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

/** Fake git: answers by joined arguments; records calls; null for anything unknown (like a shallow clone). */
function fakeGit(answers: Record<string, string> = {}) {
  const calls: string[] = [];
  const git: Git = (args) => {
    const key = args.join(" ");
    calls.push(key);
    return Promise.resolve(answers[key] ?? null);
  };
  return { git, calls };
}

const ctx = (over: Partial<DiscoverContext>): DiscoverContext => ({
  eventName: "push",
  event: {},
  sha: B,
  ref: "refs/heads/main",
  git: fakeGit().git,
  ...over,
});

describe("discoverTexts", () => {
  it("pull request: title, head branch and the commits between base and head", async () => {
    const { git, calls } = fakeGit({ [`log --format=%B --max-count=1000 ${A}..${B} --`]: "PAY-3 commit" });
    const texts = await discoverTexts(
      ctx({
        eventName: "pull_request",
        event: { pull_request: { title: "PAY-1 login", head: { ref: "PAY-2-branch", sha: B }, base: { sha: A } } },
        git,
      }),
    );
    expect(texts).toEqual([
      { source: "pull request title", text: "PAY-1 login" },
      { source: "branch", text: "PAY-2-branch" },
      { source: "commits", text: "PAY-3 commit" },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("pull request with malformed SHAs does not call git", async () => {
    const { git, calls } = fakeGit();
    await discoverTexts(
      ctx({ eventName: "pull_request_target", event: { pull_request: { head: { sha: "--all" }, base: { sha: A } } }, git }),
    );
    expect(calls).toEqual([]);
  });

  it("push with history: branch name and git log before..after", async () => {
    const { git } = fakeGit({ [`log --format=%B --max-count=1000 ${A}..${B} --`]: "PAY-5 a\n\nPAY-6 b" });
    const texts = await discoverTexts(ctx({ ref: "refs/heads/PAY-4-x", event: { before: A, after: B }, git }));
    expect(texts).toEqual([
      { source: "branch", text: "PAY-4-x" },
      { source: "commits", text: "PAY-5 a\n\nPAY-6 b" },
    ]);
  });

  it("push from a shallow clone falls back to the payload's commits and head commit", async () => {
    const texts = await discoverTexts(
      ctx({
        event: {
          before: A,
          after: B,
          commits: [{ message: "PAY-7 one" }, { message: "PAY-8 two" }, { id: "no message" }],
          head_commit: { message: "PAY-8 two" },
        },
      }),
    );
    expect(texts).toEqual([
      { source: "branch", text: "main" },
      { source: "commits", text: "PAY-7 one\nPAY-8 two\n" },
      { source: "head commit", text: "PAY-8 two" },
    ]);
  });

  it("push of a new branch (before is all zeros) skips the range", async () => {
    const { git, calls } = fakeGit();
    await discoverTexts(ctx({ event: { before: "0".repeat(40), after: B, head_commit: { message: "PAY-9" } }, git }));
    expect(calls).toEqual([]);
  });

  it("tag push: commits since the previous tag", async () => {
    const { git } = fakeGit({
      [`describe --tags --abbrev=0 ${C}^`]: "v1.4.1\n",
      [`log --format=%B --max-count=1000 v1.4.1..${C} --`]: "PAY-10 release",
    });
    const texts = await discoverTexts(ctx({ ref: "refs/tags/v1.4.2", sha: C, event: { before: A, after: C }, git }));
    expect(texts).toEqual([{ source: "commits", text: "PAY-10 release" }]);
  });

  it("never passes a previous tag starting with '-' to git log (option injection, M5.2)", async () => {
    const { git, calls } = fakeGit({ [`describe --tags --abbrev=0 ${C}^`]: "--output=/tmp/x\n" });
    const texts = await discoverTexts(
      ctx({ ref: "refs/tags/v1.4.2", sha: C, event: { before: "0".repeat(40), after: C, head_commit: { message: "PAY-14" } }, git }),
    );
    expect(texts).toEqual([{ source: "head commit", text: "PAY-14" }]);
    expect(calls.filter((c) => c.startsWith("log"))).toEqual([]);
  });

  it("first tag (no previous tag) falls back to the push handling", async () => {
    const texts = await discoverTexts(
      ctx({ ref: "refs/tags/v1.0.0", sha: C, event: { before: A, after: C, head_commit: { message: "PAY-11" } } }),
    );
    expect(texts).toEqual([{ source: "head commit", text: "PAY-11" }]);
  });

  it("other events (workflow_dispatch, release): branch and the head commit message", async () => {
    const { git } = fakeGit({ [`log -1 --format=%B ${B} --`]: "PAY-12 manual" });
    const texts = await discoverTexts(ctx({ eventName: "workflow_dispatch", ref: "refs/heads/PAY-13-y", git }));
    expect(texts).toEqual([
      { source: "branch", text: "PAY-13-y" },
      { source: "head commit", text: "PAY-12 manual" },
    ]);
  });

  it("ignores a non-object payload and a malformed sha", async () => {
    const { git, calls } = fakeGit();
    expect(await discoverTexts(ctx({ eventName: "release", event: "x", sha: "HEAD", ref: "", git }))).toEqual([]);
    expect(calls).toEqual([]);
  });
});
