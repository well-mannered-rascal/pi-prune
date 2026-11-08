import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ContextEditEntryDraft, ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_PROTECT_TURNS = 2;
const STALE_MIN_TOKENS = 300;
const SUPERSEDED_MIN_TOKENS = 100;
const THINK_MIN_TOKENS = 200;
const ARGS_MIN_TOKENS = 50;
const STALE_TOOLS: ReadonlySet<string> = new Set([
	"read", "bash", "edit", "write", "web_fetch", "web_search", "grep", "glob", "find", "ls",
]);
const STUB_MARKER = "elided by /prune";
const IMAGE_TOKENS = 1200;
const STUB_OVERHEAD_TOKENS = 40;
const ARGS_OVERHEAD_TOKENS = Math.round(STUB_OVERHEAD_TOKENS / 2);
const DEFAULT_RESERVE_TOKENS = 16384;
const DEFAULT_ALERT_PERCENT = 60;
const DEFAULT_MIN_RECLAIMABLE_TOKENS = 15000;
const DEFAULT_COOLDOWN_MINUTES = 10;
const CONFIG_FILE = "pi-prune.json";

export interface AutoPruneConfig {
	contextPercent?: number;
	reclaimablePercent?: number;
	minReclaimableTokens: number;
	idleMinutes?: number;
	cooldownMinutes: number;
}

export interface PruneConfig {
	protectTurns: number;
	autoPrune: AutoPruneConfig | false;
	alertPercent?: number;
}

export const DEFAULT_CONFIG: PruneConfig = {
	protectTurns: DEFAULT_PROTECT_TURNS,
	autoPrune: false,
	alertPercent: DEFAULT_ALERT_PERCENT,
};

export interface ConfigLoad {
	config: PruneConfig;
	warnings: string[];
	path: string;
}

interface NumberField {
	integer?: boolean;
	min: number;
	max: number;
	exclusiveMin?: boolean;
	fallback?: number;
	nullable?: boolean;
	hint: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function parseNumber(value: unknown, field: NumberField): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	if (field.integer && !Number.isInteger(value)) return undefined;
	if (field.exclusiveMin ? value <= field.min : value < field.min) return undefined;
	return value <= field.max ? value : undefined;
}

const ROOT_FIELDS: Record<string, NumberField> = {
	protectTurns: { integer: true, min: 0, max: 100, hint: "an integer from 0 to 100", fallback: DEFAULT_PROTECT_TURNS },
	alertPercent: { min: 1, max: 100, hint: "a number from 1 to 100 or null", fallback: DEFAULT_ALERT_PERCENT, nullable: true },
};

const AUTO_FIELDS: Record<string, NumberField> = {
	contextPercent: { min: 1, max: 100, hint: "a number from 1 to 100" },
	reclaimablePercent: { min: 1, max: 100, hint: "a number from 1 to 100" },
	minReclaimableTokens: { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER, hint: "a non-negative integer", fallback: DEFAULT_MIN_RECLAIMABLE_TOKENS },
	idleMinutes: { min: 0, max: Number.MAX_VALUE, exclusiveMin: true, hint: "a positive number" },
	cooldownMinutes: { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER, hint: "a non-negative integer", fallback: DEFAULT_COOLDOWN_MINUTES },
};

function parseFields(
	source: Record<string, unknown>,
	fields: Record<string, NumberField>,
	warnings: string[],
	prefix = "",
): Record<string, number | undefined> {
	const values: Record<string, number | undefined> = {};
	for (const [key, field] of Object.entries(fields)) {
		const raw = source[key];
		if (raw === null && field.nullable) {
			values[key] = undefined;
			continue;
		}
		if (raw === undefined) {
			values[key] = field.fallback;
			continue;
		}
		const value = parseNumber(raw, field);
		if (value === undefined) {
			const suffix = field.fallback === undefined ? "" : `, using ${field.fallback}`;
			warnings.push(`${prefix}${key} must be ${field.hint}${suffix}`);
			values[key] = field.fallback;
		} else {
			values[key] = value;
		}
	}
	return values;
}

export function parseConfig(raw: unknown): { config: PruneConfig; warnings: string[] } {
	const warnings: string[] = [];
	if (!isRecord(raw)) {
		return { config: { ...DEFAULT_CONFIG }, warnings: ["config must be a JSON object, using defaults"] };
	}

	const root = parseFields(raw, ROOT_FIELDS, warnings);
	const config: PruneConfig = {
		protectTurns: root.protectTurns ?? DEFAULT_PROTECT_TURNS,
		alertPercent: root.alertPercent,
		autoPrune: false,
	};

	if (raw.autoPrune !== undefined && raw.autoPrune !== false) {
		if (!isRecord(raw.autoPrune)) {
			warnings.push("autoPrune must be false or an object, disabling auto-prune");
		} else {
			const auto = parseFields(raw.autoPrune, AUTO_FIELDS, warnings, "autoPrune.");
			config.autoPrune = {
				contextPercent: auto.contextPercent,
				reclaimablePercent: auto.reclaimablePercent,
				minReclaimableTokens: auto.minReclaimableTokens ?? DEFAULT_MIN_RECLAIMABLE_TOKENS,
				idleMinutes: auto.idleMinutes,
				cooldownMinutes: auto.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES,
			};
		}
	}

	return { config, warnings };
}

export function agentConfigPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, CONFIG_FILE);
}

export function loadConfig(path = agentConfigPath()): ConfigLoad {
	if (!existsSync(path)) return { config: { ...DEFAULT_CONFIG }, warnings: [], path };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return { ...parseConfig(raw), path };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { config: { ...DEFAULT_CONFIG }, warnings: [`could not read ${path}: ${message}`], path };
	}
}

export type ConfigPatch = { key: string; value: unknown }[];

export function defaultConfigRaw(): Record<string, unknown> {
	return {
		protectTurns: DEFAULT_CONFIG.protectTurns,
		alertPercent: DEFAULT_CONFIG.alertPercent,
		autoPrune: false,
	};
}

export function readConfigObject(path = agentConfigPath()): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const raw = JSON.parse(readFileSync(path, "utf-8"));
	if (!isRecord(raw)) throw new Error(`${path} must contain a JSON object`);
	return raw;
}

export function writeConfigFile(path: string, raw: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
	renameSync(temp, path);
}

function parseConfigValue(value: string): unknown {
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	if (trimmed === "null" || trimmed === "off") return null;
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	const number = Number(trimmed);
	return Number.isFinite(number) ? number : trimmed;
}

export function parseConfigArgs(args: string): ConfigPatch {
	const patch: ConfigPatch = [];
	for (const token of args.trim().split(/\s+/)) {
		if (!token) continue;
		const separator = token.indexOf("=");
		if (separator <= 0) throw new Error(`expected key=value, got "${token}"`);
		patch.push({ key: token.slice(0, separator), value: parseConfigValue(token.slice(separator + 1)) });
	}
	return patch;
}

export function applyConfigPatch(raw: Record<string, unknown>, patch: ConfigPatch): Record<string, unknown> {
	const next = structuredClone(raw);
	for (const { key, value } of patch) {
		if (value === undefined) continue;
		if (!key.startsWith("autoPrune.")) {
			next[key] = value;
			continue;
		}
		const field = key.slice("autoPrune.".length);
		const current = isRecord(next.autoPrune) ? next.autoPrune : {};
		if (value === null) delete current[field];
		else current[field] = value;
		next.autoPrune = current;
	}
	return next;
}

export type AutoTrigger = "context" | "reclaimable" | "idle";

export interface TriggerInput {
	total: number;
	window: number;
	reserveTokens: number;
	planNetTokens: number;
	config: PruneConfig;
	now: number;
	lastAutoPruneAt: number;
	idle: boolean;
}

export interface TriggerDecision {
	auto: AutoTrigger | null;
	alert: boolean;
	effectiveTokens: number;
	effectivePercent: number;
}

export function evaluateTriggers(input: TriggerInput): TriggerDecision {
	const net = Math.max(0, input.planNetTokens);
	const effectiveTokens = Math.max(0, input.total - net);
	const effectivePercent = input.window > 0 ? (effectiveTokens / input.window) * 100 : 0;
	const alert = input.config.alertPercent !== undefined && input.window > 0 && effectivePercent >= input.config.alertPercent;
	const base: TriggerDecision = { auto: null, alert, effectiveTokens, effectivePercent };
	const auto = input.config.autoPrune;
	if (!auto || input.window <= 0) return base;

	const eligible = net > 0 && net >= auto.minReclaimableTokens;
	const forced = input.total >= input.window - input.reserveTokens;
	const cooldownOk = input.now - input.lastAutoPruneAt >= auto.cooldownMinutes * 60_000;
	if (!eligible || !(cooldownOk || forced)) return base;

	if (input.idle) return auto.idleMinutes === undefined ? base : { ...base, auto: "idle" };
	if (auto.contextPercent !== undefined && (input.total / input.window) * 100 >= auto.contextPercent) {
		return { ...base, auto: "context" };
	}
	if (auto.reclaimablePercent !== undefined && input.total > 0 && (net / input.total) * 100 >= auto.reclaimablePercent) {
		return { ...base, auto: "reclaimable" };
	}
	return base;
}

