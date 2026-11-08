import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
	if (cond) { pass++; console.log(`PASS ${name}${extra ? " — " + extra : ""}`); }
	else { fail++; console.log(`FAIL ${name}${extra ? " — " + extra : ""}`); }
};

const configDir = "/tmp/pi-prune-ext-config";
fs.rmSync(configDir, { recursive: true, force: true });
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(join(configDir, "pi-prune.json"), JSON.stringify({
	protectTurns: 2,
	autoPrune: { reclaimablePercent: 1, minReclaimableTokens: 1, cooldownMinutes: 0 },
	alertPercent: null,
}));
process.env.PI_CODING_AGENT_DIR = configDir;

const { default: factory, collectPruneStats } = await import("../extensions/pi-prune.ts");

execFileSync(process.execPath, ["test/make-fixture.mjs", "/tmp"], { cwd: new URL("..", import.meta.url).pathname, stdio: "pipe" });
const sessionFile = "/tmp/pi-prune-extension-e2e.jsonl";
fs.copyFileSync("/tmp/pi-prune-fixture.jsonl", sessionFile);
const sm = SessionManager.open(sessionFile);

const handlers = {};
const commands = {};
const notices = [];
const pi = {
	on: (name, fn) => { handlers[name] = fn; },
	registerCommand: (name, options) => { commands[name] = options; },
	getSettings: () => ({ compaction: { reserveTokens: 16384 } }),
};
factory(pi);

check("handlers registered", ["session_start", "session_compact", "turn_end", "agent_settled", "agent_start", "session_before_switch", "session_before_fork", "session_shutdown"].every((n) => typeof handlers[n] === "function"));
check("commands registered", ["ctx", "prune", "unprune", "prune-config"].every((n) => typeof commands[n]?.handler === "function"));

const ctx = {
	mode: "tui",
	hasUI: false,
	cwd: process.cwd(),
	sessionManager: sm,
	model: { provider: "test", id: "test-model", contextWindow: 200000 },
	getContextUsage: () => ({ tokens: 180000, contextWindow: 200000, percent: 90 }),
	isIdle: () => true,
	ui: { notify: (message, type) => notices.push({ message, type }) },
};

const aborted = await handlers.turn_end({ outcome: "aborted" }, ctx);
check("aborted turn does nothing", aborted === undefined && notices.length === 0);

const result = await handlers.turn_end({ outcome: "completed" }, ctx);
check("turn_end returns boundary drafts", result?.entries?.length > 1 && result.entries[0].type === "custom");
check("turn_end notifies auto prune", notices.some((n) => n.message.includes("auto-prune (")));

for (const draft of result.entries) {
	if (draft.type === "custom") sm.appendCustomEntry(draft.customType, draft.data);
	else sm.appendContextEdit(draft.targetId, draft.replacement);
}
const stats = collectPruneStats(sm.getBranch());
check("boundary batch persisted", stats.batches === 1 && stats.auto === 1 && stats.netTokens > 0);

const before = sm.buildSessionProjection().entries.length;
const branchBeforeLow = sm.getBranch().length;
const ctxLow = { ...ctx, getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0 }) };
const second = await handlers.turn_end({ outcome: "completed" }, ctxLow);
check("below threshold no prune", second === undefined && sm.getBranch().length === branchBeforeLow);

const configFilePath = join(configDir, "pi-prune.json");
await commands["prune-config"].handler("protectTurns=3 autoPrune.contextPercent=85", ctx);
const patchedConfig = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
check("prune-config key=value writes config", patchedConfig.protectTurns === 3 && patchedConfig.autoPrune.contextPercent === 85);
await commands["prune-config"].handler("reset", ctx);
const resetConfig = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
check("prune-config reset writes defaults", resetConfig.protectTurns === 2 && resetConfig.alertPercent === 60 && resetConfig.autoPrune === false);

let uiStep = 0;
const uiScript = [
	{ select: "Protect turns: 2" },
	{ input: "3" },
	{ select: "Done" },
];
const uiCtx = {
	...ctx,
	hasUI: true,
	ui: {
		notify: (message, type) => notices.push({ message, type }),
		select: async () => uiScript[uiStep++]?.select,
		input: async () => uiScript[uiStep++]?.input,
		confirm: async () => true,
	},
};
await commands["prune-config"].handler("", uiCtx);
const wizardConfig = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
check("prune-config wizard writes config", wizardConfig.protectTurns === 3);
notices.length = 0;
await commands["prune-config"].handler("show", ctx);
check("prune-config show prints path", notices.some((n) => n.message.includes(configFilePath)));
notices.length = 0;
await commands["prune-config"].handler("protectTurns", ctx);
check("prune-config rejects malformed args", notices.some((n) => n.type === "error" && n.message.includes("expected key=value")));

fs.writeFileSync(join(configDir, "pi-prune.json"), "{ not json");
notices.length = 0;
handlers.session_start({}, ctx);
check("bad config warns on session start", notices.some((n) => n.type === "warning" && n.message.includes("pi-prune config")));
check("session start keeps projection stable", sm.buildSessionProjection().entries.length === before);

// --- command unhappy paths ---
const commandSession = "/tmp/pi-prune-extension-commands.jsonl";
fs.copyFileSync("/tmp/pi-prune-fixture.jsonl", commandSession);
const smCmd = SessionManager.open(commandSession);
const cmdCtx = {
	...ctx,
	sessionManager: smCmd,
	ui: {
		notify: (message, type) => notices.push({ message, type }),
		custom: async () => {},
		confirm: async () => true,
	},
};
notices.length = 0;
const errorTurn = await handlers.turn_end({ outcome: "error" }, cmdCtx);
check("error turn does nothing", errorTurn === undefined && notices.length === 0);

