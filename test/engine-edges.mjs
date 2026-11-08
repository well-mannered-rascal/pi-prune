/**
 * In-memory edge cases for the prune engine. Synthetic projections keep these
 * fast and deterministic: token boundaries, anchoring, already-pruned content,
 * young referents, missing originals, and partial apply/unprune failures.
 *
 * Run: node test/engine-edges.mjs
 */
import {
	buildAnalysis, buildPrunePlan, planToDrafts, buildPruneRecord,
	applyPrunePlan, applyUnprune, collectPruneStats, collectPruneOriginals, withPendingBatch, formatReport,
} from "../extensions/pi-prune.ts";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}${extra ? " — " + extra : ""}`); }
	else { fail++; console.log(`FAIL ${name}${extra ? " — " + extra : ""}`); }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const user = (text = "u") => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (content, extra = {}) => ({ role: "assistant", content, ...extra });
const result = (id, name, text) => ({
	role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }],
});
const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const thinking = (chars) => ({ type: "thinking", thinking: "t".repeat(chars) });
const projection = (messages) => ({
	entries: messages.map((message, i) => ({ sourceEntry: { id: `e${i}`, type: "message" }, messages: [message] })),
});
const info = (over) => ({
	entryId: "a1", role: "assistant", message: {}, turn: 1, age: 3, tokens: 100,
	split: { text: 0, thinking: 0, toolArgs: 0, images: 0 }, digest: "", ...over,
});
const analysisOf = (reclaimable) => ({
	protectTurns: 2,
	staleMinAge: 3,
	reclaimable: { superseded: [], stale: [], thinking: [], args: [], episodes: [], total: 0, ...reclaimable },
});
const contentOf = (proj, id) => proj.entries.find((e) => e.sourceEntry.id === id)?.messages[0]?.content;

// --- anchoring and token accounting ---
const aborted = buildAnalysis(projection([
	user(),
	assistant([{ type: "text", text: "done" }], { usage: { input: 1000, output: 10, totalTokens: 1010 }, stopReason: "aborted" }),
]));
check("aborted usage is not an anchor", aborted.anchor === null);
check("aborted usage falls back to the estimate", aborted.total === aborted.estTotal);

const anchored = buildAnalysis(projection([
	user("hi"),
	assistant([{ type: "text", text: "done" }], { usage: { input: 1000, output: 10, totalTokens: 1010 }, stopReason: "stop" }),
	user("next"),
	assistant([{ type: "text", text: "x".repeat(400) }]),
]));
check("anchor uses billed totalTokens", anchored.anchor?.tokens === 1010 && anchored.estTotal === 103, `est=${anchored.estTotal}`);
check("total anchors on the last billed usage", anchored.total === 1111, `total=${anchored.total}`);

const sys = buildAnalysis(projection([{ role: "system", content: "", sections: { preamble: "x".repeat(40) } }]));
check("system sections count as tokens", sys.estTotal === 10, `est=${sys.estTotal}`);
const img = buildAnalysis(projection([{ role: "user", content: [{ type: "image" }] }]));
check("images use the fixed token estimate", img.estTotal === 1200, `est=${img.estTotal}`);

const turns = buildAnalysis(projection([
	user("a"),
	{ role: "compactionSummary", summary: "s" },
	{ role: "branchSummary", summary: "b" },
	{ role: "custom", content: [{ type: "text", text: "c" }] },
]));
check("summaries and custom messages open turns", turns.currentTurn === 4, `turn=${turns.currentTurn}`);

// --- collector edge cases ---
const stubbed = buildAnalysis(projection([
	user("a"),
	assistant([call("c1", "bash", { command: "x" })]),
	result("c1", "bash", "[bash 'x' elided by /prune (turn 1, ~5 tok).]"),
	user("b"),
]), { protectTurns: 0 });
check("already-stubbed results are not episodes", stubbed.reclaimable.episodes.length === 0);

const newest = buildAnalysis(projection([
	user("a"),
	assistant([thinking(800)]),
	user("b"),
]), { protectTurns: 0 });
check("newest assistant thinking stays protected", newest.reclaimable.thinking.length === 0);

const referent = projection([
	user("a"),
	assistant([thinking(800), call("r1", "read", { path: "/tmp/x" })]),
	result("r1", "read", "x".repeat(1600)),
	assistant([call("r2", "read", { path: "/tmp/x" })]),
	result("r2", "read", "x".repeat(1600)),
	user("b"),
]);
const refAnalysis = buildAnalysis(referent, { protectTurns: 1 });
check(
	"young thinking with a pruned referent is eligible",
	refAnalysis.reclaimable.thinking.length === 1 && refAnalysis.reclaimable.thinking[0].coherentOnly === true,
);
const refPlan = buildPrunePlan(refAnalysis, (id) => contentOf(referent, id), (id) => contentOf(referent, id));
check(
	"referent-pruned thinking yields a strip and a note",
	refPlan.edits.some((e) => e.kind === "thinking-strip" && e.targetId === "e1") && refPlan.coherenceNote.includes("referent-pruned"),
	refPlan.coherenceNote,
);

const staleProj = (chars) => projection([
	user("a"),
	assistant([call("c1", "read", { path: "/tmp/a" })]),
	result("c1", "read", "x".repeat(chars)),
	user("b"),
]);
check("stale boundary includes exactly 300 tok", buildAnalysis(staleProj(1200), { protectTurns: 0 }).reclaimable.stale.length === 1);
check("stale boundary excludes 299 tok", buildAnalysis(staleProj(1196), { protectTurns: 0 }).reclaimable.stale.length === 0);

const supersededProj = (chars) => projection([
	user("a"),
	assistant([call("r1", "read", { path: "/tmp/a" })]),
	result("r1", "read", "x".repeat(chars)),
	assistant([call("r2", "read", { path: "/tmp/a" })]),
	result("r2", "read", "x".repeat(chars)),
	user("b"),
]);
check("superseded boundary includes exactly 100 tok", buildAnalysis(supersededProj(400), { protectTurns: 1 }).reclaimable.superseded.length === 1);
check("superseded boundary excludes 99 tok", buildAnalysis(supersededProj(396), { protectTurns: 1 }).reclaimable.superseded.length === 0);

// --- plan edge cases ---
const missingRaw = buildPrunePlan(
	analysisOf({ stale: [info({ entryId: "s1", role: "toolResult", toolName: "read", tokens: 400, split: { text: 400, thinking: 0, toolArgs: 0, images: 0 }, digest: "/tmp/a" })] }),
	() => undefined,
	() => undefined,
);
check("missing original skips the edit", missingRaw.edits.length === 0);

const assistantInfo = info({ entryId: "a1" });
const resultInfo = info({
	entryId: "r1", role: "toolResult", tokens: 10,
	split: { text: 10, thinking: 0, toolArgs: 0, images: 0 }, toolCallId: "missing",
});
const orphanAssistant = [{ type: "text", text: "no call here" }];
const orphanResult = [{ type: "text", text: "ok" }];
const orphanPlan = buildPrunePlan(
	analysisOf({ episodes: [{ result: resultInfo, assistant: assistantInfo, callTokens: 20 }] }),
	(id) => (id === "a1" ? orphanAssistant : orphanResult),
	(id) => (id === "a1" ? orphanAssistant : orphanResult),
);
check("episode without a paired call drops nothing", orphanPlan.edits.length === 0);

const argsPlan = (argsContent) => buildPrunePlan(
	analysisOf({ args: [{ entryId: "a1", callIds: ["c1"], tokens: 50 }] }),
	() => argsContent,
	() => argsContent,
);
check("args under the per-call floor stay", argsPlan([call("c1", "bash", { command: "x".repeat(150) })]).edits.length === 0);
check("args over the per-call floor clear", (() => {
	const plan = argsPlan([call("c1", "bash", { command: "x".repeat(200) })]);
	return plan.edits.length === 1 && plan.edits[0].kind === "args-clear";
})());
const pointerProjection = staleProj(1200);
const pointerPlan = buildPrunePlan(
	buildAnalysis(pointerProjection, { protectTurns: 0 }),
	(id) => contentOf(pointerProjection, id),
	(id) => contentOf(pointerProjection, id),
);
const pointerStub = pointerPlan.edits.find((e) => e.kind === "tool-stub");
check(
	"stub text carries its recall id",
	typeof pointerStub?.replacement?.content === "string" && pointerStub.replacement.content.includes(pointerStub.targetId),
);
const pointerArgs = buildPrunePlan(
	analysisOf({ args: [{ entryId: "a1", callIds: ["c1"], tokens: 50 }] }),
	() => [call("c1", "bash", { command: "x".repeat(200) })],
	() => [call("c1", "bash", { command: "x".repeat(200) })],
);
const pointerArgBlock = pointerArgs.edits[0]?.replacement?.content?.find?.((b) => b.type === "toolCall");
check("cleared args carry their recall id", String(pointerArgBlock?.arguments?.pi_prune_elided ?? "").includes("a1"));

// --- apply and unprune failure paths ---
const twoEditPlan = {
	edits: [
		{ targetId: "ok", kind: "tool-stub", tokens: 10, original: { a: 1 }, replacement: { content: "stub" } },
		{ targetId: "bad", kind: "tool-stub", tokens: 10, original: { b: 2 }, replacement: { content: "stub" } },
	],
	summaryLines: [],
	coherenceNote: "",
	grossTokens: 20,
	netTokens: 19,
	staleMinAge: 3,
};
const appended = [];
const failingManager = {
	getEntry: () => undefined,
	appendCustomEntry: (type, data) => { appended.push({ type, data }); return "rec1"; },
	getBranch: () => [],
	appendContextEdit: (id) => { if (id === "bad") throw new Error("boom"); return "edit"; },
};
const applied = applyPrunePlan(failingManager, twoEditPlan);
check("apply reports a partial failure", applied.applied === 1 && applied.failed === 1 && applied.recordId === "rec1");
check("apply error names the target and cause", applied.errors.some((e) => e.includes("bad") && e.includes("boom")));
check("apply writes the record before edits", appended.length === 1 && appended[0].type === "pi-prune-record");

const markers = [];
const undoManager = {
	getEntry: () => undefined,
	appendCustomEntry: (type, data) => { markers.push({ type, data }); return "m1"; },
	getBranch: () => [],
	appendContextEdit: (id) => { if (id === "bad") throw new Error("nope"); return "edit"; },
};
const undone = applyUnprune(undoManager, { id: "rec9", data: { edits: [{ targetId: "ok", original: 1 }, { targetId: "bad", original: 2 }] } });
check("unprune reports a partial failure", undone.restored === 1 && undone.failed === 1 && undone.errors.some((e) => e.includes("bad")));
check(
	"unprune records the failure count",
	markers.length === 1 && markers[0].type === "pi-prune-unprune-marker" && markers[0].data.recordId === "rec9" && markers[0].data.failed === 1,
);

// --- stats and drafts ---
const stats = collectPruneStats([
	{ id: "a", type: "custom", customType: "pi-prune-record", data: { netTokens: 100 } },
	{ id: "b", type: "custom", customType: "pi-prune-record", data: { netTokens: "x" } },
	{ id: "c", type: "custom", customType: "pi-prune-record", data: { netTokens: 50, trigger: "context" } },
	{ id: "d", type: "custom", customType: "pi-prune-unprune-marker", data: { recordId: "c" } },
]);
check("malformed records are skipped and undone batches excluded", stats.batches === 1 && stats.netTokens === 100 && stats.manual === 1 && stats.auto === 0, JSON.stringify(stats));
const pendingManual = withPendingBatch({ batches: 1, manual: 1, auto: 0, netTokens: 100 }, 25, "manual");
check("pending manual batch increments manual", pendingManual.manual === 2 && pendingManual.auto === 0 && pendingManual.netTokens === 125);

const originals = collectPruneOriginals([
	{ id: "r1", type: "custom", customType: "pi-prune-record", data: { netTokens: 100, edits: [{ targetId: "a1", kind: "tool-stub", tokens: 100, original: [{ type: "text", text: "first" }] }] } },
	{ id: "r2", type: "custom", customType: "pi-prune-record", data: { netTokens: 50, edits: [{ targetId: "a2", kind: "args-clear", tokens: 50, original: [] }] } },
	{ id: "u1", type: "custom", customType: "pi-prune-unprune-marker", data: { recordId: "r2" } },
]);
check("recall map keeps live records and drops undone ones", originals.has("a1") && !originals.has("a2"), [...originals.keys()].join(","));
check(
	"recall map skips malformed edits",
	collectPruneOriginals([{ id: "r3", type: "custom", customType: "pi-prune-record", data: { netTokens: 1, edits: [null, { kind: "tool-stub" }] } }]).size === 0,
);

const draftPlan = {
	edits: [{ targetId: "a1", kind: "args-clear", tokens: 50, original: { content: [] }, replacement: { content: "stub" } }],
	summaryLines: [], coherenceNote: "", grossTokens: 50, netTokens: 50, staleMinAge: 3,
};
const drafts = planToDrafts(draftPlan, "manual");
check("drafts preserve the target and replacement", drafts[1].targetId === "a1" && JSON.stringify(drafts[1].replacement) === JSON.stringify({ content: "stub" }));
const record = buildPruneRecord(draftPlan, "manual");
check("record is versioned and timed", record.v === 2 && !Number.isNaN(Date.parse(record.createdAt)) && record.edits.length === 1);

// --- report shape ---
const emptyProjection = { entries: [] };
const emptyAnalysis = buildAnalysis(emptyProjection);
const emptyPlan = buildPrunePlan(emptyAnalysis, () => undefined, () => undefined);
const shortReport = formatReport(emptyAnalysis, { plan: emptyPlan });
check("short report shows the empty reclaimable state", shortReport.some((l) => l.includes("nothing eligible")));
check("short report omits full-only sections", !shortReport.some((l) => /cache economics|recency bands|compaction state/.test(l)));
const fullReport = formatReport(emptyAnalysis, {
	full: true, plan: emptyPlan, window: 200000,
	config: { protectTurns: 2, autoPrune: false, alertPercent: 60 }, configPath: "/tmp/cfg.json",
});
check("full report includes recency and compaction state", fullReport.some((l) => l.includes("recency bands")) && fullReport.some((l) => l.includes("never compacted")));
check("full report includes the config line", fullReport.some((l) => l.includes("/tmp/cfg.json")));
check("full report omits cache lines without an anchor", !fullReport.some((l) => l.includes("cache economics")));
check("full report includes cache lines with an anchor", formatReport(anchored, { full: true, plan: emptyPlan }).some((l) => l.includes("cache economics")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
