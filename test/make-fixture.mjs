/**
 * Generates a synthetic native-format pi session fixture:
 *   node test/make-fixture.mjs [outdir]
 *
 * Shape: a compaction checkpoint followed by two blocks of turns.
 * Block A (old): several turns of read/bash episodes plus a superseded
 * re-read pair, thinking blocks, and large args on a write/edit call whose
 * result is a one-line confirmation. Block B (fresh): one turn of recent work
 * inside the protection window.
 *
 * Every number is asserted later by prune-fixture-e2e.mjs. Sizes are chosen
 * so the fixture is deterministic under the chars/4 estimator (all ASCII).
 */
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2] ?? "/tmp";
const file = path.join(outDir, "pi-prune-fixture.jsonl");

let idCounter = 0;
const nid = () => `fix${String(++idCounter).padStart(4, "0")}`;
const ts = (i) => new Date(Date.UTC(2026, 9, 14, 12, 0, i)).toISOString();

let parent = null;
const entries = [];
function push(e) {
	e.id = e.id ?? nid();
	e.parentId = e.parentId ?? parent;
	e.timestamp = e.timestamp ?? ts(entries.length);
	parent = e.id;
	entries.push(e);
}

// --- session header + settings ---
push({ type: "session", version: 3, id: "fixture-session-id", cwd: "/tmp" });
push({ type: "model_change", provider: "openrouter", modelId: "@preset/glm-5-3-flash-custom" });
push({ type: "thinking_level_change", thinkingLevel: "off" });

// system + first user
push({ type: "message", message: { role: "system", content: "sys", sections: { preamble: "You are a test fixture system prompt. ".repeat(20) } } });

// --- Block A: 4 old turns of tool debris (all summarized away by the checkpoint) ---
const big = (n) => "x".repeat(n);

// Turn 1: read + bash + thinking + superseded re-read
push({ type: "message", message: { role: "user", content: [{ type: "text", text: "do block A" }] } });
push({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "t" + big(800) }, { type: "toolCall", id: "c_read1", name: "read", arguments: { path: "/tmp/a.ts" } }, { type: "toolCall", id: "c_bash1", name: "bash", arguments: { command: big(400) } }] } });
push({ type: "message", message: { role: "toolResult", toolCallId: "c_read1", toolName: "read", content: [{ type: "text", text: big(4000) }] } });
push({ type: "message", message: { role: "toolResult", toolCallId: "c_bash1", toolName: "bash", content: [{ type: "text", text: big(2000) }] } });
// superseded re-read of /tmp/a.ts
push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c_read2", name: "read", arguments: { path: "/tmp/a.ts" } }] } });
push({ type: "message", message: { role: "toolResult", toolCallId: "c_read2", toolName: "read", content: [{ type: "text", text: big(3600) }] } }); // newest read, kept
// thinking-only assistant at old age
push({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "t" + big(1200) }] } });

// Turn 2: episode-args pattern (big args, one-line result)
push({ type: "message", message: { role: "user", content: [{ type: "text", text: "write it" }] } });
push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c_write1", name: "write", arguments: { path: "/tmp/w.ts", content: big(1200) } }] } });
push({ type: "message", message: { role: "toolResult", toolCallId: "c_write1", toolName: "write", content: [{ type: "text", text: "Successfully wrote to /tmp/w.ts" }] } }); // tiny result

// Turn 3: big edit args + big stale bash
push({ type: "message", message: { role: "user", content: [{ type: "text", text: "edit it" }] } });
push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c_edit1", name: "edit", arguments: { path: "/tmp/w.ts", oldText: big(600), newText: big(600) } }, { type: "toolCall", id: "c_bash2", name: "bash", arguments: { command: big(200) } }] } });
push({ type: "message", message: { role: "toolResult", toolCallId: "c_edit1", toolName: "edit", content: [{ type: "text", text: "Successfully replaced 1 block(s) in /tmp/w.ts" }] } }); // tiny
push({ type: "message", message: { role: "toolResult", toolCallId: "c_bash2", toolName: "bash", content: [{ type: "text", text: big(1600) }] } });

// --- compaction checkpoint: summarizes everything above ---
// firstKeptEntryId points at the checkpoint itself (nothing pre-compaction is kept).
// summary is ~13k chars => ~3.2k tok compaction summary line in the chart.
const summary = "## Fixture summary\n" + big(12800);
push({ type: "compaction", summary, firstKeptEntryId: parent, tokensBefore: 9000, details: {} });

