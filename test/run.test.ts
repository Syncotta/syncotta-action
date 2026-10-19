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
