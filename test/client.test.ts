import { describe, expect, it } from "vitest";
import type { ClientDeps } from "../src/client.js";
import { postCi, signature } from "../src/client.js";

const request = { url: "https://example.invalid/x/ci", instanceId: "argo-prod", hmacKey: "ab".repeat(32), body: '{"a":1}' };

function deps(statuses: (number | Error)[]) {
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const sleeps: number[] = [];
  let n = 0;
  const d: ClientDeps = {
    fetch: (url, init) => {
      sent.push({ url: url as string, headers: init?.headers as Record<string, string>, body: init?.body as string });
      const next = statuses.shift() ?? 202;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(new Response(null, { status: next }));
    },
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
    now: () => 1_792_400_000_000,
    nonce: () => `${"0".repeat(31)}${n++}`,
  };
  return { d, sent, sleeps };
}

describe("postCi", () => {
  it("signs timestamp, nonce and body and succeeds on 202", async () => {
    const { d, sent } = deps([202]);
    await expect(postCi(request, d)).resolves.toEqual({ ok: true, status: 202, attempts: 1 });
    expect(sent).toHaveLength(1);
    const h = sent[0]!.headers;
    expect(h["x-syncotta-instance"]).toBe("argo-prod");
    expect(h["x-syncotta-timestamp"]).toBe("1792400000");
    expect(h["x-syncotta-signature"]).toBe(signature(request.hmacKey, "1792400000", h["x-syncotta-nonce"]!, request.body));
    expect(sent[0]!.body).toBe(request.body);
  });

  it("retries 5xx, 429 and network errors with a fresh nonce and backoff", async () => {
    const { d, sent, sleeps } = deps([503, new TypeError("fetch failed"), 202]);
    await expect(postCi(request, d)).resolves.toEqual({ ok: true, status: 202, attempts: 3 });
    expect(new Set(sent.map((s) => s.headers["x-syncotta-nonce"])).size).toBe(3);
    expect(sleeps).toEqual([2000, 4000]);
  });

  it("gives up after three attempts", async () => {
    const { d } = deps([429, 500, 502]);
    await expect(postCi(request, d)).resolves.toEqual({ ok: false, status: 502, attempts: 3, reason: "HTTP 502" });
    const net = deps([new TypeError("x"), new TypeError("x"), new TypeError("x")]);
    await expect(postCi(request, net.d)).resolves.toMatchObject({ ok: false, status: null, reason: "network error (TypeError)" });
  });

  it.each([
    [401, "authentication failed"],
    [400, "rejected as invalid"],
    [404, "HTTP 404"],
  ])("does not retry %i", async (status, reason) => {
    const { d, sent } = deps([status]);
    const result = await postCi(request, d);
    expect(result).toMatchObject({ ok: false, status, attempts: 1 });
    expect(result.ok ? "" : result.reason).toContain(reason);
    expect(sent).toHaveLength(1);
  });
});
