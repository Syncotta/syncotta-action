import { describe, expect, it } from "vitest";
import type { CiRequest, CiResult } from "../src/client.js";
import type { RunDeps } from "../src/run.js";
import { ciUrl, run } from "../src/run.js";
import { workflow } from "../src/workflow.js";

const KEY = "ab".repeat(32);
const URL_IN = "https://abc.webtrigger.atlassian.app/public/xyz/events";
const SHA = "c".repeat(40);

function setup(inputs: Record<string, string>, over: Partial<RunDeps> = {}, result: CiResult = { ok: true, status: 202, attempts: 1 }) {
  const lines: string[] = [];
  const outputs: string[] = [];
  const sent: CiRequest[] = [];
  const env: Record<string, string | undefined> = {
    GITHUB_SHA: SHA,
    GITHUB_REF: "refs/heads/PAY-2-login",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REPOSITORY: "acme/payments",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_OUTPUT: "/tmp/out",
  };
  for (const [k, v] of Object.entries({ "events-url": URL_IN, "instance-id": "argo-prod", "hmac-key": KEY, image: `ghcr.io/acme/pay:1.0@sha256:${"d".repeat(64)}`, ...inputs })) {
    env[`INPUT_${k.toUpperCase()}`] = v;
  }
  const deps: RunDeps = {
    wf: workflow({ env, write: (l) => lines.push(l), appendFile: (_p, d) => outputs.push(d) }),
    env,
    readEvent: () => ({ head_commit: { message: "PAY-1 fix" } }),
    git: () => Promise.resolve(null),
    post: (r) => (sent.push(r), Promise.resolve(result)),
    fetch: () => Promise.reject(new Error("fetch not expected")),
    ...over,
  };
  const output = (name: string) => {
    const block = outputs.find((o) => o.startsWith(`${name}<<`));
    return block?.split("\n")[1];
  };
  return { deps, lines, sent, output };
}

describe("ciUrl", () => {
  it.each([
    [URL_IN, "https://abc.webtrigger.atlassian.app/public/xyz/ci"],
    ["https://abc.webtrigger.atlassian.app/public/xyz", "https://abc.webtrigger.atlassian.app/public/xyz/ci"],
    ["https://abc.webtrigger.atlassian.app/public/xyz/ci/", "https://abc.webtrigger.atlassian.app/public/xyz/ci"],
  ])("%s", (input, want) => expect(ciUrl(input)).toBe(want));

  it.each(["http://abc/x", "https://abc/x?k=1", "not a url"])("rejects %s", (input) => {
    expect(() => ciUrl(input)).toThrow();
  });
});

describe("run", () => {
  it("discovers keys, sends the payload and sets outputs", async () => {
    const { deps, sent, output, lines } = setup({ tags: "1.0, 1\nlatest" });
    await expect(run(deps)).resolves.toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://abc.webtrigger.atlassian.app/public/xyz/ci");
    expect(JSON.parse(sent[0]!.body)).toEqual({
      schema: 1,
      image: `ghcr.io/acme/pay:1.0@sha256:${"d".repeat(64)}`,
      tags: ["1.0", "1", "latest"],
      repository: "github.com/acme/payments",
      commit: SHA,
      issueKeys: ["PAY-2", "PAY-1"],
    });
    expect(output("issue-keys")).toBe("PAY-2,PAY-1");
    expect(output("status")).toBe("sent");
    const log = lines.join("");
    expect(log).toContain(`::add-mask::${KEY}`);
    expect(log).toContain(`::add-mask::${URL_IN}`);
    const rest = log.replace(`::add-mask::${KEY}`, "").replace(`::add-mask::${URL_IN}`, "");
    expect(rest).not.toContain(KEY);
    expect(rest).not.toContain("webtrigger");
  });

  it("uses the issue-keys input instead of discovery", async () => {
    const { deps, sent } = setup({ "issue-keys": "OPS-1, OPS-2,OPS-1", repository: "gitlab.example/x", commit: "abc1234" });
    await run(deps);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ issueKeys: ["OPS-1", "OPS-2"], repository: "gitlab.example/x", commit: "abc1234" });
  });

  it("sends nothing when no keys are found", async () => {
    const { deps, sent, output } = setup({}, { readEvent: () => ({}), env: { GITHUB_REF: "refs/heads/main" } });
    await expect(run(deps)).resolves.toBe(0);
    expect(sent).toEqual([]);
    expect(output("status")).toBe("skipped");
  });

  it("notes a missing digest", async () => {
    const { deps, lines } = setup({ image: "ghcr.io/acme/pay:1.0" });
    await run(deps);
    expect(lines.join("")).toContain("::notice::image has no digest");
  });

  it.each([
    [{ "instance-id": "Bad" }, "instance-id"],
    [{ "hmac-key": "short" }, "hmac-key"],
    [{ image: "" }, "image is required"],
    [{ "events-url": "http://x/events" }, "events-url"],
    [{ commit: "zz" }, "commit"],
    [{ "issue-keys": "PAY-1,nope" }, "malformed key"],
  ])("input error %j warns and continues by default", async (inputs, message) => {
    const { deps, lines, sent, output } = setup(inputs);
    await expect(run(deps)).resolves.toBe(0);
    expect(sent).toEqual([]);
    expect(output("status")).toBe("failed");
    expect(lines.join("")).toMatch(new RegExp(`::warning::Syncotta: .*${message}`));
  });

  it("fails the step on errors when fail-on-error is true", async () => {
    const { deps, lines } = setup({ "fail-on-error": "true" }, {}, { ok: false, status: 401, attempts: 1, reason: "authentication failed" });
    await expect(run(deps)).resolves.toBe(1);
    expect(lines.join("")).toContain("::error::Syncotta: authentication failed after 1 attempt(s)");
  });

  it("only warns on a send error by default", async () => {
    const { deps, output } = setup({}, {}, { ok: false, status: null, attempts: 3, reason: "network error (TypeError)" });
    await expect(run(deps)).resolves.toBe(0);
    expect(output("status")).toBe("failed");
  });
});

