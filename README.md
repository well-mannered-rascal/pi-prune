# pi-prune

Surgical context pruning for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

`pi-prune` removes stale tool output, old reasoning, and old tool call arguments through pi's `context_edit` entries. Recent context stays intact. Every batch is reversible.

## Commands

- **`/ctx`** shows a one-page analysis: where the context window goes, what is reclaimable, and cache economics. `/ctx full` adds cache and recency detail, compaction history, prune history, effective config, and per-item detail.
- **`/prune`** shows an exact confirm preview, then stubs or drops eligible content.
- **`/unprune`** restores the last prune batch byte for byte.
- **`/prune-config`** views or edits config. Interactive in the TUI. Supports `show`, `reset`, and `key=value` updates.

`/ctx` and `/prune` share one classifier and one plan builder. The preview reports exactly what `/prune` applies.

## Install

```bash
pi install npm:pi-prune
```

Or from git:

```bash
pi install git:github.com/<owner>/pi-prune
```

Or from a local checkout:

```bash
pi install /path/to/pi-prune
```

Then run `/reload` in an open pi session. For a one-off test without adding the package:

```bash
pi -e /path/to/pi-prune
```

## Policy

All rules share one window. Content becomes eligible once it is older than `protectTurns` user turns. The default is 2, so eligibility starts at age 3.

| Rule | Disposition | Criteria |
|---|---|---|
| superseded reads | stub | older `read` of a path read again later, >= 100 tok, any age |
| stale tool results | stub | `read`, `bash`, `edit`, `write`, `web_*`, `grep`, `glob`, `find`, `ls`, age past the protect window, >= 300 tok |
| assistant thinking | strip | age past the protect window, >= 200 tok, or its tool result is pruned in the same batch |
| tool call args | cleared in place | age past the protect window, >= 50 tok per call |
| small episodes | dropped whole | result < 300 tok past the protect window, paired call block goes with it |

Hard invariants:

- A tool result is never removed without its call block.
- Replacements are built from projected content, so earlier prune batches cannot be resurrected.
- Raw originals are stored in a `pi-prune-record` custom entry for `/unprune`.

## Config

Config is global only. It is stored at `~/.pi/agent/pi-prune.json`, or `$PI_CODING_AGENT_DIR/pi-prune.json` when that variable is set. It is not project-local.

Use `/prune-config` for interactive editing. Changes are written atomically and applied immediately, so `/reload` is only needed after editing the file by hand.

```text
/prune-config
/prune-config show
/prune-config protectTurns=3
/prune-config autoPrune.contextPercent=85 autoPrune.idleMinutes=60
/prune-config autoPrune.contextPercent=null
/prune-config reset
```

`null` or `off` unsets a nested auto-prune key. `alertPercent=null` or `alertPercent=off` disables the alert. `reset` writes explicit defaults to the file.

```json
{
  "protectTurns": 2,
  "autoPrune": {
    "contextPercent": 85,
    "reclaimablePercent": 30,
    "minReclaimableTokens": 15000,
    "idleMinutes": 60,
    "cooldownMinutes": 10
  },
  "alertPercent": 60
}
```

| Key | Default | Meaning |
|---|---|---|
| `protectTurns` | `2` | Current and previous N user turns are protected. Integer from 0 to 100. |
| `autoPrune` | `false` | Omit it or set `false` to disable all automatic pruning. |
| `autoPrune.contextPercent` | unset | Prune when estimated context is at least this percent of the context window. |
| `autoPrune.reclaimablePercent` | unset | Prune when reclaimable tokens are at least this percent of current context. |
| `autoPrune.minReclaimableTokens` | `15000` | Every auto trigger requires at least this many reclaimable tokens. |
| `autoPrune.idleMinutes` | unset | Prune after this many minutes without agent activity. |
| `autoPrune.cooldownMinutes` | `10` | Minimum gap between auto prunes. Skipped when context is near the auto-compaction limit. |
| `alertPercent` | `60` | Notify when max pruning still leaves context at or above this percent. Set `null` to disable. |

A scenario is enabled by setting its key. Omit it to disable that scenario. Invalid values warn and use the default or leave the scenario disabled.

Config is read at startup and on session start. Run `/reload` after editing it. `/ctx full` shows the effective config.

## Auto-prune

Auto-prune evaluates at the end of each completed turn. It applies through pi's boundary `context_edit` drafts, so it never adds a model request and pi's compaction check sees the pruned context.

- Auto never prompts.
- Auto requires a plan with at least `minReclaimableTokens`.
- Auto respects `cooldownMinutes` unless context is within the compaction reserve.
- Auto writes a normal prune record, so `/unprune` restores the last auto batch.
- Idle pruning uses a single timer armed after the agent settles. It is cleared on agent start, session switch, fork, and shutdown. A resumed session checks the gap from the last assistant message.

Auto-prune invalidates the prompt cache for the next request. The token floor and cooldown exist to keep that cost from exceeding the savings. Idle pruning is cheapest because the cache is usually cold already.

## Alert

The alert is independent of auto-prune. It fires when the best available prune would still leave context above `alertPercent`.

Example message:

```
pi-prune: context ~58% after max prune (116,000 / 200,000 tok).
Pruning is exhausted. Use /compact or /new.
```

It fires once per threshold crossing and resets after compaction or when context drops below the threshold.

## Prune history

Prune messages report net tokens only:

```
prune done: 12 edits · ~33,700 tok pruned
lifetime: ~182,000 tok pruned across 5 batches (4 manual, 1 auto)
undo: /unprune
```

Tokens are estimated with pi's chars/4 method. Net means content removed minus replacement text added back. The history is branch scoped and derived from prune records, so `/tree` navigation and `/unprune` stay consistent.

The number is historical context removed, not billed tokens and not money saved. Cache invalidation is not subtracted.

## Why

`/compact` summarizes and destroys working memory wholesale. `pi-prune` removes content that behaves like replay bookkeeping, old args, old thinking, and stale tool output, while leaving recent context untouched.

Token math mirrors pi's own `estimateTokens` (chars/4) and anchors totals on the last billed usage, the same hybrid pi compaction uses.

## Tests

```bash
npm test
```

- `test/engine-edges.mjs`: in-memory token boundaries, anchoring, already-pruned content, referent-pruned thinking, missing originals, and partial apply/unprune failures, 34 checks
- `test/prune-fixture-e2e.mjs`: deterministic synthetic session, 38 checks
- `test/config-e2e.mjs`: config parsing and loading, trigger decisions, stats, plan row accounting, config editing, and protect-window accounting, 55 checks
- `test/extension-e2e.mjs`: extension wiring, boundary drafts, auto-prune, alert suppression, idle timer, command and wizard unhappy paths, 28 checks
- `test/prune-e2e.mjs`: optional live-session regression, set `PI_SESSION_FILE`
- `test/smoke.mjs`: optional real-session report, set `PI_SESSION_FILE`

Node 24 strips TypeScript types natively for the tests. The extension itself has zero runtime dependencies.

## License

MIT
