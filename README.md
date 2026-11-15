# dsh-session-relay

[English](README.md) | [中文](README.zh.md)

Cross-session relay for DeepSeek Harness. One session sends a message to another, waits for the target turn to end, and reads the target session's event stream. Read and write both require the target id in an on-disk allowlist.

```
session_list  →  session_say  →  session_wait  →  session_read
```

## What it is

DSH has no built-in way for one session to drive another. `agents.get(id)` returns any session in the registry without checking who is asking, and the agent-level `send` / `steer` / `followup` take no sender.

This plugin adds four tools that close that gap. Both directions pass an on-disk whitelist, so a session cannot be reached unless its id was written there by hand.

It is plain ESM in one file, with no build step and no static imports from `@deepseek-ai/*`.

## Install

Requires Node 20+ and DSH `>=0.2.1-rc.3 <0.3.0`.

### Option 1: one command

```bash
dsh plugin --profile <profile> add dsh-session-relay
```

A local path or tarball works the same way:

```bash
dsh plugin --profile <profile> add /abs/path/to/dsh-session-relay
```

The CLI writes both `dependencies` and `dsh.profile.bundles`. The bundles entry is what makes the host read this package's patch at startup, which inserts the loader entry `session-relay`.

### Option 2: from the repository

```bash
dsh plugin --profile <profile> add https://github.com/sqgg4747-ship-it/dsh-session-relay
```

### Option 3: hand it to your agent

Paste this into a DSH session and let the agent do the work:

> Install the `dsh-session-relay` plugin into my current profile. Source:
> `https://github.com/sqgg4747-ship-it/dsh-session-relay`. Use
> `dsh plugin --profile <profile> add <path>`, then copy `allowed-targets.json.example`
> to `allowed-targets.json` and ask me which session ids to put in `targets`.

Only the final step requires input: which session ids to authorize.

### After install

The plugin only loads if its name is in `dsh.profile.bundles`. `dsh plugin add` writes that for you. Verify it:

```json
{
  "dependencies": { "dsh-session-relay": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["dsh-session-relay"] } }
}
```

Without that entry the package is not mounted: it remains in `node_modules`, no loader entry is created, and the only indication is a single stderr line, `skipping profile bundle`.

To check the module itself loads and registers its four tools:

```bash
node --input-type=module -e "import('./index.js').then(m=>{const T={};m.apply({tools:{register:d=>{T[d.name]=d;return()=>{}}},effect:f=>{f();return()=>{}},get:()=>undefined},{});console.log(Object.keys(T).join(','))})"
# session_list,session_say,session_wait,session_read
```

### First run: create the allowlist

Until the file exists, every call is refused. This is the intended behaviour, not a failure of the package.

```bash
cd <profile>/node_modules/dsh-session-relay
cp allowed-targets.json.example allowed-targets.json
```

```json
{
  "targets": [{ "id": "session-5c1e0a72-...", "reason": "named by the user" }],
  "denied": []
}
```

- `denied` wins over `targets`.
- A missing file, an empty file, or unparseable JSON refuses everything, reads included.
- A UTF-8 BOM is stripped before parsing.
- The file is re-read when its mtime changes. No reload needed.
- Ids are `session-<uuid>`. Subagent sessions carry no prefix and are never accepted.

The default location sits inside the package directory, so a reinstall replaces it. Point `allowFile` outside `node_modules` for anything long-lived.

## Quick start

Once the whitelist has at least one id:

```
1. session_list()                                  pick a row with allowed: true
2. session_say(id, text, confirm: true)            returns seqAtSend
3. session_wait(id, sinceSeq: seqAtSend)           returns turnEnd
4. session_read(id, sinceSeq: seqAtSend)           the target's event stream
```

A complete exchange:

```js
session_say({ sessionId: 'session-5c1e0a72-...', text: 'run the smoke test', confirm: true })
// { ok: true, messageId: '...', seqAtSend: 128, archivedCheck: 'checked' }

session_wait({ sessionId: 'session-5c1e0a72-...', sinceSeq: 128 })
// { turnEnd: { turn: 4, kind: 'completed' }, status: 'idle', waitedMs: 18400 }

session_read({ sessionId: 'session-5c1e0a72-...', sinceSeq: 128, kinds: 'tool,reasoning' })
// [ { seq: 129, kind: 'reasoning', text: 'The smoke script expects ...' }, ... ]
```

