/**
 * End-to-end test of the prune engine against a real SessionManager on a
 * disposable copy of the live session file:
 *   plan -> apply -> verify projection (stubs, strips, pairing, token drop)
 *   -> idempotency -> unprune -> verify byte-identical restoration.
 */
import fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	buildAnalysis, buildPrunePlan, applyPrunePlan, findLatestPruneRecord, applyUnprune,
} from "../extensions/pi-prune.ts";

const SRC = process.env.PI_SESSION_FILE;
if (!SRC) throw new Error("PI_SESSION_FILE not set");
const TMP = "/tmp/pi-prune-e2e-session.jsonl";
fs.copyFileSync(SRC, TMP);

const sm = SessionManager.open(TMP);
const rawContent = (id) => sm.getEntry(id)?.message?.content;

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}${extra ? " — " + extra : ""}`); }
	else { fail++; console.log(`FAIL ${name}${extra ? " — " + extra : ""}`); }
};

// --- plan ---
const proj0 = sm.buildSessionProjection();
// pi's projection can orphan the last raw pre-compaction result. Record those
// before pruning so the dangling check only judges results the prune touched.
const preExistingOrphanCallIds = (() => {
	const calls = new Set();
	const orphans = new Set();
	for (const p of proj0.entries) for (const m of p.messages) {
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content) if (b?.type === "toolCall") calls.add(b.id);
		} else if (m.role === "toolResult" && !calls.has(m.toolCallId)) {
			orphans.add(m.toolCallId);
		}
	}
	return orphans;
})();
const analysis = buildAnalysis(proj0);
const plan = buildPrunePlan(analysis, rawContent, (id) => proj0.entries.find((p) => p.sourceEntry.id === id)?.messages?.[0]?.content);
const kindCounts = plan.edits.reduce((m, e) => { m[e.kind] = (m[e.kind] ?? 0) + 1; return m; }, {});
console.log(`plan: ${plan.edits.length} edits`, kindCounts, `net ~${Math.round(plan.netTokens)} tok`);
if (plan.edits.length === 0) {
	// A live session can be legitimately lean (recently pruned/compacted). That is
	// a passing state, not a failure — the deterministic fixture e2e covers the
	// full pipeline. Report and exit clean.
	console.log(`\nlive session has nothing eligible under current policy — skipping live-pipeline checks`);
	console.log(`${pass} passed, ${fail} failed`);
	process.exit(0);
}
check("toolCalls preserved in thinking-strips", plan.edits.filter((e) => e.kind === "thinking-strip").every((e) => {
	const orig = e.original, rep = e.replacement.content;
	const oc = orig.filter((b) => b.type === "toolCall").length;
	const rc = rep.filter((b) => b.type === "toolCall").length;
	const ot = orig.filter((b) => b.type === "thinking").length;
	const rt = rep.filter((b) => b.type === "thinking").length;
	return oc === rc && ot > 0 && rt === 0;
}));

// --- apply ---
let argsOk = true;
const result = applyPrunePlan(sm, plan);
console.log(`applied ${result.applied}, failed ${result.failed}`, result.errors.slice(0, 3));
check("all edits applied", result.failed === 0 && result.applied === plan.edits.length);

// --- verify projection after ---
const proj1 = sm.buildSessionProjection();
const byId = new Map(proj1.entries.map((pe) => [pe.sourceEntry.id, pe]));
let stubsOk = true, stripsOk = true;
for (const e of plan.edits) {
	const pe = byId.get(e.targetId);
	const msg = pe?.messages?.[0];
	if (!msg) { if (e.kind === "tool-stub") stubsOk = false; continue; } // whole-entry drops legitimately have no projected message
	if (e.kind === "tool-stub") {
		const text = typeof msg.content === "string" ? msg.content : (msg.content?.[0]?.text ?? "");
		if (!String(text).includes("elided by /prune")) stubsOk = false;
	} else if (e.kind === "thinking-strip" || e.kind === "thinking+args" || e.kind === "thinking+drop") {
		if ((msg.content ?? []).some((b) => b.type === "thinking")) stripsOk = false;
	} else if (e.kind === "args-clear") {
		// args cleared to the marker; thinking may legitimately remain (within the protect window)
		const cleared = (msg.content ?? []).some((b) => b.type === "toolCall" && b.arguments?.pi_prune_elided);
		if (!cleared) argsOk = false;
	}
}
check("stubs present in projection", stubsOk);
check("thinking stripped in projection", stripsOk);
check("args cleared in projection", argsOk);
// estimator-consistent drop: same math as /ctx, immune to signature double-counting
const beforeEst = buildAnalysis(proj0).estTotal;
const afterEst = buildAnalysis(proj1).estTotal;
const drop = beforeEst - afterEst;
console.log(`token drop (estimator): ~${Math.round(drop)} (plan gross ~${Math.round(plan.grossTokens)})`);
check("token drop matches plan gross", Math.abs(drop - plan.grossTokens) < 0.1 * plan.grossTokens + 500, `drop=${Math.round(drop)} gross=${Math.round(plan.grossTokens)}`);

// --- idempotency ---
const analysis2 = buildAnalysis(sm.buildSessionProjection());
const plan2 = buildPrunePlan(analysis2, rawContent, (id) => undefined);
check("second prune is a no-op", plan2.edits.length === 0, `${plan2.edits.length} edits`);

// Dangling-call invariant: every projected toolResult's call must exist in some earlier projected assistant.
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

// --- unprune ---
const record = findLatestPruneRecord(sm.getBranch());
check("record found", record !== null);
const un = applyUnprune(sm, record);
console.log(`unpruned ${un.restored}, failed ${un.failed}`, un.errors.slice(0, 3));
check("all restored", un.failed === 0 && un.restored === plan.edits.length);

const proj2 = sm.buildSessionProjection();
let restoreOk = true, firstBad = "";
for (const e of plan.edits) {
	const pe = proj2.entries.find((p) => p.sourceEntry.id === e.targetId);
	const now = pe?.messages?.[0]?.content;
	const orig = e.original;
	if (JSON.stringify(now) !== JSON.stringify(orig)) {
		restoreOk = false;
		firstBad ||= e.targetId;
	}
}
check("restored content byte-identical to originals", restoreOk, firstBad);
const nextRecord = findLatestPruneRecord(sm.getBranch());
// the copy carries the user's earlier live prune record; stepping past ours
// must land on it (or nothing if it were absent), never back on ours
check("unprune steps past our record", nextRecord === null || nextRecord.id !== record.id);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
