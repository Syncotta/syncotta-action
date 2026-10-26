import { describe, expect, it } from "vitest";
import type { PullRequestContext } from "../src/pullRequest.js";
import { findPullRequest } from "../src/pullRequest.js";

const SHA = "a".repeat(40);
const TOKEN = "ghs_secret";
const URL_12 = "https://github.com/acme/pay/pull/12";

type Route = (url: URL) => { status: number; body?: unknown } | "throw";

/** Fake fetch: answers by path, records requests. */
function fakeFetch(route: Route) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url: url.toString(), headers: (init?.headers ?? {}) as Record<string, string> });
    const r = route(url);
    if (r === "throw") return Promise.reject(new TypeError("fetch failed"));
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null);
    return Promise.resolve(new Response(text, { status: r.status }));
  }) as typeof fetch;
  return { fn, calls };
}

const review = (id: number, state: string, at: string) => ({ user: { id, login: `user${id}` }, state, submitted_at: at });
const pr = (over: Record<string, unknown> = {}) => ({
  number: 12,
  html_url: URL_12,
  merged_at: "2026-10-19T10:00:00Z",
  merge_commit_sha: SHA,
  title: "PAY-1 secret title",
  user: { login: "author" },
  ...over,
});

function ctx(fetchFn: typeof fetch, over: Partial<PullRequestContext> = {}): PullRequestContext {
  return { eventName: "push", event: {}, sha: SHA, repository: "acme/pay", apiUrl: "", token: TOKEN, fetch: fetchFn, ...over };
}

function api(pulls: unknown, reviews: unknown = [[]]): Route {
  return (url) => {
    if (url.pathname === `/repos/acme/pay/commits/${SHA}/pulls`) return { status: 200, body: pulls };
    const m = /^\/repos\/acme\/pay\/pulls\/(\d+)\/reviews$/.exec(url.pathname);
    if (m) {
      if (!Array.isArray(reviews) || !reviews.every(Array.isArray)) return { status: 200, body: reviews };
      const page = Number(url.searchParams.get("page") ?? "1");
      return { status: 200, body: (reviews as unknown[][])[page - 1] ?? [] };
    }
    return { status: 404, body: { message: "Not Found" } };
  };
}

describe("findPullRequest on push", () => {
  it("picks the PR merged as this commit and sends the token in a header only", async () => {
    const other = pr({ number: 9, html_url: "https://github.com/acme/pay/pull/9", merge_commit_sha: "b".repeat(40) });
    const { fn, calls } = fakeFetch(api([pr({ number: 3, merged_at: null }), other, pr()], [[review(1, "APPROVED", "2026-10-19T09:00:00Z")]]));
    const result = await findPullRequest(ctx(fn));
    expect(result).toEqual({
      ok: true,
      pullRequest: { number: 12, url: URL_12, mergedAt: "2026-10-19T10:00:00Z", approvals: 1, approvedAt: "2026-10-19T09:00:00Z" },
    });
    expect(calls.map((c) => c.url)).toEqual([
      `https://api.github.com/repos/acme/pay/commits/${SHA}/pulls`,
      "https://api.github.com/repos/acme/pay/pulls/12/reviews?per_page=100&page=1",
    ]);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls.every((c) => !c.url.includes(TOKEN))).toBe(true);
  });

  it("falls back to the first merged PR and honours GITHUB_API_URL", async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.pathname === `/api/v3/repos/acme/pay/commits/${SHA}/pulls`) {
        return { status: 200, body: [pr({ number: 3, merged_at: null }), pr({ number: 7, merge_commit_sha: "f".repeat(40) })] };
      }
      return { status: 200, body: [] };
    });
    const result = await findPullRequest(ctx(fn, { apiUrl: "https://ghe.example/api/v3/" }));
    expect(result).toMatchObject({ ok: true, pullRequest: { number: 7, approvals: 0, approvedAt: null } });
    expect(calls[1]!.url).toBe("https://ghe.example/api/v3/repos/acme/pay/pulls/7/reviews?per_page=100&page=1");
  });

  it("returns no PR when none is merged, without calling reviews", async () => {
    const { fn, calls } = fakeFetch(api([pr({ merged_at: null })]));
    await expect(findPullRequest(ctx(fn))).resolves.toEqual({ ok: true, pullRequest: null });
    expect(calls).toHaveLength(1);
  });

  it("returns no PR without a usable commit", async () => {
    const { fn, calls } = fakeFetch(api([]));
    await expect(findPullRequest(ctx(fn, { sha: "" }))).resolves.toEqual({ ok: true, pullRequest: null });
    expect(calls).toEqual([]);
  });
});

