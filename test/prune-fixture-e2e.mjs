/**
 * Deterministic end-to-end test of the prune engine against a synthetic
 * session (no live-session dependency):
 *
 *   fixture -> analysis asserts (every collector fires exactly once per rule)
 *           -> plan asserts (kind per rule, exact edit targets)
 *           -> apply -> projection asserts (stubs, strips, cleared args,
 *              episode omission, no dangling results)
 *           -> post-prune compaction checkpoint must not resurrect pruned
 *              content (regression: firstKeptEntryId inside the kept tail)
 *           -> idempotent second prune (no-op)
 *           -> unprune -> byte-identical restoration
 *
 * Run: node test/prune-fixture-e2e.mjs
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { postPruneCompaction } from "./make-fixture.mjs";
import {
	buildAnalysis, buildPrunePlan, planCategoryRows, applyPrunePlan, findLatestPruneRecord, applyUnprune, formatReport,
} from "../extensions/pi-prune.ts";

const TMP = "/tmp/pi-prune-fixture-e2e.jsonl";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}${extra ? " — " + extra : ""}`); }
	else { fail++; console.log(`FAIL ${name}${extra ? " — " + extra : ""}`); }
};

// --- build fixture fresh ---
execFileSync(process.execPath, ["test/make-fixture.mjs", "/tmp"], { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe" });
fs.copyFileSync("/tmp/pi-prune-fixture.jsonl", TMP);

const sm = SessionManager.open(TMP);
const rawContent = (id) => sm.getEntry(id)?.message?.content;

// --- analysis ---
const proj0 = sm.buildSessionProjection();
const analysis = buildAnalysis(proj0);
const r = analysis.reclaimable;

// every collector fires exactly once per rule in the fixture
check("superseded: exactly 1 (older read of same path)", r.superseded.length === 1, `${r.superseded.length}`);
check("stale: exactly 3 (2 old bash + 1 old read)", r.stale.length === 3, `${r.stale.length}: ${r.stale.map((i) => i.toolName).join(",")}`);
check("thinking: exactly 1 (old post-checkpoint block)", r.thinking.length === 1, `${r.thinking.length}`);
check("args: exactly 1 entry (stub-paired big bash args)", r.args.length === 1, JSON.stringify(r.args.map((a) => a.tokens)));
check("episodes: exactly 2 (write+edit one-liners)", r.episodes.length === 2, `${r.episodes.length}`);

// ages: fresh episode untouched, debris past the window
check("fresh read result inside window is never collected", !r.superseded.concat(r.stale).some((i) => i.toolCallId === "c_fresh_read"));

// --- plan ---
const plan = buildPrunePlan(analysis, rawContent, (id) => proj0.entries.find((p) => p.sourceEntry.id === id)?.messages?.[0]?.content);
const kinds = plan.edits.reduce((m, e) => { m[e.kind] = (m[e.kind] ?? 0) + 1; return m; }, {});
check("plan has tool-stub edits", (kinds["tool-stub"] ?? 0) === 4, JSON.stringify(kinds));
check("plan has thinking-strip edit", (kinds["thinking-strip"] ?? 0) === 1);
check("plan has args-clear edit", (kinds["args-clear"] ?? 0) === 1);
check("plan has assistant-call-drop edits", (kinds["assistant-call-drop"] ?? 0) === 2);
check("plan has result-drop edits", (kinds["result-drop"] ?? 0) === 2);
check("plan has no unexpected kinds", Object.keys(kinds).every((k) => ["tool-stub", "thinking-strip", "args-clear", "assistant-call-drop", "result-drop"].includes(k)));
const rowTokens = planCategoryRows(plan).reduce((s, row) => s + row.tokens, 0);
check("preview category rows sum to gross", Math.abs(rowTokens - plan.grossTokens) <= 1, `rows=${rowTokens} gross=${plan.grossTokens}`);
// Both reads of /tmp/r.ts are stubbed. The superseded rule owns the older one;
// the newest one ages into the stale window and is stubbed there.
const reread1Entry = proj0.entries.find((pe) => pe.messages[0]?.role === "toolResult" && pe.messages[0]?.toolCallId === "c_reread1")?.sourceEntry.id;
const reread2Entry = proj0.entries.find((pe) => pe.messages[0]?.role === "toolResult" && pe.messages[0]?.toolCallId === "c_reread2")?.sourceEntry.id;
check("superseded read is stubbed", plan.edits.some((e) => e.kind === "tool-stub" && e.targetId === reread1Entry));
check("newest same-path read also stubbed once stale", plan.edits.some((e) => e.kind === "tool-stub" && e.targetId === reread2Entry));

// pi's buildContextEntries keeps the last raw pre-compaction entry (its own
// projection quirk): the c_bash2 result appears without its call. This orphan
// predates the prune, so record it and exclude it from the dangling check.
const preExistingOrphanCallIds = (() => {
	const calls = new Set(); const orphans = new Set();
	for (const p of proj0.entries) for (const m of p.messages) {
		if (m.role === "assistant") { for (const b of (Array.isArray(m.content) ? m.content : [])) if (b?.type === "toolCall") calls.add(b.id); }
		else if (m.role === "toolResult" && !calls.has(m.toolCallId)) orphans.add(m.toolCallId);
	}
	return orphans;
})();
check("documented pre-prune orphan (pi compaction quirk)", preExistingOrphanCallIds.has("c_bash2"), [...preExistingOrphanCallIds].join(","));

// fresh episode untouched
const freshIds = ["c_fresh_read"];
const freshResultEntry = proj0.entries.find((pe) => pe.messages[0]?.role === "toolResult" && pe.messages[0]?.toolCallId === "c_fresh_read")?.sourceEntry.id;
check("fresh episode never edited", !plan.edits.some((e) => e.targetId === freshResultEntry));

// --- apply ---
const countTokens = (proj) => proj.messages.reduce((s, m) => s + JSON.stringify(m).length, 0) / 4;
const beforeEst = buildAnalysis(proj0).estTotal;
const result = applyPrunePlan(sm, plan);
check("all edits applied", result.failed === 0 && result.applied === plan.edits.length, `${result.applied}/${plan.edits.length}`);

// --- verify projection ---
const proj1 = sm.buildSessionProjection();
const byId = new Map(proj1.entries.map((pe) => [pe.sourceEntry.id, pe]));
let stubsOk = true, stripsOk = true, argsOk = true, dropsOk = true;
for (const e of plan.edits) {
	const pe = byId.get(e.targetId);
	const msg = pe?.messages?.[0];
	if (e.kind === "tool-stub") {
		const text = typeof msg?.content === "string" ? msg.content : (msg?.content?.[0]?.text ?? "");
		if (!String(text).includes("elided by /prune")) stubsOk = false;
	} else if (e.kind === "thinking-strip") {
		if ((msg?.content ?? []).some((b) => b.type === "thinking")) stripsOk = false;
	} else if (e.kind === "args-clear") {
		if (!(msg?.content ?? []).some((b) => b.type === "toolCall" && b.arguments?.pi_prune_elided)) argsOk = false;
	} else if (e.kind === "result-drop") {
		if (pe === undefined || pe.messages.length !== 0) dropsOk = false;
	} else if (e.kind === "assistant-call-drop") {
		// entry omitted whole OR call block removed; fixture episodes drop whole entry
		if (pe && pe.messages.length > 0 && (pe.messages[0].content ?? []).some((b) => b.type === "toolCall")) dropsOk = false;
	}
}
check("stubs present in projection", stubsOk);
check("thinking stripped in projection", stripsOk);
check("args cleared in projection", argsOk);
check("episode drops omitted in projection", dropsOk);

// no dangling results
{
	const calls = new Set();
	let orphans = 0;
	for (const p of proj1.entries) {
		for (const m of p.messages) {
			if (m.role === "assistant") { for (const b of (Array.isArray(m.content) ? m.content : [])) if (b?.type === "toolCall") calls.add(b.id); }
			else if (m.role === "toolResult" && !preExistingOrphanCallIds.has(m.toolCallId)) { if (!calls.has(m.toolCallId)) orphans++; }
		}
	}
	check("no dangling results after prune", orphans === 0, `${orphans} orphans`);
}

// estimator-consistent drop
const afterEst = buildAnalysis(proj1).estTotal;
const drop = beforeEst - afterEst;
check("token drop matches plan gross", Math.abs(drop - plan.grossTokens) < 0.1 * plan.grossTokens + 200, `drop=${Math.round(drop)} gross=${Math.round(plan.grossTokens)}`);

// --- post-prune compaction must not resurrect pruned content ---
fs.appendFileSync(TMP, postPruneCompaction() + "\n");
const proj2 = sm.buildSessionProjection();
const summaryText = proj2.messages.find((m) => m.role === "compactionSummary")?.summary ?? "";
check("two compaction summaries projected (newest wins)", proj2.messages.filter((m) => m.role === "compactionSummary").length === 1);
check("post-prune checkpoint kept the fresh tail", proj2.entries.some((pe) => pe.messages[0]?.toolCallId === "c_fresh_read"));
// no pruned content reappears: no stub text, no cleared args, no episode payloads
let resurrected = "";
for (const pe of proj2.entries) {
	for (const m of pe.messages) {
		const s = JSON.stringify(m.content ?? "");
		if (m.role !== "compactionSummary") {
			if (s.includes("elided by /prune") && m.role === "toolResult" && !(typeof m.content === "string" ? m.content : m.content?.[0]?.text ?? "").includes("elided by /prune")) resurrected ||= "stub replaced by original";
			if ((m.content ?? []).some?.((b) => b.type === "toolCall" && !b.arguments?.pi_prune_elided && b.id === "c_stub_bash")) resurrected ||= "cleared args restored";
			if (s.length > 800 && (s.includes("/tmp/ep1.ts") || s.includes("/tmp/w.ts"))) resurrected ||= "dropped episode payload back";
		}
	}
}
check("post-prune checkpoint does not resurrect pruned content", resurrected === "", resurrected || "clean");
const afterCkpt = buildAnalysis(proj2);
check("no new reclaimable mass after checkpoint", afterCkpt.reclaimable.total === 0, `total=${afterCkpt.reclaimable.total}`);

// --- idempotency ---
const analysis2 = buildAnalysis(sm.buildSessionProjection());
const plan2 = buildPrunePlan(analysis2, rawContent, (id) => undefined);
check("second prune is a no-op", plan2.edits.length === 0, `${plan2.edits.length} edits`);

// --- unprune ---
// NOTE: unprune restores the state before our prune; the appended checkpoint is
// a later session entry and is untouched by context edits, so we verify against
// the projection recorded at prune time instead of rebuilding with the checkpoint.
const record = findLatestPruneRecord(sm.getBranch());
check("record found", record !== null);
const un = applyUnprune(sm, record);
check("all restored", un.failed === 0 && un.restored === plan.edits.length, `${un.restored}/${plan.edits.length}`);

const proj3 = sm.buildSessionProjection();
let restoreOk = true, firstBad = "";
for (const e of plan.edits) {
	const pe = proj3.entries.find((p) => p.sourceEntry.id === e.targetId);
	const now = pe?.messages?.[0]?.content;
	const orig = e.original;
	if (JSON.stringify(now) !== JSON.stringify(orig)) { restoreOk = false; firstBad ||= e.targetId; }
}
check("restored content byte-identical to originals", restoreOk, firstBad);
const nextRecord = findLatestPruneRecord(sm.getBranch());
check("unprune steps past our record", nextRecord === null || nextRecord.id !== record.id);

// --- report shape: short vs full ---
const projD = sm.buildSessionProjection();
const aD = buildAnalysis(projD);
const planD = buildPrunePlan(aD, rawContent, (id) => projD.entries.find((p) => p.sourceEntry.id === id)?.messages?.[0]?.content);
const shortReport = formatReport(aD, { full: false, plan: planD });
check("short report has category and preview sections", shortReport.some((l) => l.startsWith("where it goes")) && shortReport.some((l) => l.startsWith("reclaimable preview")));
check("short report omits full-only sections", !shortReport.some((l) => /cache economics|recency bands|compaction state/.test(l)));
const fullReport = formatReport(aD, { full: true, plan: planD, window: 200000 });
check("full report adds cache, recency, and compaction sections", ["cache economics", "recency bands", "compaction state"].every((section) => fullReport.some((l) => l.includes(section))));
check("args preview row present when args category non-zero", (aD.reclaimable.args.length > 0) === shortReport.some((l) => l.includes("tool call args")));
const emptyAnalysis = buildAnalysis({ entries: [] });
const emptyPlan = buildPrunePlan(emptyAnalysis, () => undefined, () => undefined);
check("empty plan reports nothing eligible", formatReport(emptyAnalysis, { plan: emptyPlan }).some((l) => l.includes("nothing eligible")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
