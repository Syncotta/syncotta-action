// Signed POST to the Syncotta /ci route (SPEC 4.2, 6):
//   X-Syncotta-Signature = hex HMAC-SHA256(key, "<timestamp>.<nonce>.<raw body>")
// Each attempt gets a fresh timestamp and nonce (a reused nonce is refused as a replay).
import { createHmac, randomBytes } from "node:crypto";
export const defaultClientDeps = {
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    nonce: () => randomBytes(16).toString("hex"),
};
export const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;
export function signature(key, timestamp, nonce, body) {
    return createHmac("sha256", key).update(`${timestamp}.${nonce}.`, "utf8").update(body, "utf8").digest("hex");
}
const retryable = (status) => status === 429 || status >= 500;
const reasons = {
    400: "the request was rejected as invalid (check the image reference and issue keys)",
    401: "authentication failed (check instance-id and hmac-key, and that the runner clock is correct)",
};
export async function postCi(request, deps = defaultClientDeps) {
    let last = { ok: false, status: null, attempts: 0, reason: "not sent" };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > 1)
            await deps.sleep(2 ** (attempt - 1) * 1000);
        const timestamp = String(Math.floor(deps.now() / 1000));
        const nonce = deps.nonce();
        let status;
        try {
            const response = await deps.fetch(request.url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-syncotta-instance": request.instanceId,
                    "x-syncotta-timestamp": timestamp,
                    "x-syncotta-nonce": nonce,
                    "x-syncotta-signature": signature(request.hmacKey, timestamp, nonce, request.body),
                },
                body: request.body,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            status = response.status;
        }
        catch (err) {
            last = { ok: false, status: null, attempts: attempt, reason: `network error (${err instanceof Error ? err.name : "unknown"})` };
            continue;
        }
        if (status >= 200 && status < 300)
            return { ok: true, status, attempts: attempt };
        last = { ok: false, status, attempts: attempt, reason: reasons[status] ?? `HTTP ${status}` };
        if (!retryable(status))
            return last;
    }
    return last;
}