interface TextBlock { type: "text"; text: string }
interface ThinkingBlock { type: "thinking"; thinking: string }
interface ToolCallBlock { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | { type: string; [key: string]: unknown };

interface AnyMessage {
	role: string;
	content?: string | ContentBlock[];
	usage?: {
		input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
		cacheWrite1h?: number; reasoning?: number; totalTokens?: number;
		cost?: { total?: number };
	};
	stopReason?: string;
	summary?: string;
	command?: string;
	output?: string;
	sections?: Record<string, string | undefined>;
	toolsAdded?: unknown[];
	toolCallId?: string;
	toolName?: string;
}

interface ProjectedEntry { sourceEntry: { id: string; type: string }; messages: AnyMessage[] }
interface Projection { entries: ProjectedEntry[] }

interface TokenSplit { text: number; thinking: number; toolArgs: number; images: number }

function blocks(m: AnyMessage): ContentBlock[] {
	return Array.isArray(m.content) ? m.content : [];
}

const isToolCall = (block: unknown): block is ToolCallBlock =>
	(block as { type?: string }).type === "toolCall";

function splitMessage(m: AnyMessage): { total: number; split: TokenSplit } {
	const split: TokenSplit = { text: 0, thinking: 0, toolArgs: 0, images: 0 };
	let chars = 0;
	const addText = (text: string) => {
		chars += text.length;
		split.text += text.length;
	};

	if (m.role === "bashExecution") {
		chars += (m.command ?? "").length + (m.output ?? "").length;
	} else if (m.role === "compactionSummary" || m.role === "branchSummary") {
		addText(m.summary ?? "");
	} else {
		for (const block of blocks(m)) {
			if (block.type === "text") {
				addText(block.text);
			} else if (block.type === "image") {
				split.images++;
			} else if (m.role === "assistant" && block.type === "thinking") {
				chars += block.thinking.length;
				split.thinking += block.thinking.length;
			} else if (m.role === "assistant" && block.type === "toolCall") {
				const size = block.name.length + JSON.stringify(block.arguments ?? {}).length;
				chars += size;
				split.toolArgs += size;
			}
		}
		if (m.role === "system") {
			for (const section of Object.values(m.sections ?? {})) {
				if (section) addText(section);
			}
			if (m.toolsAdded) chars += JSON.stringify(m.toolsAdded).length;
		}
	}

	return { total: Math.ceil(chars / 4) + split.images * IMAGE_TOKENS, split };
}

function callBlockTokens(call: ToolCallBlock): number {
	return Math.ceil((call.name.length + JSON.stringify(call.arguments ?? {}).length) / 4);
}

interface MsgInfo {
	entryId: string;
	role: string;
	message: AnyMessage;
	turn: number;
	age: number;
	tokens: number;
	split: TokenSplit;
	digest: string;
	toolName?: string;
	toolCallId?: string;
	call?: ToolCallBlock;
	assistant?: MsgInfo;
	alreadyStubbed?: boolean;
	coherentOnly?: boolean;
}

interface Reclaimable {
	superseded: MsgInfo[];
	stale: MsgInfo[];
	thinking: MsgInfo[];
	args: { entryId: string; callIds: string[]; tokens: number }[];
	episodes: { result: MsgInfo; assistant: MsgInfo; callTokens: number }[];
	total: number;
}

interface Anchor {
	usage: NonNullable<AnyMessage["usage"]>;
	infoIndex: number;
	tokens: number;
}

interface Analysis {
	infos: MsgInfo[];
	currentTurn: number;
	protectTurns: number;
	staleMinAge: number;
	anchor: Anchor | null;
	estTotal: number;
	total: number;
	reclaimable: Reclaimable;
	compactions: { tokensBefore: number; summaryTokens: number; firstKeptEntryId: string }[];
}

function truncate(s: string, n: number): string {
	const one = s.split("\n")[0];
	return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function isStubbedResultContent(content: unknown): boolean {
	const text = Array.isArray(content) ? String((content[0] as { text?: string })?.text ?? "") : String(content ?? "");
	return text.startsWith("[") && text.includes(STUB_MARKER);
}

function digestFor(m: AnyMessage, call?: ToolCallBlock): string {
	if (m.role === "toolResult" && call) {
		const args = call.arguments ?? {};
		if (typeof args.path === "string") return args.path;
		if (typeof args.command === "string") return args.command;
		return truncate(JSON.stringify(args), 48);
	}
	if (m.role === "assistant") {
		const calls = blocks(m).filter(isToolCall);
		const text = blocks(m).find((b) => b.type === "text") as TextBlock | undefined;
		if (text?.text) return truncate(text.text, 48);
		if (calls.length > 0) return `(calls: ${calls.map((c) => c.name).join(", ")})`;
		return "";
	}
	if (m.role === "compactionSummary" || m.role === "branchSummary") return truncate(m.summary ?? "", 48);
	const text = blocks(m).find((b) => b.type === "text") as TextBlock | undefined;
	return text ? truncate(text.text, 48) : "";
}

function hasValidUsage(m: AnyMessage): boolean {
	if (m.role !== "assistant" || m.stopReason === "aborted" || m.stopReason === "error") return false;
	const usage = m.usage;
	if (!usage) return false;
	const sum = (usage.totalTokens ?? 0) || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	return sum > 0;
}

export function buildAnalysis(projection: Projection, opts: { protectTurns?: number } = {}): Analysis {
	const protectTurns = opts.protectTurns ?? DEFAULT_PROTECT_TURNS;
	const staleMinAge = protectTurns + 1;
	const infos: MsgInfo[] = [];
	const callIndex = new Map<string, { block: ToolCallBlock; assistant: MsgInfo }>();
	const resultByCall = new Map<string, MsgInfo>();
	let turn = 0;

	for (const pe of projection.entries) {
		// Summaries and custom messages also open a turn, matching pi's compaction accounting.
		if (pe.messages.some((m) => m.role === "user" || m.role === "compactionSummary" || m.role === "branchSummary" || m.role === "custom")) turn++;
		for (const m of pe.messages) {
			const { total, split } = splitMessage(m);
			const info: MsgInfo = {
				entryId: pe.sourceEntry.id,
				role: m.role,
				message: m,
				turn,
				age: 0,
				tokens: total,
				split,
				digest: "",
				toolName: m.role === "toolResult" ? m.toolName : undefined,
				toolCallId: m.role === "toolResult" ? m.toolCallId : undefined,
			};

			if (m.role === "assistant") {
				for (const block of blocks(m)) {
					if (isToolCall(block)) callIndex.set(block.id, { block, assistant: info });
				}
			} else if (m.role === "toolResult" && m.toolCallId) {
				const call = callIndex.get(m.toolCallId);
				info.call = call?.block;
				info.assistant = call?.assistant;
				info.alreadyStubbed = isStubbedResultContent(m.content);
				resultByCall.set(m.toolCallId, info);
			}

			info.digest = digestFor(m, info.call);
			infos.push(info);
		}
	}

	const currentTurn = turn;
	for (const info of infos) info.age = currentTurn - info.turn;

	const anchorIndex = infos.findLastIndex((info) => hasValidUsage(info.message));
	const anchorUsage = anchorIndex >= 0 ? infos[anchorIndex].message.usage! : null;
	const anchor: Anchor | null = anchorUsage
		? {
			usage: anchorUsage,
			infoIndex: anchorIndex,
			tokens: anchorUsage.totalTokens || (anchorUsage.input ?? 0) + (anchorUsage.output ?? 0) + (anchorUsage.cacheRead ?? 0) + (anchorUsage.cacheWrite ?? 0),
		}
		: null;

	const estTotal = infos.reduce((s, i) => s + i.tokens, 0);
	const total = anchor
		? anchor.tokens + infos.slice(anchor.infoIndex + 1).reduce((s, i) => s + i.tokens, 0)
		: estTotal;
	const reclaimable: Reclaimable = { superseded: [], stale: [], thinking: [], args: [], episodes: [], total: 0 };

	const readsByPath = new Map<string, MsgInfo[]>();
	for (const info of infos) {
		if (info.role !== "toolResult" || info.toolName !== "read") continue;
		const path = typeof info.call?.arguments?.path === "string" ? info.call.arguments.path : "";
		if (!path) continue;
		const list = readsByPath.get(path) ?? [];
		list.push(info);
		readsByPath.set(path, list);
	}
	for (const list of readsByPath.values()) {
		for (const info of list.slice(0, -1)) {
			if (info.tokens >= SUPERSEDED_MIN_TOKENS) reclaimable.superseded.push(info);
		}
	}

	const supersededIds = new Set(reclaimable.superseded.map((i) => i.entryId));
	for (const info of infos) {
		if (info.role !== "toolResult" || !info.toolName || !STALE_TOOLS.has(info.toolName)) continue;
		if (info.age < staleMinAge || info.tokens < STALE_MIN_TOKENS) continue;
		if (supersededIds.has(info.entryId)) continue;
		reclaimable.stale.push(info);
	}

	const stubbedIds = new Set([...reclaimable.superseded, ...reclaimable.stale].map((i) => i.entryId));
	for (const info of infos) {
		if (info.role !== "toolResult" || !info.toolName) continue;
		if (info.age < staleMinAge || stubbedIds.has(info.entryId)) continue;
		if (info.alreadyStubbed || info.tokens >= STALE_MIN_TOKENS) continue;
		if (!info.assistant || info.assistant.age < staleMinAge) continue;
		reclaimable.episodes.push({
			result: info,
			assistant: info.assistant,
			callTokens: info.call ? callBlockTokens(info.call) : 0,
		});
	}

	const newestAssistantIndex = infos.findLastIndex((info) => info.role === "assistant");
	const prunedToolEntryIds = new Set([
		...stubbedIds,
		...reclaimable.episodes.map((e) => e.result.entryId),
	]);

	for (let i = 0; i < infos.length; i++) {
		const info = infos[i];
		if (info.role !== "assistant" || i === newestAssistantIndex) continue;
		if (info.split.thinking / 4 < THINK_MIN_TOKENS) continue;
		if (info.age < staleMinAge) {
			// Thinking whose referents are pruned is eligible at any age.
			const hasPrunedReferent = blocks(info.message)
				.filter(isToolCall)
				.some((call) => {
					const result = resultByCall.get(call.id);
					return result !== undefined && prunedToolEntryIds.has(result.entryId);
				});
			if (!hasPrunedReferent) continue;
			info.coherentOnly = true;
		}
		reclaimable.thinking.push(info);
	}

	const argsByEntry = new Map<string, { entryId: string; callIds: string[]; tokens: number }>();
	const episodeCallIds = new Set(reclaimable.episodes.map((e) => e.result.toolCallId).filter(Boolean) as string[]);
	for (const info of infos) {
		if (info.role !== "assistant" || info.age < staleMinAge) continue;
		let tokens = 0;
		const callIds: string[] = [];
		for (const call of blocks(info.message).filter(isToolCall)) {
			if (episodeCallIds.has(call.id)) continue;
			const size = callBlockTokens(call);
			if (size < ARGS_MIN_TOKENS) continue;
			callIds.push(call.id);
			tokens += size;
		}
		if (callIds.length === 0 || tokens < ARGS_MIN_TOKENS) continue;
		const existing = argsByEntry.get(info.entryId);
		if (existing) {
			existing.callIds.push(...callIds);
			existing.tokens += tokens;
		} else {
			argsByEntry.set(info.entryId, { entryId: info.entryId, callIds, tokens });
		}
	}
	reclaimable.args = [...argsByEntry.values()];

	reclaimable.total =
		reclaimable.superseded.reduce((s, i) => s + i.tokens, 0) +
		reclaimable.stale.reduce((s, i) => s + i.tokens, 0) +
		reclaimable.thinking.reduce((s, i) => s + i.split.thinking / 4, 0) +
		reclaimable.args.reduce((s, a) => s + a.tokens, 0) +
		reclaimable.episodes.reduce((s, e) => s + e.callTokens + e.result.tokens, 0);

	const compactions: Analysis["compactions"] = [];
	for (const pe of projection.entries) {
		if (pe.sourceEntry.type !== "compaction") continue;
		const summary = pe.messages.find((m) => m.role === "compactionSummary");
		compactions.push({
			tokensBefore: (pe.sourceEntry as unknown as { tokensBefore?: number }).tokensBefore ?? 0,
			summaryTokens: summary ? splitMessage(summary).total : 0,
			firstKeptEntryId: (pe.sourceEntry as unknown as { firstKeptEntryId?: string }).firstKeptEntryId ?? "",
		});
	}

	return { infos, currentTurn, protectTurns, staleMinAge, anchor, estTotal, total, reclaimable, compactions };
}

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");
const pct = (n: number, of: number): string => (of > 0 ? `${Math.round((n / of) * 100)}%` : "0%");
const sum = (xs: { tokens: number }[]): number => xs.reduce((s, x) => s + x.tokens, 0);

function formatPruneStats(stats: PruneStats, prefix = "lifetime"): string | null {
	if (stats.batches === 0) return null;
	const split = stats.auto > 0 ? ` (${stats.manual > 0 ? `${stats.manual} manual, ` : ""}${stats.auto} auto)` : "";
	return `${prefix}: ~${fmt(stats.netTokens)} tok pruned across ${stats.batches} batch${stats.batches === 1 ? "" : "es"}${split}`;
}

function formatConfigLine(config: PruneConfig, path: string): string {
	const auto = config.autoPrune;
	let autoText = "off";
	if (auto) {
		const parts: string[] = [];
		if (auto.contextPercent !== undefined) parts.push(`ctx≥${auto.contextPercent}%`);
		if (auto.reclaimablePercent !== undefined) parts.push(`reclaim≥${auto.reclaimablePercent}%`);
		if (auto.idleMinutes !== undefined) parts.push(`idle≥${auto.idleMinutes}m`);
		parts.push(`min ${fmt(auto.minReclaimableTokens)} tok`, `cooldown ${auto.cooldownMinutes}m`);
		autoText = parts.join(" · ");
	}
	const alertText = config.alertPercent === undefined ? "off" : `${config.alertPercent}%`;
	return `auto-prune: ${autoText} · alert: ${alertText} · config: ${path}`;
}

function bar(tokens: number, max: number, width = 30): string {
	const filled = max > 0 ? Math.max(tokens > 0 ? 1 : 0, Math.round((tokens / max) * width)) : 0;
	return "█".repeat(Math.min(filled, width)) + "░".repeat(Math.max(0, width - filled));
}

function ageLabel(info: MsgInfo): string {
	if (info.age === 0) return "cur";
	return `${info.age}t`;
}

export interface PruneCategoryRow { label: string; count: number; tokens: number; note: string }

export function planCategoryRows(plan: PrunePlan): PruneCategoryRow[] {
	const edits = plan.edits;
	const stubs = edits.filter((e) => e.kind === "tool-stub");
	const superseded = stubs.filter((e) => e.superseded === true);
	const stale = stubs.filter((e) => e.superseded !== true);
	const thinking = edits.filter((e) => e.kind === "thinking-strip" || e.kind === "thinking+args" || e.kind === "thinking+drop");
	const args = edits.filter((e) => e.kind === "args-clear" || e.kind === "thinking+args" || (e.kind === "thinking+drop" && e.argsTokens !== undefined));
	const thinkingTokens = thinking.reduce((s, e) => s + (e.kind === "thinking-strip" ? e.tokens : e.thinkingTokens ?? 0), 0);
	const argsTokens = args.reduce((s, e) => s + (e.argsTokens ?? e.tokens), 0);
	const episodeResults = edits.filter((e) => e.kind === "result-drop");
	const episodeCalls = edits.filter((e) => e.episodeTokens !== undefined);
	const rows: PruneCategoryRow[] = [];
	if (superseded.length > 0) rows.push({ label: "superseded reads", count: superseded.length, tokens: sum(superseded), note: "re-read later; any age" });
	if (stale.length > 0) rows.push({ label: "stale read/bash", count: stale.length, tokens: sum(stale), note: `age ≥ ${plan.staleMinAge}t, ≥ ${STALE_MIN_TOKENS} tok each` });
	if (thinking.length > 0) rows.push({ label: "assistant thinking", count: thinking.length, tokens: thinkingTokens, note: `age ≥ ${plan.staleMinAge}t or referent pruned` });
	if (args.length > 0) rows.push({ label: "tool call args", count: args.length, tokens: argsTokens, note: `age ≥ ${plan.staleMinAge}t, ≥ ${ARGS_MIN_TOKENS} tok per call` });
	const episodeTokens = sum(episodeResults) + episodeCalls.reduce((s, e) => s + (e.episodeTokens ?? 0), 0);
	if (episodeResults.length > 0 || episodeCalls.length > 0) {
		rows.push({ label: "small episodes", count: episodeResults.length, tokens: episodeTokens, note: `age ≥ ${plan.staleMinAge}t, < ${STALE_MIN_TOKENS} tok, dropped whole` });
	}
	return rows;
}

function prunePreviewLines(plan: PrunePlan, total: number, coherenceNote: string): string[] {
	const lines = planCategoryRows(plan).map((row) =>
		`  ${row.label.padEnd(18)} ${String(row.count).padStart(3)} msgs ${fmt(row.tokens).padStart(9)} tok  (${row.note})`);
	if (coherenceNote) lines.push(`                       ↳ ${coherenceNote}`);
	lines.push(`  prunable total              ${fmt(plan.netTokens).padStart(9)} tok  (${pct(plan.netTokens, total)} of context)`);
	return lines;
}

function categoryLines(a: Analysis): string[] {
	interface Category { label: string; tokens: number; protectedTokens: number }
	const categories = new Map<string, Category>();
	const slot = (label: string): Category => {
		let category = categories.get(label);
		if (!category) {
			category = { label, tokens: 0, protectedTokens: 0 };
			categories.set(label, category);
		}
		return category;
	};
	for (const label of [
		"system prompt", "user messages", "assistant text", "assistant thinking", "tool call args",
		"read results", "bash results", "edit results", "write results", "other tools",
		"compaction summaries", "other",
	]) slot(label);

	const toolCategory = (name: string | undefined): string =>
		name === "read" || name === "bash" || name === "edit" || name === "write" ? `${name} results` : "other tools";

	for (const info of a.infos) {
		const young = info.age <= a.protectTurns;
		const add = (label: string, tokens: number) => {
			const category = slot(label);
			category.tokens += tokens;
			if (young) category.protectedTokens += tokens;
		};

		if (info.role === "system") {
			add("system prompt", info.tokens);
		} else if (info.role === "user") {
			add("user messages", info.tokens);
		} else if (info.role === "compactionSummary" || info.role === "branchSummary") {
			add("compaction summaries", info.tokens);
		} else if (info.role === "assistant") {
			add("assistant text", Math.ceil(info.split.text / 4));
			add("assistant thinking", Math.ceil(info.split.thinking / 4));
			add("tool call args", Math.ceil(info.split.toolArgs / 4));
			add("other", info.split.images * IMAGE_TOKENS);
		} else if (info.role === "toolResult") {
			add(toolCategory(info.toolName), info.tokens);
		} else {
			add("other", info.tokens);
		}
	}

	const cats = [...categories.values()].filter((category) => category.tokens > 0);
	const maxCat = Math.max(...cats.map((category) => category.tokens), 1);
	const catRow = (category: Category) => {
		const protectedText = category.protectedTokens > 0 ? ` (${fmt(category.protectedTokens)} in window)` : "";
		return `  ${category.label.padEnd(20)} ${bar(category.tokens, maxCat)} ${fmt(category.tokens).padStart(9)} ${pct(category.tokens, a.estTotal).padStart(4)}${protectedText}`;
	};
	return ["", "where it goes (est)", ...cats.map(catRow)];
}

function reclaimableLines(a: Analysis, plan: PrunePlan, full: boolean): string[] {
	const reclaimable = a.reclaimable;
	const lines = ["", `reclaimable preview (policy: protect ${a.protectTurns} turns)`];
	if (plan.edits.length === 0) {
		lines.push("  nothing eligible — context is lean under current policy");
		return lines;
	}

	lines.push(...prunePreviewLines(plan, a.total, plan.coherenceNote));
	if (full) {
		const planned = new Set(plan.edits.map((edit) => edit.targetId));
		const item = (label: string, info: MsgInfo, tokens: number) =>
			lines.push(`      ${info.entryId}  ${label.padEnd(12)} ${ageLabel(info).padStart(4)} ${fmt(tokens).padStart(9)} tok`);
		const tools = [...reclaimable.superseded, ...reclaimable.stale].filter((info) => planned.has(info.entryId));
		for (const info of tools.slice(0, 10)) item(info.toolName ?? "?", info, info.tokens);
		for (const info of reclaimable.thinking.filter((info) => planned.has(info.entryId)).slice(0, 10)) {
			item("assistant", info, Math.round(info.split.thinking / 4));
		}
		for (const args of reclaimable.args.filter((args) => planned.has(args.entryId)).slice(0, 10)) {
			lines.push(`      ${args.entryId}  ${"args".padEnd(12)} ${"-".padStart(4)} ${fmt(args.tokens).padStart(9)} tok`);
		}
	}
	return lines;
}

function cacheLines(a: Analysis): string[] {
	if (!a.anchor) return [];
	const usage = a.anchor.usage;
	const input = usage.input ?? 0;
	const read = usage.cacheRead ?? 0;
	const write = usage.cacheWrite ?? 0;
	const hit = input + read > 0 ? `${Math.round((read / (input + read)) * 100)}%` : "n/a";
	return [
		"",
		"cache economics (last billed request)",
		`  input ${fmt(input)} · cacheRead ${fmt(read)} · cacheWrite ${fmt(write)}${usage.cacheWrite1h ? ` (1h: ${fmt(usage.cacheWrite1h)})` : ""} · output ${fmt(usage.output ?? 0)}${typeof usage.reasoning === "number" ? ` · reasoning ${fmt(usage.reasoning)}` : ""}`,
		`  prefix cache hit ${hit} · cost ${usage.cost?.total != null ? `$${usage.cost.total.toFixed(4)}` : "n/a"}`,
	];
}

function recencyLines(a: Analysis): string[] {
	const band = (minAge: number, maxAge: number) =>
		a.infos.filter((i) => i.age >= minAge && (maxAge === Infinity || i.age <= maxAge)).reduce((s, i) => s + i.tokens, 0);
	const recent = band(0, a.protectTurns);
	const middle = band(a.protectTurns + 1, 9);
	const old = band(10, Infinity);
	return [
		"",
		"recency bands",
		`  ages 0-${a.protectTurns}t (protected)  ${fmt(recent).padStart(9)} tok ${pct(recent, a.estTotal).padStart(4)}`,
		`  ages ${a.protectTurns + 1}-9t           ${fmt(middle).padStart(9)} tok ${pct(middle, a.estTotal).padStart(4)}`,
		`  ages 10t+             ${fmt(old).padStart(9)} tok ${pct(old, a.estTotal).padStart(4)}`,
	];
}

function compactionLines(a: Analysis): string[] {
	const lines = ["", `compaction state (${a.compactions.length} on branch)`];
	if (a.compactions.length === 0) {
		lines.push("  never compacted");
		return lines;
	}
	const last = a.compactions[a.compactions.length - 1];
	lines.push(`  last: tokensBefore ${fmt(last.tokensBefore)} · summary est ${fmt(last.summaryTokens)} tok · kept from ${last.firstKeptEntryId || "?"}`);
	return lines;
}

export function formatReport(a: Analysis, opts: { full?: boolean; window?: number; reserveTokens?: number; model?: string; plan: PrunePlan; config?: PruneConfig; configPath?: string; stats?: PruneStats }): string[] {
	const lines: string[] = [];
	const short = !opts.full;
	const window = opts.window ?? 0;
	const reserve = opts.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const head = short ? "ctx" : "ctx (full)";
	const who = opts.model ? ` \u00b7 ${opts.model}` : "";

	if (window > 0) {
		lines.push(`${head}${who}  ${fmt(a.total)} / ${fmt(window)} tok (${pct(a.total, window)}) \u00b7 turn ${a.currentTurn} \u00b7 auto-compact \u2248 ${fmt(window - reserve)}`);
	} else {
		lines.push(`${head}${who}  ${fmt(a.total)} tok \u00b7 turn ${a.currentTurn}`);
	}

	lines.push(...categoryLines(a));
	lines.push(...reclaimableLines(a, opts.plan, !short));
	if (!short) lines.push("  note: thinking counted at local bytes; billed cost may differ (opaque reasoning payloads)");

	if (!short) {
		lines.push(...cacheLines(a));
		lines.push(...recencyLines(a));
		lines.push(...compactionLines(a));
		const history = opts.stats ? formatPruneStats(opts.stats, "prune history") : null;
		if (history) lines.push(history);
		if (opts.config) lines.push(formatConfigLine(opts.config, opts.configPath ?? ""));
	}

	return lines;
}

export interface PruneEdit {
	targetId: string;
	kind: "tool-stub" | "thinking-strip" | "args-clear" | "thinking+args" | "assistant-call-drop" | "result-drop" | "thinking+drop";
	tokens: number;
	thinkingTokens?: number;
	argsTokens?: number;
	episodeTokens?: number;
	original: unknown;
	replacement: { content: string | unknown[] } | null; // null removes the entry from context
	superseded?: boolean;
}

export interface PrunePlan {
	edits: PruneEdit[];
	summaryLines: string[];
	coherenceNote: string;
	grossTokens: number;
	netTokens: number;
	staleMinAge: number;
}

export type RawContentGetter = (targetId: string) => unknown;
export type ProjectedContentGetter = (targetId: string) => unknown;

function clearedArgsContent(raw: unknown[], callIds: Set<string>, entryId: string): { content: unknown[]; cleared: number } {
	let cleared = 0;
	const content = raw.map((block) => {
		if (!isToolCall(block) || !callIds.has(block.id ?? "")) return block;
		const tokens = callBlockTokens(block);
		if (tokens < ARGS_MIN_TOKENS) return block;
		cleared++;
		return { ...block, arguments: { pi_prune_elided: `args pruned by /prune (was ~${tokens} tok) · id ${entryId}` } };
	});
	return { content, cleared };
}

function stubText(info: MsgInfo): string {
	const tokens = Math.round(info.tokens);
	const digest = info.digest.replace(/\s+/g, " ");
	const short = digest.length > 120 ? `${digest.slice(0, 120)}...` : digest;
	if (info.toolName === "bash") {
		return `[bash '${short}' ${STUB_MARKER} · id ${info.entryId} (turn ${info.turn}, ~${tokens} tok). Use prune_recall with this id for the original output.]`;
	}
	return `[${info.toolName ?? "tool"} ${short} ${STUB_MARKER} · id ${info.entryId} (turn ${info.turn}, ~${tokens} tok). Use prune_recall with this id for the original output.]`;
}

export function buildPrunePlan(analysis: Analysis, getRawContent: RawContentGetter, getProjectedContent: ProjectedContentGetter): PrunePlan {
	const reclaimable = analysis.reclaimable;
	const byTarget = new Map<string, PruneEdit>();

	const addToolStub = (list: MsgInfo[], superseded: boolean) => {
		for (const info of list) {
			if (byTarget.has(info.entryId)) continue;
			const raw = getRawContent(info.entryId);
			if (raw === undefined) continue;
			const projected = getProjectedContent(info.entryId);
			if (typeof projected === "string" && projected.includes(STUB_MARKER)) continue;
			byTarget.set(info.entryId, {
				targetId: info.entryId,
				kind: "tool-stub",
				tokens: info.tokens,
				original: raw,
				replacement: { content: stubText(info) },
				superseded,
			});
		}
	};

	// Replacements come from projected content, never raw, or earlier prune batches are resurrected.
	const baseContent = (id: string): unknown[] => {
		const projected = getProjectedContent(id);
		if (Array.isArray(projected)) return projected;
		const raw = getRawContent(id);
		return Array.isArray(raw) ? raw : [];
	};

	const addThinking = (): number => {
		let coherenceCount = 0;
		for (const info of reclaimable.thinking) {
			if (byTarget.has(info.entryId)) continue;
			const base = baseContent(info.entryId);
			if (base.length === 0) continue;
			const stripped = base.filter((block) => (block as { type?: string }).type !== "thinking");
			if (stripped.length === base.length) continue;
			if (info.coherentOnly) coherenceCount++;
			const thinkingTokens = Math.round(info.split.thinking / 4);
			byTarget.set(info.entryId, {
				targetId: info.entryId,
				kind: "thinking-strip",
				tokens: thinkingTokens,
				thinkingTokens,
				original: getRawContent(info.entryId),
				replacement: { content: stripped },
			});
		}
		return coherenceCount;
	};

	const addArgs = (): number => {
		let argsOverhead = 0;
		for (const args of reclaimable.args) {
			const existing = byTarget.get(args.entryId);
			if (existing?.replacement === null) continue;
			const source = existing ? existing.replacement.content as unknown[] : baseContent(args.entryId);
			if (source.length === 0) continue;
			const { content, cleared } = clearedArgsContent(source, new Set(args.callIds), args.entryId);
			if (cleared === 0) continue;
			argsOverhead += cleared * ARGS_OVERHEAD_TOKENS;
			if (existing) {
				existing.replacement = { content };
				if (existing.kind === "thinking-strip") {
					existing.kind = "thinking+args";
					existing.thinkingTokens = existing.tokens;
				}
				existing.argsTokens = (existing.argsTokens ?? 0) + args.tokens;
				existing.tokens += args.tokens;
			} else {
				byTarget.set(args.entryId, {
					targetId: args.entryId,
					kind: "args-clear",
					tokens: args.tokens,
					argsTokens: args.tokens,
					original: getRawContent(args.entryId),
					replacement: { content },
				});
			}
		}
		return argsOverhead;
	};

	// A result must never be dropped without its call block.
	const addEpisodes = (): void => {
		for (const episode of reclaimable.episodes) {
			const resultOriginal = getRawContent(episode.result.entryId);
			const callId = episode.result.toolCallId;
			if (resultOriginal === undefined || !callId) continue;

			const existing = byTarget.get(episode.assistant.entryId);
			if (!existing || existing.replacement !== null) {
				const source = existing ? existing.replacement.content as unknown[] : baseContent(episode.assistant.entryId);
				const paired = source.find((block) => isToolCall(block) && block.id === callId) as ToolCallBlock | undefined;
				if (!paired) continue;
				const callTokens = callBlockTokens(paired);
				const merged = source.filter((block) => !(isToolCall(block) && block.id === callId));

				if (existing) {
					if (merged.length === 0) {
						existing.replacement = null;
						existing.kind = "assistant-call-drop";
						existing.tokens = episode.assistant.tokens;
						existing.episodeTokens = episode.assistant.tokens;
					} else {
						existing.replacement = { content: merged };
						if (existing.kind === "thinking-strip") existing.kind = "thinking+drop";
						existing.tokens += callTokens;
						existing.episodeTokens = (existing.episodeTokens ?? 0) + callTokens;
					}
				} else {
					const tokens = merged.length === 0 ? episode.assistant.tokens : callTokens;
					byTarget.set(episode.assistant.entryId, {
						targetId: episode.assistant.entryId,
						kind: "assistant-call-drop",
						tokens,
						episodeTokens: tokens,
						original: getRawContent(episode.assistant.entryId),
						replacement: merged.length === 0 ? null : { content: merged },
					});
				}
			}

			byTarget.set(episode.result.entryId, {
				targetId: episode.result.entryId,
				kind: "result-drop",
				tokens: episode.result.tokens,
				original: resultOriginal,
				replacement: null,
			});
		}
	};

	addToolStub(reclaimable.superseded, true);
	addToolStub(reclaimable.stale, false);
	const coherenceCount = addThinking();
	const argsOverhead = addArgs();
	addEpisodes();

	const edits = [...byTarget.values()];
	const grossTokens = edits.reduce((s, e) => s + e.tokens, 0);
	const stubOverhead = edits.filter((e) => e.kind === "tool-stub").length * STUB_OVERHEAD_TOKENS;
	const netTokens = grossTokens - stubOverhead - argsOverhead;
	const coherenceNote = coherenceCount > 0 ? `${coherenceCount} via referent-pruned` : "";
	const plan: PrunePlan = {
		edits,
		summaryLines: [],
		coherenceNote,
		grossTokens,
		netTokens,
		staleMinAge: analysis.staleMinAge,
	};
	plan.summaryLines = [
		`policy: ${plan.staleMinAge}-turn window on everything · absolute axe on superseded reads`,
		...prunePreviewLines(plan, grossTokens, coherenceNote).slice(0, -1),
		`~${fmt(netTokens)} tok pruned`,
	];
	return plan;
}

export interface MutableSessionManager {
	getEntry(id: string): { message: { content?: unknown } } | undefined;
	appendContextEdit(targetId: string, replacement: { content: unknown } | null): string;
	appendCustomEntry(customType: string, data?: unknown): string;
	getBranch(): { id: string; type: string; customType?: string; data?: unknown }[];
}

const PRUNE_RECORD = "pi-prune-record";
const UNPRUNE_MARKER = "pi-prune-unprune-marker";

export type PruneTrigger = "manual" | AutoTrigger;

export interface PruneRecordData {
	v: number;
	createdAt: string;
	trigger: PruneTrigger;
	grossTokens: number;
	netTokens: number;
	edits: { targetId: string; kind: string; tokens: number; original: unknown }[];
}

export function buildPruneRecord(plan: PrunePlan, trigger: PruneTrigger): PruneRecordData {
	return {
		v: 2,
		createdAt: new Date().toISOString(),
		trigger,
		grossTokens: plan.grossTokens,
		netTokens: plan.netTokens,
		edits: plan.edits.map((e) => ({ targetId: e.targetId, kind: e.kind, tokens: e.tokens, original: e.original })),
	};
}

export function planToDrafts(plan: PrunePlan, trigger: PruneTrigger): SessionBoundaryDraft[] {
	return [
		{ type: "custom", customType: PRUNE_RECORD, data: buildPruneRecord(plan, trigger) },
		...plan.edits.map((e) => ({
			type: "context_edit" as const,
			targetId: e.targetId,
			replacement: e.replacement as ContextEditEntryDraft["replacement"],
		})),
	];
}

function applyContextEdits(
	manager: MutableSessionManager,
	edits: { targetId: string; replacement: { content: unknown } | null }[],
): { applied: number; failed: number; errors: string[] } {
	let applied = 0;
	const errors: string[] = [];
	for (const edit of edits) {
		try {
			manager.appendContextEdit(edit.targetId, edit.replacement);
			applied++;
		} catch (error) {
			errors.push(`${edit.targetId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { applied, failed: errors.length, errors };
}

export function applyPrunePlan(manager: MutableSessionManager, plan: PrunePlan, trigger: PruneTrigger = "manual"): { applied: number; failed: number; recordId: string; errors: string[] } {
	const recordId = manager.appendCustomEntry(PRUNE_RECORD, buildPruneRecord(plan, trigger));
	const result = applyContextEdits(manager, plan.edits);
	return { ...result, recordId };
}

export interface PruneStats { batches: number; manual: number; auto: number; netTokens: number }

function undoneRecordIds(branch: { type: string; customType?: string; data?: unknown }[]): Set<string> {
	const undone = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== UNPRUNE_MARKER) continue;
		const recordId = (entry.data as { recordId?: string } | undefined)?.recordId;
		if (recordId) undone.add(recordId);
	}
	return undone;
}

export function collectPruneStats(branch: { id: string; type: string; customType?: string; data?: unknown }[]): PruneStats {
	const undone = undoneRecordIds(branch);
	const stats: PruneStats = { batches: 0, manual: 0, auto: 0, netTokens: 0 };
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== PRUNE_RECORD || undone.has(entry.id)) continue;
		const data = entry.data as Partial<PruneRecordData> | undefined;
		if (typeof data?.netTokens !== "number") continue;
		stats.batches++;
		stats.netTokens += data.netTokens;
		if (data.trigger === "manual" || data.trigger === undefined) stats.manual++;
		else stats.auto++;
	}
	return stats;
}

export interface PruneOriginal {
	kind: string;
	tokens: number;
	original: unknown;
}

export function collectPruneOriginals(branch: { id: string; type: string; customType?: string; data?: unknown }[]): Map<string, PruneOriginal> {
	const undone = undoneRecordIds(branch);
	const originals = new Map<string, PruneOriginal>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== PRUNE_RECORD || undone.has(entry.id)) continue;
		const data = entry.data as Partial<PruneRecordData> | undefined;
		if (!Array.isArray(data?.edits)) continue;
		for (const edit of data.edits) {
			if (!edit || typeof edit.targetId !== "string") continue;
			originals.set(edit.targetId, {
				kind: typeof edit.kind === "string" ? edit.kind : "edit",
				tokens: typeof edit.tokens === "number" ? edit.tokens : 0,
				original: edit.original,
			});
		}
	}
	return originals;
}

function renderOriginal(original: unknown): string {
	if (typeof original === "string") return original;
	if (Array.isArray(original)) {
		const parts: string[] = [];
		for (const raw of original) {
			const block = raw as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
			if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
			else if (block?.type === "thinking" && typeof block.thinking === "string") parts.push(`[thinking]\n${block.thinking}`);
			else if (block?.type === "toolCall") parts.push(`[toolCall ${block.name ?? "?"}] ${JSON.stringify(block.arguments ?? {})}`);
		}
		return parts.length > 0 ? parts.join("\n\n") : JSON.stringify(original, null, 2);
	}
	return original !== null && typeof original === "object" ? JSON.stringify(original, null, 2) : String(original ?? "");
}

export function withPendingBatch(stats: PruneStats, netTokens: number, trigger: PruneTrigger): PruneStats {
	return {
		batches: stats.batches + 1,
		manual: stats.manual + (trigger === "manual" ? 1 : 0),
		auto: stats.auto + (trigger === "manual" ? 0 : 1),
		netTokens: stats.netTokens + netTokens,
	};
}

export function findLatestPruneRecord(branch: { id: string; type: string; customType?: string; data?: unknown }[]): { id: string; data: { edits?: { targetId: string; original: unknown }[] } } | null {
	const undone = undoneRecordIds(branch);
	const latest = branch.findLast((entry) => entry.type === "custom" && entry.customType === PRUNE_RECORD && !undone.has(entry.id));
	return (latest as { id: string; data: { edits?: { targetId: string; original: unknown }[] } } | undefined) ?? null;
}

export function applyUnprune(manager: MutableSessionManager, record: { id: string; data?: { edits?: { targetId: string; original: unknown }[] } }): { restored: number; failed: number; errors: string[] } {
	const edits = (record.data?.edits ?? []).map((edit) => ({
		targetId: edit.targetId,
		replacement: { content: edit.original },
	}));
	const result = applyContextEdits(manager, edits);
	manager.appendCustomEntry(UNPRUNE_MARKER, { recordId: record.id, restored: result.applied, failed: result.failed });
	return { restored: result.applied, failed: result.failed, errors: result.errors };
}

type Timer = ReturnType<typeof setTimeout> & { unref?: () => void };
const runtimeState = globalThis as typeof globalThis & { __piPruneIdleTimer?: Timer };

function clearIdleTimer(): void {
	const timer = runtimeState.__piPruneIdleTimer;
	if (!timer) return;
	clearTimeout(timer);
	runtimeState.__piPruneIdleTimer = undefined;
}

function showOverlay(lines: string[], ctx: ExtensionCommandContext): Promise<void> {
	return ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
		return {
			render(width: number): string[] {
				const out = lines.map((line) => (line.length > width ? line.slice(0, width) : line));
				out.push("── /ctx · any key closes".slice(0, width));
				return out;
			},
			handleInput(data: string): void {
				void data;
				done();
			},
			invalidate(): void {},
		};
	});
}

export default function (pi: ExtensionAPI) {
	const initial = loadConfig();
	let config = initial.config;
	let configPath = initial.path;
	let lastAutoPruneAt = 0;
	let alertLatched = false;

	clearIdleTimer();

	const rawContent = (sm: MutableSessionManager) => (targetId: string): unknown =>
		sm.getEntry(targetId)?.message?.content;

	const emit = (ctx: ExtensionContext, lines: string[], type: "info" | "warning" | "error" = "info") => {
		if (ctx.mode === "tui" || ctx.mode === "rpc") {
			ctx.ui.notify(lines.join("\n"), type);
		} else {
			console.error(lines.join("\n"));
		}
	};

	const appendErrors = (lines: string[], errors: string[]) => {
		for (const error of errors.slice(0, 3)) lines.push(`  error: ${error}`);
	};

	const windowOf = (ctx: ExtensionContext): number =>
		ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;

	const reserveOf = (): number =>
		(pi.getSettings() as { compaction?: { reserveTokens?: number } }).compaction?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;

	const collectPlan = (ctx: ExtensionContext) => {
		const projection = ctx.sessionManager.buildSessionProjection() as unknown as Projection;
		const sm = ctx.sessionManager as unknown as MutableSessionManager;
		const analysis = buildAnalysis(projection, { protectTurns: config.protectTurns });
		const projected = new Map((projection.entries as ProjectedEntry[]).map((pe) => [pe.sourceEntry.id, pe.messages?.[0]?.content]));
		const plan = buildPrunePlan(analysis, rawContent(sm), (id) => projected.get(id));
		return { analysis, plan, sm };
	};

	const triggerLabel = (trigger: AutoTrigger, analysis: Analysis, plan: PrunePlan, window: number): string => {
		if (trigger === "context") return `context ${pct(analysis.total, window)}`;
		if (trigger === "reclaimable") return `reclaimable ${pct(plan.netTokens, analysis.total)}`;
		return "idle";
	};

	const maybeAlert = (ctx: ExtensionContext, decision: TriggerDecision, window: number) => {
		if (!decision.alert) {
			alertLatched = false;
			return;
		}
		if (alertLatched) return;
		alertLatched = true;
		emit(ctx, [
			`pi-prune: context ~${Math.round(decision.effectivePercent)}% after max prune (${fmt(decision.effectiveTokens)} / ${fmt(window)} tok).`,
			"Pruning is exhausted. Use /compact or /new.",
		], "warning");
	};

	const decide = (ctx: ExtensionContext, idle: boolean) => {
		const { analysis, plan, sm } = collectPlan(ctx);
		const window = windowOf(ctx);
		const decision = evaluateTriggers({
			total: analysis.total,
			window,
			reserveTokens: reserveOf(),
			planNetTokens: plan.netTokens,
			config,
			now: Date.now(),
			lastAutoPruneAt,
			idle,
		});
		maybeAlert(ctx, decision, window);
		return { analysis, plan, sm, window, decision };
	};

	const autoPruneMessage = (
		trigger: AutoTrigger,
		analysis: Analysis,
		plan: PrunePlan,
		window: number,
		applied: number,
		stats: PruneStats,
		errors: string[],
	): string[] => {
		const lines = [`auto-prune (${triggerLabel(trigger, analysis, plan, window)}): ${applied} edits · ~${fmt(plan.netTokens)} tok pruned`];
		const lifetime = formatPruneStats(stats);
		if (lifetime) lines.push(lifetime);
		lines.push("undo: /unprune");
		appendErrors(lines, errors);
		return lines;
	};

	const runIdle = (ctx: ExtensionContext): void => {
		if (!config.autoPrune || !ctx.isIdle()) return;
		const { analysis, plan, sm, window, decision } = decide(ctx, true);
		if (!decision.auto || plan.edits.length === 0) return;
		const stats = withPendingBatch(collectPruneStats(sm.getBranch()), plan.netTokens, decision.auto);
		const result = applyPrunePlan(sm, plan, decision.auto);
		lastAutoPruneAt = Date.now();
		emit(ctx, autoPruneMessage(decision.auto, analysis, plan, window, result.applied, stats, result.errors));
	};

	const armIdleTimer = (ctx: ExtensionContext, delayMs?: number): void => {
		clearIdleTimer();
		const auto = config.autoPrune;
		if (!auto || auto.idleMinutes === undefined) return;
		const wait = delayMs ?? auto.idleMinutes * 60_000;
		const timer = setTimeout(() => {
			runtimeState.__piPruneIdleTimer = undefined;
			runIdle(ctx);
		}, Math.max(0, wait)) as Timer;
		timer.unref?.();
		runtimeState.__piPruneIdleTimer = timer;
	};

	const lastAssistantTime = (branch: { type: string; timestamp?: string; message?: { role?: string } }[]): number | null => {
		let latest = 0;
		for (const entry of branch) {
			if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.timestamp) continue;
			const timestamp = Date.parse(entry.timestamp);
			if (Number.isFinite(timestamp) && timestamp > latest) latest = timestamp;
		}
		return latest > 0 ? latest : null;
	};

	pi.on("session_start", (_event, ctx) => {
		const fresh = loadConfig(configPath);
		config = fresh.config;
		configPath = fresh.path;
		lastAutoPruneAt = 0;
		alertLatched = false;
		if (fresh.warnings.length > 0) {
			emit(ctx, fresh.warnings.map((warning) => `pi-prune config: ${warning}`), "warning");
		}
		const auto = config.autoPrune;
		if (!auto || auto.idleMinutes === undefined) return;
		const sm = ctx.sessionManager as unknown as MutableSessionManager;
		const last = lastAssistantTime(sm.getBranch());
		if (last === null) return;
		armIdleTimer(ctx, auto.idleMinutes * 60_000 - (Date.now() - last));
	});

	pi.on("session_compact", () => {
		alertLatched = false;
	});

	pi.on("agent_settled", (_event, ctx) => {
		armIdleTimer(ctx);
	});

	for (const event of ["agent_start", "session_before_switch", "session_before_fork", "session_shutdown"] as const) {
		pi.on(event, () => {
			clearIdleTimer();
		});
	}

	pi.on("turn_end", (event, ctx) => {
		if (event.outcome !== "completed") return;
		if (!config.autoPrune && config.alertPercent === undefined) return;
		const { analysis, plan, sm, window, decision } = decide(ctx, false);
		if (!decision.auto || plan.edits.length === 0) return;
		const stats = withPendingBatch(collectPruneStats(sm.getBranch()), plan.netTokens, decision.auto);
		lastAutoPruneAt = Date.now();
		emit(ctx, autoPruneMessage(decision.auto, analysis, plan, window, plan.edits.length, stats, []));
		return { entries: planToDrafts(plan, decision.auto) };
	});

	pi.registerTool({
		name: "prune_recall",
		label: "Recall Pruned Content",
		description: "Retrieve the original content of an entry pruned by /prune. Use the id shown in a prune stub or cleared-args marker. Tool output is the original from that turn and may be stale.",
		promptSnippet: "Retrieve original content for a pruned entry",
		promptGuidelines: [
			"When a prune stub or cleared-args marker shows an id and you need the original content, call prune_recall with that id instead of re-running the tool.",
		],
		parameters: Type.Object({
			ids: Type.Array(Type.String({ description: "Pruned entry id, such as 93a0d702" }), { description: "Entry ids to retrieve" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const branch = (ctx.sessionManager as unknown as { getBranch(): { id: string; type: string; customType?: string; data?: unknown }[] }).getBranch();
			const originals = collectPruneOriginals(branch);
			const blocks: string[] = [];
			for (const id of params.ids) {
				const hit = originals.get(id);
				if (!hit) {
					blocks.push(`## id: ${id}\n(not a pruned entry on this branch)`);
					continue;
				}
				const truncated = truncateHead(renderOriginal(hit.original), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				let body = truncated.content;
				if (truncated.truncated) body += `\n[Output truncated: ${truncated.outputLines}/${truncated.totalLines} lines shown]`;
				const snapshot = hit.kind === "tool-stub" ? "\n(original tool output from that turn, the source may have changed since)\n" : "";
				blocks.push(`## id: ${id} · ${hit.kind} · ~${fmt(hit.tokens)} tok${snapshot}\n${body}`);
			}
			return {
				content: [{ type: "text" as const, text: blocks.join("\n\n---\n\n") }],
				details: { ids: params.ids },
			};
		},
	});

	pi.registerCommand("ctx", {
		description: "Analyze context window: one-page token breakdown and reclaimable preview",
		handler: async (args, ctx) => {
			const full = args.trim() === "full";
			const projection = ctx.sessionManager.buildSessionProjection() as unknown as Projection;
			if (projection.entries.length === 0) {
				ctx.ui.notify("ctx: empty session", "info");
				return;
			}
			const { analysis, plan, sm } = collectPlan(ctx);
			const lines = formatReport(analysis, {
				full,
				plan,
				window: windowOf(ctx),
				reserveTokens: reserveOf(),
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				config,
				configPath,
				stats: collectPruneStats(sm.getBranch()),
			});
			if (ctx.mode === "tui") {
				await showOverlay(lines, ctx);
			} else if (ctx.mode === "rpc") {
				ctx.ui.notify(lines.slice(0, 14).join("\n"), "info");
			} else {
				console.error(lines.join("\n"));
			}
		},
	});

	pi.registerCommand("prune", {
		description: "Prune stale tool outputs, old reasoning, and old call args via context_edit stubs",
		handler: async (_args, ctx) => {
			const { analysis, plan, sm } = collectPlan(ctx);
			if (plan.edits.length === 0) {
				ctx.ui.notify("prune: nothing eligible under current policy", "info");
				return;
			}
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(`Apply /prune? (${analysis.protectTurns}-turn window · absolute axe on superseded reads)`, plan.summaryLines.join("\n"));
				if (!ok) return;
			}
			const result = applyPrunePlan(sm, plan);
			const lines = [
				`prune done: ${result.applied} edits${result.failed ? `, ${result.failed} failed` : ""} · ~${fmt(plan.netTokens)} tok pruned`,
			];
			const lifetime = formatPruneStats(collectPruneStats(sm.getBranch()));
			if (lifetime) lines.push(lifetime);
			lines.push(`undo: /unprune (record ${result.recordId}) · inspect: /ctx`);
			appendErrors(lines, result.errors);
			emit(ctx, lines);
		},
	});