describe("findPullRequest on pull_request events", () => {
  it.each(["pull_request", "pull_request_target"])("%s uses the event's PR", async (eventName) => {
    const { fn, calls } = fakeFetch(api([], [[review(1, "APPROVED", "2026-10-19T09:00:00Z")]]));
    const event = { pull_request: pr({ number: 12, merged_at: null }) };
    const result = await findPullRequest(ctx(fn, { eventName, event, sha: "c".repeat(40) }));
    expect(result).toEqual({
      ok: true,
      pullRequest: { number: 12, url: URL_12, mergedAt: null, approvals: 1, approvedAt: "2026-10-19T09:00:00Z" },
    });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/repos/acme/pay/pulls/12/reviews"]);
  });

  it("fails when the event has no pull request", async () => {
    const { fn } = fakeFetch(api([]));
    await expect(findPullRequest(ctx(fn, { eventName: "pull_request", event: {} }))).resolves.toMatchObject({ ok: false });
  });
});

describe("approvals", () => {
  const count = async (reviews: unknown[][]) => {
    const { fn } = fakeFetch(api([pr()], reviews));
    const result = await findPullRequest(ctx(fn));
    if (!result.ok || result.pullRequest === null) throw new Error("no PR");
    return { approvals: result.pullRequest.approvals, approvedAt: result.pullRequest.approvedAt };
  };

  it("counts each reviewer's latest deciding state", async () => {
    await expect(
      count([
        [
          review(1, "APPROVED", "2026-10-19T08:00:00Z"),
          review(1, "CHANGES_REQUESTED", "2026-10-19T09:00:00Z"), // approved, then requested changes: not counted
          review(2, "CHANGES_REQUESTED", "2026-10-19T08:00:00Z"),
          review(2, "APPROVED", "2026-10-19T08:30:00Z"),
          review(2, "COMMENTED", "2026-10-19T11:00:00Z"), // a later comment keeps the approval
          review(3, "APPROVED", "2026-10-19T07:00:00Z"),
          review(3, "APPROVED", "2026-10-19T07:30:00Z"), // same reviewer twice counts once
          review(4, "COMMENTED", "2026-10-19T12:00:00Z"),
          review(5, "PENDING", "2026-10-19T12:00:00Z"),
        ],
      ]),
    ).resolves.toEqual({ approvals: 2, approvedAt: "2026-10-19T08:30:00Z" });
  });

  it("does not count dismissed approvals", async () => {
    await expect(
      count([[review(1, "DISMISSED", "2026-10-19T08:00:00Z"), review(2, "APPROVED", "2026-10-19T07:00:00Z")]]),
    ).resolves.toEqual({ approvals: 1, approvedAt: "2026-10-19T07:00:00Z" });
  });

  it("orders by submitted_at, not by list position", async () => {
    await expect(
      count([[review(1, "APPROVED", "2026-10-19T10:00:00Z"), review(1, "CHANGES_REQUESTED", "2026-10-19T09:00:00Z")]]),
    ).resolves.toEqual({ approvals: 1, approvedAt: "2026-10-19T10:00:00Z" });
  });

  it("ignores malformed reviews", async () => {
    await expect(
      count([[{ state: "APPROVED" }, { user: {}, state: "APPROVED", submitted_at: "2026-10-19T08:00:00Z" }, review(1, "APPROVED", "no time"), null]]),
    ).resolves.toEqual({ approvals: 0, approvedAt: null });
  });

  it("follows up to 3 pages of 100", async () => {
    const full = (start: number) => Array.from({ length: 100 }, (_, i) => review(start + i, "APPROVED", "2026-10-19T08:00:00Z"));
    const pages = [full(1), full(101), full(201), [review(999, "APPROVED", "2026-10-19T09:00:00Z")]];
    const { fn, calls } = fakeFetch(api([pr()], pages));
    const result = await findPullRequest(ctx(fn));
    // 300 approvers seen on 3 pages, page 4 never fetched, count capped at 100.
    expect(result).toMatchObject({ ok: true, pullRequest: { approvals: 100, approvedAt: "2026-10-19T08:00:00Z" } });
    expect(calls).toHaveLength(4);
  });

  it("stops after a short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => review(i + 1, i < 2 ? "APPROVED" : "COMMENTED", "2026-10-19T08:00:00Z"));
    const { fn, calls } = fakeFetch(api([pr()], [page1, [review(500, "APPROVED", "2026-10-19T09:00:00Z")]]));
    await expect(findPullRequest(ctx(fn))).resolves.toMatchObject({ ok: true, pullRequest: { approvals: 3, approvedAt: "2026-10-19T09:00:00Z" } });
    expect(calls).toHaveLength(3);
  });

  it("never returns logins", async () => {
    const { fn } = fakeFetch(api([pr()], [[review(1, "APPROVED", "2026-10-19T08:00:00Z")]]));
    const text = JSON.stringify(await findPullRequest(ctx(fn)));
    expect(text).not.toContain("user1");
    expect(text).not.toContain("author");
    expect(text).not.toContain("title");
  });
});