## Tools

### session_list

No parameters. Returns `{id, preset, origin, status, seq, allowed, denied}` per row, at most 30, writable first then by descending sequence.

### session_say

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes | Target session id. |
| `text` | string | yes | Message body. Control and direction-override characters are stripped. |
| `mode` | `followup` \| `steer` \| `inject` | no | Defaults to `followup`. Any other value is rejected, never downgraded. |
| `confirm` | boolean | conditional | Required the first time this process writes to a target. |

Returns `{ok, sessionId, mode, messageId, senderSessionId, via, statusAtSend, seqAtSend, archivedCheck}`.

A repeat inside the dedup window returns `{ok: true, duplicate: true, messageId}` and sends nothing. A repeat whose first copy is still in flight returns `{ok: false, pending: true, shouldRetry: true}`. Rate limiting returns `{ok: false, rateLimited: true, retryAfterMs, attemptsInWindow}` as an ordinary result rather than a thrown error.

`mode` maps to the target's own methods: `followup` queues a new turn, `steer` drops into the running turn at its next step, `inject` adds context without waking it.

### session_wait

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes | Target session id. |
| `sinceSeq` | number | no | Base sequence; defaults to the current `seq`. Use the `seqAtSend` from `session_say`. |
| `timeoutMs` | number | no | Default 60000, capped at 180000. `0` checks once and returns. |

Normal return: `{ok, alreadyIdle, waitedMs, polls, seqBefore, seqAfter, status, turnEnd}`. `turnEnd` is `{turn, kind}`, carrying `error: {message, code}` for errors.

Other shapes: `{gone: true}`, `{timedOut: true}` (with the last event type, which usually shows where it stalled), `{queuedOnly: true}` (inject mode never wakes the target, so there is no turn to await), `{aborted: true}`, `{pollError: true}`.

`sinceSeq` must be an integer of 0 or more and no larger than the current sequence. Other values describe a condition that never becomes true, so they throw.

### session_read

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes | Target session id. |
| `sinceSeq` | number | no | Exclusive start. Omitted, the last `limit` events are returned. |
| `kinds` | string | no | `reasoning`, `text`, `tool`, `tool-result`, `turn-end`, `user`, `all`. Comma separated; `tool` covers calls and results. |
| `limit` | number | no | Default 100, capped at 500. |

Returns `[{seq, time, kind, text}]`. Tool calls include the full argument string.

## Configuration

| Key | Default | Effect |
| --- | --- | --- |
| `enabledPresets` | `[]` (all presets) | Only sessions whose `agentPreset` is in this list may call the tools. |
| `allowFile` | `allowed-targets.json` next to `index.js` | Whitelist path. |
| `maxChars` | `8000` | Body cap in UTF-16 code units, so an emoji costs 2. |
| `allowSelf` | `false` | Whether a session may message itself. |
| `dedupMs` | `60000` | Duplicate window. `0` turns the check off and stops touching the table. |
| `rateLimit` | `30` | Attempts per target per 60s. Failed attempts count. |
| `allowedTargets` | `[]` | Extra in-memory ids. When non-empty, only these are writable. |
| `requireConfirmForNewTarget` | `true` | First write to a target in this process needs `confirm: true`. |

No Config schema is exported. `@deepseek-ai/schemastery` does not resolve from inside a plugin directory, and importing it fails the load, so each key is read with a type check. A misspelled key silently falls back to its default.

```yaml
- id: session-relay
  name: dsh-session-relay
  config:
    enabledPresets: ['standard']
    allowFile: '~/.dsh/session-relay-targets.json'
```

`id` is `session-relay`, not the package name. Layers apply bundle first, then the profile patch, then `$DSH_HOME/cordis.patch.yml`, so a later layer can override the package.

An empty `enabledPresets` is deliberate: DSH ships `standard` as its default preset, so defaulting to a single name would leave a normal install answering "not available in this mode" on every call.