	pi.registerCommand("unprune", {
		description: "Restore the most recent /prune batch from its saved originals",
		handler: async (_args, ctx) => {
			const sm = ctx.sessionManager as unknown as MutableSessionManager;
			const record = findLatestPruneRecord(sm.getBranch());
			if (!record) {
				ctx.ui.notify("unprune: no un-undone prune record on this branch", "info");
				return;
			}
			const result = applyUnprune(sm, record);
			const lines = [
				`unprune done: ${result.restored} restored${result.failed ? `, ${result.failed} failed` : ""} (record ${record.id})`,
			];
			const lifetime = formatPruneStats(collectPruneStats(sm.getBranch()));
			if (lifetime) lines.push(lifetime);
			appendErrors(lines, result.errors);
			emit(ctx, lines);
		},
	});

	const showConfig = (ctx: ExtensionContext): void => {
		const current = loadConfig(configPath);
		const lines = [formatConfigLine(current.config, current.path)];
		for (const warning of current.warnings) lines.push(`warning: ${warning}`);
		lines.push("edit: /prune-config · show: /prune-config show · reset: /prune-config reset");
		emit(ctx, lines);
	};

	const saveConfig = (ctx: ExtensionContext, raw: Record<string, unknown>): boolean => {
		const parsed = parseConfig(raw);
		if (parsed.warnings.length > 0) {
			emit(ctx, parsed.warnings.map((warning) => `prune-config: ${warning}`), "error");
			return false;
		}
		try {
			writeConfigFile(configPath, raw);
		} catch (error) {
			emit(ctx, [`prune-config: could not write ${configPath}: ${error instanceof Error ? error.message : String(error)}`], "error");
			return false;
		}
		config = parsed.config;
		armIdleTimer(ctx);
		return true;
	};