describe("failures", () => {
  const reviewsFail = (status: number): Route => (url) => (url.pathname.endsWith("/reviews") ? { status } : { status: 200, body: [pr()] });

  it.each<[string, Route, RegExp]>([
    ["403 on the commit lookup", () => ({ status: 403 }), /HTTP 403/],
    ["401", () => ({ status: 401 }), /HTTP 401/],
    ["404", () => ({ status: 404 }), /HTTP 404/],
    ["429 rate limit", () => ({ status: 429 }), /HTTP 429/],
    ["500", () => ({ status: 500 }), /HTTP 500/],
    ["network error", () => "throw", /network error \(TypeError\)/],
    ["not JSON", () => ({ status: 200, body: "<html>" }), /not JSON/],
    ["not a list", () => ({ status: 200, body: { message: "x" } }), /unexpected response/],
    ["403 on reviews", reviewsFail(403), /HTTP 403/],
    ["reviews not a list", (url) => (url.pathname.endsWith("/reviews") ? { status: 200, body: {} } : { status: 200, body: [pr()] }), /unexpected/],
    ["invalid PR number", () => ({ status: 200, body: [pr({ number: 0 })] }), /number or link/],
    ["http link", () => ({ status: 200, body: [pr({ html_url: "http://github.com/acme/pay/pull/12" })] }), /number or link/],
    ["overlong link", () => ({ status: 200, body: [pr({ html_url: `https://github.com/${"x".repeat(500)}` })] }), /number or link/],
  ])("%s", async (_name, route, reason) => {
    const { fn } = fakeFetch(route);
    const result = await findPullRequest(ctx(fn));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(reason);
      expect(result.reason).not.toContain(TOKEN);
    }
  });

  it("rejects a malformed repository without calling the API", async () => {
    const { fn, calls } = fakeFetch(api([]));
    await expect(findPullRequest(ctx(fn, { repository: "../x" }))).resolves.toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it("turns an unexpected exception into a failure", async () => {
    const fn = (() => {
      throw new RangeError("boom");
    }) as unknown as typeof fetch;
    await expect(findPullRequest(ctx(fn))).resolves.toMatchObject({ ok: false, reason: /network error/ });
  });
});
