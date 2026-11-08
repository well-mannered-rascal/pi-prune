/**
 * Smoke test: run buildAnalysis + buildPrunePlan + formatReport against a real
 * session file. Node 24 strips types natively; the extension file has zero
 * runtime imports.
 *
 *   PI_SESSION_FILE=~/.pi/agent/sessions/.../<session>.jsonl node test/smoke.mjs
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildAnalysis, buildPrunePlan, formatReport } from "../extensions/pi-prune.ts";

const sessionFile = process.env.PI_SESSION_FILE;
if (!sessionFile) throw new Error("PI_SESSION_FILE not set");

const sm = SessionManager.open(sessionFile);
const projection = sm.buildSessionProjection();
console.error(`entries: ${projection.entries.length}, messages: ${projection.messages.length}`);

const analysis = buildAnalysis(projection);
const plan = buildPrunePlan(analysis, (id) => sm.getEntry(id)?.message?.content, (id) => {
	const pe = projection.entries.find((p) => p.sourceEntry.id === id);
	return pe?.messages?.[0]?.content;
});
// Window: only shown when provided. The live /ctx reads ctx.model.contextWindow.
const modelWindow = process.env.PI_CTX_WINDOW ? Number(process.env.PI_CTX_WINDOW) : undefined;
const opts = { full: false, plan, ...(modelWindow ? { window: modelWindow } : {}) };

console.log("=== SHORT ===");
console.log(formatReport(analysis, opts).join("\n"));
console.log();
console.log("=== FULL ===");
console.log(formatReport(analysis, { ...opts, full: true }).join("\n"));