	const editConfigInteractive = async (ctx: ExtensionContext): Promise<void> => {
		const savePatch = (patch: ConfigPatch, message: string): boolean => {
			try {
				const next = applyConfigPatch(readConfigObject(configPath), patch);
				if (!saveConfig(ctx, next)) return false;
				ctx.ui.notify(message, "info");
				return true;
			} catch (error) {
				ctx.ui.notify(`prune-config: ${error instanceof Error ? error.message : String(error)}`, "error");
				return false;
			}
		};

		const ask = async (label: string, current: string, hint: string): Promise<string | undefined> => {
			const value = await ctx.ui.input(label, current || hint);
			return value === undefined ? undefined : value.trim();
		};

		while (true) {
			const auto = config.autoPrune;
			const autoText = auto
				? [
					auto.contextPercent !== undefined ? `ctx ${auto.contextPercent}%` : null,
					auto.reclaimablePercent !== undefined ? `reclaim ${auto.reclaimablePercent}%` : null,
					auto.idleMinutes !== undefined ? `idle ${auto.idleMinutes}m` : null,
					`min ${fmt(auto.minReclaimableTokens)}`,
					`cooldown ${auto.cooldownMinutes}m`,
				].filter(Boolean).join(", ")
				: "off";
			const options = [
				`Protect turns: ${config.protectTurns}`,
				`Alert percent: ${config.alertPercent === undefined ? "off" : `${config.alertPercent}%`}`,
				`Auto-prune: ${autoText}`,
				...(auto ? ["Edit auto-prune fields"] : []),
				"Reset to defaults",
				"Done",
			];
			const choice = await ctx.ui.select(`pi-prune config · ${configPath}`, options);
			if (choice === undefined || choice === "Done") return;

			if (choice === "Reset to defaults") {
				const ok = await ctx.ui.confirm("Reset pi-prune config?", `Write defaults to ${configPath}?`);
				if (ok && saveConfig(ctx, defaultConfigRaw())) ctx.ui.notify("pi-prune config reset", "info");
				continue;
			}

			if (choice.startsWith("Protect turns:")) {
				const text = await ask("Protect turns (0-100)", String(config.protectTurns), "2");
				if (text === undefined || text === "") continue;
				const value = Number(text);
				if (!Number.isInteger(value)) {
					ctx.ui.notify("protectTurns must be an integer from 0 to 100", "error");
					continue;
				}
				savePatch([{ key: "protectTurns", value }], `protectTurns set to ${value}`);
				continue;
			}

			if (choice.startsWith("Alert percent:")) {
				const text = await ask("Alert percent (1-100, off disables)", config.alertPercent === undefined ? "off" : String(config.alertPercent), "60");
				if (text === undefined || text === "") continue;
				if (text.toLowerCase() === "off" || text.toLowerCase() === "null") {
					savePatch([{ key: "alertPercent", value: null }], "alert disabled");
					continue;
				}
				const value = Number(text);
				if (!Number.isFinite(value)) {
					ctx.ui.notify("alertPercent must be a number from 1 to 100 or off", "error");
					continue;
				}
				savePatch([{ key: "alertPercent", value }], `alert set to ${value}%`);
				continue;
			}

			if (choice.startsWith("Auto-prune:")) {
				const enabled = await ctx.ui.select("Auto-prune", ["Off", "On"]);
				if (enabled === undefined) continue;
				if (enabled === "Off") {
					savePatch([{ key: "autoPrune", value: false }], "auto-prune disabled");
				} else if (config.autoPrune === false) {
					savePatch([{ key: "autoPrune", value: { minReclaimableTokens: DEFAULT_MIN_RECLAIMABLE_TOKENS, cooldownMinutes: DEFAULT_COOLDOWN_MINUTES } }], "auto-prune enabled, set a trigger");
				}
				continue;
			}

			if (choice === "Edit auto-prune fields") {
				const auto = config.autoPrune;
				if (!auto) continue;
				const fields = [
					{ label: "Context percent", key: "autoPrune.contextPercent", value: auto.contextPercent },
					{ label: "Reclaimable percent", key: "autoPrune.reclaimablePercent", value: auto.reclaimablePercent },
					{ label: "Minimum reclaimable tokens", key: "autoPrune.minReclaimableTokens", value: auto.minReclaimableTokens },
					{ label: "Idle minutes", key: "autoPrune.idleMinutes", value: auto.idleMinutes },
					{ label: "Cooldown minutes", key: "autoPrune.cooldownMinutes", value: auto.cooldownMinutes },
				];
				const selectedLabel = await ctx.ui.select("auto-prune fields", [
					...fields.map((field) => `${field.label}: ${field.value ?? "off"}`),
					"Back",
				]);
				if (selectedLabel === undefined || selectedLabel === "Back") continue;
				const selected = fields.find((field) => selectedLabel.startsWith(`${field.label}:`));
				if (!selected) continue;
				const text = await ask(`${selected.label} (off/null unsets)`, selected.value === undefined ? "off" : String(selected.value), "off");
				if (text === undefined || text === "") continue;
				if (text.toLowerCase() === "off" || text.toLowerCase() === "null") {
					savePatch([{ key: selected.key, value: null }], `${selected.key} unset`);
					continue;
				}
				const value = Number(text);
				if (!Number.isFinite(value)) {
					ctx.ui.notify(`${selected.key} must be a number or off`, "error");
					continue;
				}
				savePatch([{ key: selected.key, value }], `${selected.key} set to ${value}`);
				continue;
			}
		}
	};

	pi.registerCommand("prune-config", {
		description: "View or edit pi-prune config",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				if (!ctx.hasUI) {
					showConfig(ctx);
					return;
				}
				await editConfigInteractive(ctx);
				return;
			}

			if (command === "show") {
				showConfig(ctx);
				return;
			}

			if (command === "reset") {
				const ok = !ctx.hasUI || await ctx.ui.confirm("Reset pi-prune config?", `Write defaults to ${configPath}?`);
				if (ok && saveConfig(ctx, defaultConfigRaw())) {
					emit(ctx, ["prune-config: reset to defaults", formatConfigLine(config, configPath)]);
				}
				return;
			}

			try {
				const patch = parseConfigArgs(command);
				const next = applyConfigPatch(readConfigObject(configPath), patch);
				if (saveConfig(ctx, next)) {
					emit(ctx, ["prune-config: updated", formatConfigLine(config, configPath)]);
				}
			} catch (error) {
				emit(ctx, [
					`prune-config: ${error instanceof Error ? error.message : String(error)}`,
					"usage: /prune-config [show|reset|key=value ...]",
				], "error");
			}
		},
	});
}