const emptyCtx = {
	...cmdCtx,
	sessionManager: { buildSessionProjection: () => ({ entries: [] }), getBranch: () => [] },
};
notices.length = 0;
await commands["ctx"].handler("", emptyCtx);
check("ctx on an empty session notifies", notices.some((n) => n.message === "ctx: empty session"));
notices.length = 0;
await commands["prune"].handler("", emptyCtx);
check("prune with nothing eligible notifies", notices.some((n) => n.message.includes("nothing eligible")));
notices.length = 0;
await commands["unprune"].handler("", cmdCtx);
check("unprune with no record notifies", notices.some((n) => n.message.includes("no un-undone prune record")));

const cancelCtx = { ...cmdCtx, hasUI: true, ui: { ...cmdCtx.ui, confirm: async () => false } };
const branchBefore = smCmd.getBranch().length;
notices.length = 0;
await commands["prune"].handler("", cancelCtx);
check("prune cancel writes nothing", smCmd.getBranch().length === branchBefore && notices.length === 0);

notices.length = 0;
await commands["prune-config"].handler("", cmdCtx);
check("prune-config bare shows config without UI", notices.some((n) => n.message.includes("auto-prune:")));

let rendered = null;
let overlayClosed = false;
const overlayCtx = {
	...cmdCtx,
	mode: "tui",
	ui: {
		...cmdCtx.ui,
		custom: async (fn) => {
			const widget = fn(null, null, null, () => { overlayClosed = true; });
			rendered = widget.render(200);
			widget.handleInput("x");
		},
	},
};
notices.length = 0;
await commands["ctx"].handler("full", overlayCtx);
check("ctx full renders the overlay", Array.isArray(rendered) && rendered.some((l) => l.startsWith("ctx (full)")), rendered?.[0]);
check("any key closes the overlay", overlayClosed === true);

// valid config file so the next checks exercise validation, not JSON parsing
fs.writeFileSync(configFilePath, JSON.stringify({ protectTurns: 2, alertPercent: 60, autoPrune: false }));
const beforeInvalid = fs.readFileSync(configFilePath, "utf8");
notices.length = 0;
await commands["prune-config"].handler("protectTurns=999", cmdCtx);
check("prune-config rejects an out-of-range value without writing", notices.some((n) => n.type === "error" && n.message.includes("protectTurns")) && fs.readFileSync(configFilePath, "utf8") === beforeInvalid);

const resetCtx = { ...cmdCtx, hasUI: true, ui: { ...cmdCtx.ui, confirm: async () => false } };
const beforeReset = fs.readFileSync(configFilePath, "utf8");
notices.length = 0;
await commands["prune-config"].handler("reset", resetCtx);
check("prune-config reset cancel leaves the file unchanged", fs.readFileSync(configFilePath, "utf8") === beforeReset);

await commands["prune-config"].handler("alertPercent=null", cmdCtx);
notices.length = 0;
const settledTurn = await handlers.turn_end({ outcome: "completed" }, cmdCtx);
check("turn_end skips work when auto and alert are off", settledTurn === undefined && notices.length === 0);

// --- config wizard branches ---
let invalidStep = 0;
const invalidScript = [{ select: "Protect turns: 2" }, { input: "abc" }, { select: "Done" }];
const invalidWizardCtx = {
	...cmdCtx,
	hasUI: true,
	ui: {
		...cmdCtx.ui,
		select: async () => invalidScript[invalidStep++]?.select,
		input: async () => invalidScript[invalidStep++]?.input,
	},
};
const beforeInvalidWizard = fs.readFileSync(configFilePath, "utf8");
notices.length = 0;
await commands["prune-config"].handler("", invalidWizardCtx);
check(
	"wizard rejects non-numeric protect turns without writing",
	notices.some((n) => n.type === "error" && n.message.includes("protectTurns")) && fs.readFileSync(configFilePath, "utf8") === beforeInvalidWizard,
);

let autoStep = 0;
const autoScript = [{ select: "Auto-prune: off" }, { select: "On" }, { select: "Done" }];
const autoWizardCtx = {
	...cmdCtx,
	hasUI: true,
	ui: { ...cmdCtx.ui, select: async () => autoScript[autoStep++]?.select },
};
await commands["prune-config"].handler("", autoWizardCtx);
const autoConfig = JSON.parse(fs.readFileSync(configFilePath, "utf8"));
check("wizard enables auto-prune with safe defaults", autoConfig.autoPrune?.minReclaimableTokens === 15000 && autoConfig.autoPrune?.cooldownMinutes === 10);

// --- idle timer wiring ---
fs.writeFileSync(configFilePath, JSON.stringify({
	protectTurns: 2,
	alertPercent: null,
	autoPrune: { idleMinutes: 0.0001, minReclaimableTokens: 1, cooldownMinutes: 0 },
}));
const idleSession = "/tmp/pi-prune-extension-idle.jsonl";
fs.copyFileSync("/tmp/pi-prune-fixture.jsonl", idleSession);
const smIdle = SessionManager.open(idleSession);
const idleCtx = { ...cmdCtx, sessionManager: smIdle, isIdle: () => true };
notices.length = 0;
handlers.session_start({}, idleCtx);
handlers.agent_settled({}, idleCtx);
await new Promise((resolve) => setTimeout(resolve, 150));
check("idle timer arms and prunes after the agent settles", notices.some((n) => n.message.includes("auto-prune (idle)")) && collectPruneStats(smIdle.getBranch()).auto === 1);
handlers.agent_start({}, idleCtx);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