// --- Block B: fresh turns inside the window ---
// Two filler turns age the checkpoint itself to age 3+ so its summary and the
// pre-compaction debris cross the STALE_MIN_AGE threshold; the third turn
// carries the protected fresh episode.
for (let t = 0; t < 3; t++) {
	push({ type: "message", message: { role: "user", content: [{ type: "text", text: `age the window ${t}` }] } });
	push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
}
// Superseded re-read pair: two reads of the same path, older one must be
// absolutely axed. Lives post-checkpoint because pre-checkpoint entries are
// summarized away (buildContextEntries keeps only the checkpoint + kept tail).
push({ type: "message", message: { role: "user", content: [{ type: "text", text: "re-read" }] } });
push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c_reread1", name: "read", arguments: { path: "/tmp/r.ts" } }] } });
push({ type: "message", message: { role: "toolResult", toolCallId: "c_reread1", toolName: "read", content: [{ type: "text", text: big(1600) }] } }); // superseded
push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c_reread2", name: "read", arguments: { path: "/tmp/r.ts" } }] } });
push({ type: "message", message: { role: "toolResult", toolCallId: "c_reread2", toolName: "read", content: [{ type: "text", text: big(1600) }] } }); // newest, kept
// Episode-args episodes: big write/edit args, one-line results. Post-checkpoint
// because only kept-tail content can be pruned at all.
push({ type: "message", message: { role: "user", content: [{ type: "text", text: "persist" }] } });
push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c_ep_write", name: "write", arguments: { path: "/tmp/ep1.ts", content: big(1000) } }] } });
push({ type: "message", message: { role: "toolResult", toolCallId: "c_ep_write", toolName: "write", content: [{ type: "text", text: "Successfully wrote to /tmp/ep1.ts" }] } });
push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c_ep_edit", name: "edit", arguments: { path: "/tmp/ep1.ts", oldText: big(500), newText: big(500) } }] } });
push({ type: "message", message: { role: "toolResult", toolCallId: "c_ep_edit", toolName: "edit", content: [{ type: "text", text: "Successfully replaced 1 block(s) in /tmp/ep1.ts" }] } });
// thinking blocks, old enough to strip (post-checkpoint)
push({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "post" + big(800) }] } });
// Big-args call with a BIG result: gets a tool-stub (not an episode drop), so
// its call block survives and the args-clear rule applies to it.
push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c_stub_bash", name: "bash", arguments: { command: big(600) } }] } });
push({ type: "message", message: { role: "toolResult", toolCallId: "c_stub_bash", toolName: "bash", content: [{ type: "text", text: big(2000) }] } }); // ~500 tok, stubbed
// One more filler turn so the persist/thinking turns cross STALE_MIN_AGE
push({ type: "message", message: { role: "user", content: [{ type: "text", text: "age more" }] } });
push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
push({ type: "message", message: { role: "user", content: [{ type: "text", text: "block B turn" }] } });
push({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "fresh" + big(400) }, { type: "toolCall", id: "c_fresh_read", name: "read", arguments: { path: "/tmp/b.ts" } }] } });
push({ type: "message", message: { role: "toolResult", toolCallId: "c_fresh_read", toolName: "read", content: [{ type: "text", text: big(2000) }] } });
push({ type: "message", message: { role: "user", content: [{ type: "text", text: "block B turn 2" }] } });
const freshUser = parent;
push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1000, output: 10, cacheRead: 500, cacheWrite: 100 }, stopReason: "stop" } });

// --- Post-prune checkpoint (applied by the e2e after /prune) ---
// Real pi compaction keeps a recent suffix, so firstKeptEntryId points at the
// fresh user turn rather than the checkpoint itself. Summarized-away content is
// exactly what /prune elided, so the checkpoint must not resurrect it.
fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n"); // flush block B pre-checkpoint
export const postPruneCompaction = () =>
	JSON.stringify({ type: "compaction", id: "fixcomp9", parentId: parent, timestamp: new Date(Date.UTC(2026, 9, 14, 13, 0, 0)).toISOString(), summary: "## Post-prune summary\n" + big(400), firstKeptEntryId: freshUser, tokensBefore: 4000, details: {} });

fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(file, `${entries.length} entries, ${fs.statSync(file).size} bytes`);

// sanity: projection must parse
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const sm = SessionManager.open(file);
const proj = sm.buildSessionProjection();
const roles = proj.messages.map((m) => m.role).join(",");
console.log("projection:", proj.messages.length, "msgs:", roles);
if (!roles.includes("compactionSummary")) throw new Error("compaction summary not projected");