describe("pull request", () => {
  const TOKEN = "ghs_tokenvalue";
  const PR_URL = "https://github.com/acme/payments/pull/12";
  const github = (status: number, pulls: unknown, reviews: unknown = []) =>
    ((input: string | URL | Request) =>
      Promise.resolve(
        new Response(JSON.stringify((input instanceof Request ? input.url : input.toString()).includes("/reviews") ? reviews : pulls), { status }),
      )) as typeof fetch;
  const merged = { number: 12, html_url: PR_URL, merged_at: "2026-10-19T10:00:00Z", merge_commit_sha: SHA };
  const approval = (id: number, state: string, at: string) => ({ user: { id, login: `reviewer${id}` }, state, submitted_at: at });

  it("adds pullRequest to the body and logs the approval count", async () => {
    const reviews = [approval(1, "APPROVED", "2026-10-19T09:00:00Z"), approval(2, "APPROVED", "2026-10-19T09:30:00Z")];
    const { deps, sent, lines, output } = setup({ "github-token": TOKEN }, { fetch: github(200, [merged], reviews) });
    await expect(run(deps)).resolves.toBe(0);
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(body.pullRequest).toEqual({ number: 12, url: PR_URL, mergedAt: "2026-10-19T10:00:00Z", approvals: 2, approvedAt: "2026-10-19T09:30:00Z" });
    expect(body.issueKeys).toEqual(["PAY-2", "PAY-1"]);
    expect(output("status")).toBe("sent");
    const log = lines.join("");
    expect(log).toContain("Pull request #12: 2 approval(s)");
    expect(log).toContain(`::add-mask::${TOKEN}`);
    expect(log.replace(`::add-mask::${TOKEN}`, "")).not.toContain(TOKEN);
    expect(log).not.toContain("reviewer");
    expect(sent[0]!.body).not.toContain("reviewer");
  });

  it.each([
    ["403", github(403, {})],
    ["404", github(404, {})],
    ["rate limit", github(429, {})],
    ["network", () => Promise.reject(new TypeError("fetch failed"))],
  ])("%s warns once and sends without pullRequest", async (_name, fetchFn) => {
    const { deps, sent, lines, output } = setup({ "github-token": TOKEN }, { fetch: fetchFn });
    await expect(run(deps)).resolves.toBe(0);
    expect(JSON.parse(sent[0]!.body)).not.toHaveProperty("pullRequest");
    expect(output("status")).toBe("sent");
    const warnings = lines.filter((l) => l.startsWith("::warning::"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("pull-requests: read");
    expect(lines.join("").replace(`::add-mask::${TOKEN}`, "")).not.toContain(TOKEN);
  });

  it("does not fail the step on a lookup error even with fail-on-error", async () => {
    const { deps, sent } = setup({ "github-token": TOKEN, "fail-on-error": "true" }, { fetch: github(403, {}) });
    await expect(run(deps)).resolves.toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("sends without pullRequest when the commit has no merged PR", async () => {
    const { deps, sent, lines } = setup({ "github-token": TOKEN }, { fetch: github(200, []) });
    await run(deps);
    expect(JSON.parse(sent[0]!.body)).not.toHaveProperty("pullRequest");
    expect(lines.some((l) => l.startsWith("::warning::"))).toBe(false);
  });

  it("uses the event's PR on pull_request events", async () => {
    const event = { pull_request: { number: 12, html_url: PR_URL, merged_at: null, title: "PAY-3 x", head: { ref: "f" } } };
    const { deps, sent } = setup(
      { "github-token": TOKEN },
      { readEvent: () => event, fetch: github(200, null, [approval(1, "APPROVED", "2026-10-19T09:00:00Z")]) },
    );
    deps.env.GITHUB_EVENT_NAME = "pull_request";
    await run(deps);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ issueKeys: ["PAY-3"], pullRequest: { number: 12, mergedAt: null, approvals: 1 } });
  });

  it("skips the lookup when no issue keys are found", async () => {
    const { deps, sent } = setup({ "github-token": TOKEN }, { readEvent: () => ({}), env: { GITHUB_REF: "refs/heads/main" } });
    await expect(run(deps)).resolves.toBe(0);
    expect(sent).toEqual([]);
  });

  it("skips the lookup with an empty github-token", async () => {
    const { deps, sent, lines } = setup({});
    await run(deps);
    expect(JSON.parse(sent[0]!.body)).not.toHaveProperty("pullRequest");
    expect(lines.join("")).toContain("No github-token");
  });
});

describe("workflow commands", () => {
  it("escapes command data and writes outputs without GITHUB_OUTPUT", () => {
    const lines: string[] = [];
    const wf = workflow({ env: {}, write: (l) => lines.push(l), appendFile: () => undefined });
    wf.warning("a%b\nc");
    wf.setOutput("x", "1");
    wf.mask("");
    expect(lines).toEqual(["::warning::a%25b%0Ac\n", "x=1\n"]);
  });
});
