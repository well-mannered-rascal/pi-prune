import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	parseConfig, loadConfig, evaluateTriggers, buildAnalysis, buildPrunePlan,
	applyPrunePlan, collectPruneStats, withPendingBatch, applyUnprune, planToDrafts, planCategoryRows,
	defaultConfigRaw, readConfigObject, writeConfigFile, parseConfigArgs, applyConfigPatch,
} from "../extensions/pi-prune.ts";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}${extra ? " — " + extra : ""}`); }
	else { fail++; console.log(`FAIL ${name}${extra ? " — " + extra : ""}`); }
};

// --- config parsing ---
const defaults = parseConfig({});
check("config defaults", defaults.config.protectTurns === 2 && defaults.config.autoPrune === false && defaults.config.alertPercent === 60 && defaults.warnings.length === 0);

const parsed = parseConfig({
	protectTurns: 4,
	autoPrune: { contextPercent: 85, reclaimablePercent: 30, minReclaimableTokens: 15000, idleMinutes: 60, cooldownMinutes: 10 },
	alertPercent: 70,
});
const auto = parsed.config.autoPrune;
check("config values", parsed.config.protectTurns === 4 && parsed.config.alertPercent === 70 && auto !== false && auto.contextPercent === 85 && auto.reclaimablePercent === 30 && auto.minReclaimableTokens === 15000 && auto.idleMinutes === 60 && auto.cooldownMinutes === 10);

const bad = parseConfig({
	protectTurns: -1,
	alertPercent: 0,
	autoPrune: { contextPercent: 101, reclaimablePercent: "x", minReclaimableTokens: -5, idleMinutes: 0, cooldownMinutes: -1 },
});
check("bad values warn once per field", bad.warnings.length === 7, `warnings=${bad.warnings.length}`);
check(
	"bad values name each field",
	["protectTurns", "alertPercent", "autoPrune.contextPercent", "autoPrune.reclaimablePercent", "autoPrune.minReclaimableTokens", "autoPrune.idleMinutes", "autoPrune.cooldownMinutes"]
		.every((field) => bad.warnings.some((warning) => warning.startsWith(field))),
);
check("bad values fall back", bad.config.protectTurns === 2 && bad.config.alertPercent === 60 && bad.config.autoPrune !== false && bad.config.autoPrune.minReclaimableTokens === 15000 && bad.config.autoPrune.cooldownMinutes === 10);

const off = parseConfig({ autoPrune: false, alertPercent: null });
check("alert null disables", off.config.autoPrune === false && off.config.alertPercent === undefined);

const nonObject = parseConfig([]);
check("non-object config warns and uses defaults", nonObject.warnings.length === 1 && nonObject.config.protectTurns === 2 && nonObject.config.autoPrune === false);
const badAuto = parseConfig({ autoPrune: true });
check("non-object autoPrune warns and disables", badAuto.config.autoPrune === false && badAuto.warnings.some((w) => w.includes("autoPrune")));
check("empty args produce an empty patch", parseConfigArgs("   ").length === 0);
check("key without a name throws", (() => { try { parseConfigArgs("=1"); return false; } catch { return true; } })());
const fromString = applyConfigPatch({ autoPrune: "broken" }, parseConfigArgs("autoPrune.contextPercent=80"));
check("nested patch replaces a non-object autoPrune", fromString.autoPrune.contextPercent === 80);

const missingLoad = loadConfig("/tmp/pi-prune-no-such-config.json");
check("missing config loads defaults quietly", missingLoad.warnings.length === 0 && missingLoad.config.protectTurns === 2 && missingLoad.config.autoPrune === false);
const brokenPath = "/tmp/pi-prune-broken-config.json";
fs.writeFileSync(brokenPath, "{ not json");
const brokenLoad = loadConfig(brokenPath);
check("unreadable config warns and uses defaults", brokenLoad.warnings.length === 1 && brokenLoad.warnings[0].includes(brokenPath) && brokenLoad.config.autoPrune === false);
fs.rmSync(brokenPath, { force: true });
const nonObjectPath = "/tmp/pi-prune-non-object-config.json";
fs.writeFileSync(nonObjectPath, "[1,2]");
check("readConfigObject rejects non-object JSON", (() => { try { readConfigObject(nonObjectPath); return false; } catch { return true; } })());
fs.rmSync(nonObjectPath, { force: true });

const configEditPath = "/tmp/pi-prune-config-edit.json";
fs.rmSync(configEditPath, { force: true });
const baseRaw = { protectTurns: 4, unknown: "keep" };
const patchedRaw = applyConfigPatch(baseRaw, parseConfigArgs("protectTurns=3 autoPrune.contextPercent=85 autoPrune.idleMinutes=60"));
check("config patch preserves unknown keys and input", patchedRaw.unknown === "keep" && baseRaw.protectTurns === 4);
check("config patch applies nested values", patchedRaw.protectTurns === 3 && patchedRaw.autoPrune.contextPercent === 85 && patchedRaw.autoPrune.idleMinutes === 60);
const removedRaw = applyConfigPatch({ autoPrune: { contextPercent: 85, cooldownMinutes: 20 } }, parseConfigArgs("autoPrune.contextPercent=null"));
check("config patch null removes nested key", removedRaw.autoPrune.contextPercent === undefined && removedRaw.autoPrune.cooldownMinutes === 20);
check("config patch rejects malformed args", (() => { try { parseConfigArgs("protectTurns"); return false; } catch { return true; } })());
writeConfigFile(configEditPath, patchedRaw);
const rereadRaw = readConfigObject(configEditPath);
check("config write roundtrip", rereadRaw.autoPrune.contextPercent === 85 && rereadRaw.unknown === "keep");
const defaultRaw = defaultConfigRaw();
check("default config raw", defaultRaw.protectTurns === 2 && defaultRaw.alertPercent === 60 && defaultRaw.autoPrune === false);
const invalidRaw = parseConfig(applyConfigPatch({}, parseConfigArgs("protectTurns=999")));
check("config patch validation catches bad values", invalidRaw.warnings.length === 1 && invalidRaw.config.protectTurns === 2);
fs.rmSync(configEditPath, { force: true });

// --- trigger evaluation ---
const now = 1_000_000_000;
const cfg = {
	protectTurns: 2,
	alertPercent: 60,
	autoPrune: { contextPercent: 80, reclaimablePercent: 30, minReclaimableTokens: 15000, idleMinutes: 60, cooldownMinutes: 10 },
};
const ev = (over) => evaluateTriggers({
	total: 100000, window: 200000, reserveTokens: 16384, planNetTokens: 16000,
	config: cfg, now, lastAutoPruneAt: 0, idle: false, ...over,
});

let d = ev({});
check("no trigger below thresholds", d.auto === null && d.alert === false);

d = ev({ total: 170000 });
check("context trigger", d.auto === "context", `auto=${d.auto}`);
check("alert after partial prune", d.alert === true && Math.round(d.effectivePercent) === 77);

d = ev({ total: 100000, planNetTokens: 40000 });
check("reclaimable trigger", d.auto === "reclaimable", `auto=${d.auto}`);

d = ev({ total: 170000, planNetTokens: 10000 });
check("floor blocks auto", d.auto === null);
check("floor still alerts", d.alert === true);

d = ev({ total: 170000, lastAutoPruneAt: now - 5 * 60_000 });
check("cooldown blocks auto", d.auto === null);
d = ev({ total: 186000, lastAutoPruneAt: now - 5 * 60_000 });
check("cooldown forced near compaction", d.auto === "context");

d = ev({ idle: true });
check("idle trigger", d.auto === "idle");
const noIdle = { ...cfg, autoPrune: { ...cfg.autoPrune, idleMinutes: undefined } };
d = evaluateTriggers({ total: 100000, window: 200000, reserveTokens: 16384, planNetTokens: 16000, config: noIdle, now, lastAutoPruneAt: 0, idle: true });
check("idle disabled when unset", d.auto === null);

d = ev({ window: 0, total: 170000 });
check("no window no auto", d.auto === null && d.alert === false);
d = ev({ planNetTokens: -500 });
check("negative plan net clamps to zero", d.effectiveTokens === 100000 && d.effectivePercent === 50 && d.auto === null);
d = ev({ total: 170000, idle: true });
check("idle takes precedence over context", d.auto === "idle");
d = ev({ total: 186000, planNetTokens: 10000, lastAutoPruneAt: now });
check("forced does not bypass the reclaim floor", d.auto === null);
d = evaluateTriggers({ total: 0, window: 200000, reserveTokens: 16384, planNetTokens: 20000, config: cfg, now, lastAutoPruneAt: 0, idle: false });
check("reclaimable percent is not evaluated at zero context", d.auto === null);
d = evaluateTriggers({ total: 199000, window: 200000, reserveTokens: 16384, planNetTokens: 0, config: { ...cfg, alertPercent: undefined }, now, lastAutoPruneAt: 0, idle: false });
check("alert is disabled when alertPercent is unset", d.alert === false);
d = ev({ total: 120000, planNetTokens: 0 });
check("alert fires at the exact threshold", d.alert === true);
d = ev({ total: 119000, planNetTokens: 0 });
check("alert stays quiet below the threshold", d.alert === false);
d = evaluateTriggers({ total: 130000, window: 200000, reserveTokens: 16384, planNetTokens: 20000, config: { ...cfg, autoPrune: false }, now, lastAutoPruneAt: 0, idle: false });
check("alert uses max-prune projection", d.auto === null && d.alert === false);
d = evaluateTriggers({ total: 130000, window: 200000, reserveTokens: 16384, planNetTokens: 0, config: { ...cfg, autoPrune: false }, now, lastAutoPruneAt: 0, idle: false });
check("alert with nothing prunable", d.alert === true);

// --- protectTurns ---

execFileSync(process.execPath, ["test/make-fixture.mjs", "/tmp"], { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe" });
const tmp = "/tmp/pi-prune-config-e2e.jsonl";
fs.copyFileSync("/tmp/pi-prune-fixture.jsonl", tmp);
const sm = SessionManager.open(tmp);
const proj = sm.buildSessionProjection();
const a0 = buildAnalysis(proj, { protectTurns: 0 });
const a4 = buildAnalysis(proj, { protectTurns: 4 });
check("protectTurns stored", a0.protectTurns === 0 && a0.staleMinAge === 1 && a4.protectTurns === 4 && a4.staleMinAge === 5);
check("higher protectTurns reclaims less", a0.reclaimable.stale.length > a4.reclaimable.stale.length, `a0=${a0.reclaimable.stale.length} a4=${a4.reclaimable.stale.length}`);

// --- plan accounting and persistence ---
const plan = buildPrunePlan(a0, (id) => sm.getEntry(id)?.message?.content, (id) => {
	const pe = proj.entries.find((p) => p.sourceEntry.id === id);
	return pe?.messages?.[0]?.content;
});
let clearedCalls = 0;
for (const e of plan.edits) {
	if (!Array.isArray(e.replacement?.content)) continue;
	for (const b of e.replacement.content) {
		if (b.type === "toolCall" && b.arguments?.pi_prune_elided !== undefined) clearedCalls++;
	}
}
const stubs = plan.edits.filter((e) => e.kind === "tool-stub").length;
const expectedNet = plan.grossTokens - stubs * 30 - clearedCalls * 15;
check("net accounts per cleared call", Math.abs(plan.netTokens - expectedNet) <= 1, `net=${plan.netTokens} expected=${expectedNet} calls=${clearedCalls} stubs=${stubs}`);
check("plan carries staleMinAge", plan.staleMinAge === 1);

{
	const content = [
		{ type: "thinking", thinking: "x".repeat(800) },
		{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "x".repeat(300) } },
	];
	const info = { entryId: "a1", role: "assistant", message: {}, turn: 0, age: 5, tokens: 0, split: { text: 0, thinking: 800, toolArgs: 0, images: 0 }, digest: "" };
	const merged = buildPrunePlan({
		protectTurns: 2,
		staleMinAge: 3,
		reclaimable: { superseded: [], stale: [], thinking: [info], args: [{ entryId: "a1", callIds: ["c1"], tokens: 100 }], episodes: [], total: 0 },
	}, () => content, () => content);
	const rows = planCategoryRows(merged);
	const thinkRow = rows.find((row) => row.label === "assistant thinking");
	const argsRow = rows.find((row) => row.label === "tool call args");
	check("merged thinking+args rows split tokens", thinkRow?.tokens === 200 && argsRow?.tokens === 100, `think=${thinkRow?.tokens} args=${argsRow?.tokens}`);
}

{
	const content = [
		{ type: "thinking", thinking: "x".repeat(800) },
		{ type: "toolCall", id: "ep", name: "bash", arguments: { command: "small" } },
		{ type: "toolCall", id: "args", name: "bash", arguments: { command: "x".repeat(300) } },
	];
	const resultContent = [{ type: "text", text: "ok" }];
	const info = { entryId: "a2", role: "assistant", message: {}, turn: 0, age: 5, tokens: 0, split: { text: 0, thinking: 800, toolArgs: 0, images: 0 }, digest: "" };
	const result = { entryId: "r2", role: "toolResult", message: {}, turn: 0, age: 5, tokens: 10, split: { text: 10, thinking: 0, toolArgs: 0, images: 0 }, digest: "", toolCallId: "ep" };
	const merged = buildPrunePlan({
		protectTurns: 2,
		staleMinAge: 3,
		reclaimable: {
			superseded: [],
			stale: [],
			thinking: [info],
			args: [{ entryId: "a2", callIds: ["args"], tokens: 100 }],
			episodes: [{ result, assistant: info, callTokens: 20 }],
			total: 0,
		},
	}, (id) => id === "a2" ? content : resultContent, (id) => id === "a2" ? content : resultContent);
	const rows = planCategoryRows(merged);
	const thinkRow = rows.find((row) => row.label === "assistant thinking");
	const argsRow = rows.find((row) => row.label === "tool call args");
	const episodeRow = rows.find((row) => row.label === "small episodes");
	check("merged thinking+args+episode rows sum to gross", rows.reduce((s, row) => s + row.tokens, 0) === merged.grossTokens, `rows=${rows.map((row) => `${row.label}=${row.tokens}`).join(",")} gross=${merged.grossTokens}`);
	const episodeCallTokens = Math.ceil(("bash".length + JSON.stringify({ command: "small" }).length) / 4);
	check("merged thinking+args+episode parts split", thinkRow?.tokens === 200 && argsRow?.tokens === 100 && episodeRow?.tokens === 10 + episodeCallTokens, `think=${thinkRow?.tokens} args=${argsRow?.tokens} ep=${episodeRow?.tokens}`);
}

const drafts = planToDrafts(plan, "context");
check("drafts shape", drafts.length === plan.edits.length + 1 && drafts[0].type === "custom" && drafts.slice(1).every((d) => d.type === "context_edit"));
check("record is v2", drafts[0].data.v === 2 && drafts[0].data.trigger === "context" && drafts[0].data.netTokens === plan.netTokens);

const result = applyPrunePlan(sm, plan, "context");
const stats = collectPruneStats(sm.getBranch());
check("stats after auto prune", stats.batches === 1 && stats.auto === 1 && stats.manual === 0 && stats.netTokens === plan.netTokens);
const pending = withPendingBatch(stats, 500, "idle");
check("pending batch adds", pending.batches === 2 && pending.auto === 2 && pending.netTokens === plan.netTokens + 500);

const rec = sm.getBranch().find((e) => e.type === "custom" && e.customType === "pi-prune-record");
check("record persisted", rec?.data?.v === 2 && rec.data.trigger === "context" && Array.isArray(rec.data.edits));

const undo = applyUnprune(sm, rec);
check("unprune restores", undo.restored === plan.edits.length && undo.failed === 0);
const afterUndo = collectPruneStats(sm.getBranch());
check("stats exclude undone batch", afterUndo.batches === 0 && afterUndo.netTokens === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
