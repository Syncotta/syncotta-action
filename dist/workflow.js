// GitHub Actions runner protocol without @actions/core: inputs from INPUT_* variables, outputs appended to the
// GITHUB_OUTPUT file, masks and annotations as workflow commands on stdout. Zero dependencies keeps the action small
// and auditable.
import { randomBytes } from "node:crypto";
// Workflow command data escaping (as in @actions/core).
const escapeData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
export function workflow(io) {
    const command = (name, message) => io.write(`::${name}::${escapeData(message)}\n`);
    return {
        // The runner keeps hyphens and upper-cases the name: input "events-url" arrives as INPUT_EVENTS-URL.
        input: (name) => (io.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim(),
        setOutput: (name, value) => {
            const file = io.env.GITHUB_OUTPUT;
            if (!file) {
                io.write(`${name}=${value}\n`);
                return;
            }
            const delimiter = `ghadelimiter_${randomBytes(16).toString("hex")}`;
            io.appendFile(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
        },
        mask: (value) => {
            if (value !== "")
                command("add-mask", value);
        },
        info: (message) => io.write(`${message}\n`),
        notice: (message) => command("notice", message),
        warning: (message) => command("warning", message),
        error: (message) => command("error", message),
    };
}