## How it works

The plugin registers four tools through `ctx.tools.register` and holds no state beyond an in-memory dedup table and a sliding rate-limit window. Everything else lives on disk.

A message is built in the host's own shape and handed to the target's own method:

```js
{ role: 'user', content, source: { kind: 'agent-message', form: 'relay', senderSessionId } }
```

`form: 'relay'` is DSH's own term for a message that arrived from another session. When the lazy `import('@deepseek-ai/dsh-llm')` succeeds, the host's `createUserMessage` builds it; otherwise an equivalent deep-frozen object is constructed by hand. Both paths produce the same fields.

`session_wait` polls `session.seq` and `agent.status` rather than sleeping on a fixed timer, and re-reads the registry each pass so a target that gets closed or reloaded mid-wait is detected instead of hanging until the timeout.

Four gates run before anything is delivered: the whitelist (both directions), `enabledPresets`, the subagent/archive checks, and `confirm`.

## Limitations

- No implicit resume. An offline target is an error. Resuming someone else's session through `agents.resume` without `agentOptions` breaks its prompt assembly, and every following turn ends in error.
- The archive check is fail-open. When `workspaceRegistry` is unavailable the result carries `archivedCheck: 'unavailable'` and nothing is blocked.
- Dedup and rate-limit state live in memory and clear on host restart.
- Text only. No images or attachments.
- One target at a time. No fan-out, no broadcast.
- Delivery is not atomic with the checks in front of it; a thrown error can still mean the message landed.
- `session.eventAt` is deprecated upstream in favour of `snapshotEvents`. It works today and will be replaced in a later version.
- Tool error messages are currently Chinese.

## Troubleshooting

**`dsh: skipping profile bundle "dsh-session-relay"`** — the package resolves but has no entry in `dsh.profile.bundles`. The most common install failure, and silent apart from that one stderr line.

**`ERR_MODULE_NOT_FOUND` at startup** — the name is in `bundles` but `<profile>/node_modules/dsh-session-relay` cannot be read. Recreate the link or reinstall.

**`tool "session_say" is already registered`** — another plugin owns that name. The registration throws before the rest run, so the remaining tools never register either.

**Every call fails naming a path under `node_modules`** — the whitelist file does not exist yet. Copy `allowed-targets.json.example`.

**`prompt variable "{{model}}" has no value`** — not this plugin's error. It is what a target writes into every `turn/end` after somebody resumed it without `agentOptions`. `session_wait` reports it as `turnEnd.kind = error`.

**Entry exists but no tools** — look for a `no-fiber` entry, which means the module failed to import. Also search the profile patch for both `session-relay` and `dsh-session-relay`.

**`session_wait` returns `queuedOnly: true`** — you used `mode: 'inject'`. That mode never wakes the target. Use `followup` when you need a `turnEnd`.

## Uninstall

```bash
dsh plugin --profile <profile> remove dsh-session-relay
```

Two identifiers are involved. The bundle patch inserts `id: session-relay`; some third-party uninstallers write `disabled` lines against the package name `dsh-session-relay`, which matches no entry and disables nothing. The reverse case is not symmetric — `- id: session-relay` with `disabled: true` overrides the bundle entry and survives a reinstall. Search for both strings after removal.

## Compatibility

- Node 20+, ESM only, no build.
- `engines.dsh` is `>=0.2.1-rc.3 <0.3.0`.
- Touches `agents.get` / `list` / `roots`, `agent.status`, `agent.followup` / `steer` / `inject`, `session.seq`, `session.eventAt`, and optionally `workspaceRegistry`. Resolved at call time, so a host that drops one produces an error on the call rather than at load.
- `session.seq` is the next sequence number to be assigned. `seq: 133` means the last event sits at `eventAt(132)`.
- `session.events` does not exist; code written against it will not work.
- `header` carries no `title` and no `archived`. `session_list` reports what it has instead of inventing values.
- For other plugin authors: `ctx.tools.register` does not compile the author dialect. `parameters` must be native JSON Schema with `required` and `additionalProperties` spelled out.

## License

MIT. See LICENSE.

Copyright (c) 2026 dsh-session-relay contributors.
