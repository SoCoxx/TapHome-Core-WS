---
name: th
description: Work with a TapHome smart-home Core directly over its native WebSocket protocol (the one the TapHome apps use), using the Node tools of the TapHome-Core-WS repository. Use this whenever the user asks about the live state or configuration of their TapHome installation, for example a device's current value, value history or log ("who/what switched X"), why a smart rule did or didn't fire, which rules affect a device and whether a limiting condition blocks them, script debugging (last-run variable values), Modbus or TapHome Bus health and module diagnostics, users, exports, media, access-control week plans, or backing up/exporting the configuration. Also use it when they want to change something on the Core: switch a device, edit or create a smart rule (button press/long-press actions, conditions), create a variable or virtual device, set a device's zone, turn on value history, or configure a TapHome Bus module terminal. Not for writing TapHome scripts or designing smart rules in the abstract, and not for the REST TapHomeApi.
---

# TapHome Core over the native WebSocket protocol

The TapHome app talks to the Core over `ws://<core>/Core` with protobuf-net messages. The TapHome-Core-WS tools reproduce that protocol. They can read the full configuration, live values, history and logs, and they can make the same changes the app makes.

Changes made with these tools are as real as changes made in the app, and some requests delete things in bulk. The working agreement is: **writes that have already been tested live go ahead when the user asks for them; anything untested or risky needs a detailed plan the user has approved first.** See "Safety routine" below; it is the most important part of this skill.

## Setup

**Find the clone.** This skill normally lives in `<clone>/.claude/skills/th/`, so the clone is three folders above this file (resolve links with `realpath`). If that folder has no `probe/session.mjs`, use `$TAPHOME_CORE_WS`. If neither works, ask the user where the clone is.

Run the tools from the clone root:

```bash
cd "<clone>"
node probe/<tool>.mjs ...
```

- **`config.json`** holds the Core's IP address, the local admin login and the password salt. Never print, copy or commit the file, and don't ask for or paste the credentials into the conversation; the user types them into the file. If `passwordSalt` is empty, or a tool says it's missing, run the auth workflow below.
- Pipe output through `grep -viE "token|password"` so credentials and access tokens never reach the conversation.
- **`out/`** (gitignored) holds generated data:
  - `out/reconnect.json`: the full configuration
  - `out/config/`: a readable export
  - `out/edit/`: rule edits
  - `out/media/`: downloaded media

  It contains module passwords; never commit or upload it.
- **`out/config/` is a snapshot.** If the question is about the current state, refresh it first: `node probe/dump.mjs && node probe/export.mjs`.
- **`site-notes.md`** in the clone root (gitignored) holds facts about this particular installation. Read it before acting if it exists. Examples: device ids agreed for testing, modules that must not be touched, where the backups are, and the user's preferences. Add new facts there when the user agrees to them (a new test device, a decision about what to leave alone). Don't put installation facts into the README or this skill.
- **Schema.** The protocol schema is committed as `schema/taphome-schema.json`, so no decompiled code is needed to run the tools. If messages decode as `$unknown…` after a TapHome update, the schema is stale: regenerate it with `node probe/build-schema.mjs` from a newly decompiled `TapHome.Core.Lib.Model` (`modelDir` in `config.json`), then run `roundtrip.mjs reconnect`. Never commit decompiled sources.
- **Decompiled client.** If the user decompiled it (`TapHome.Client.Desktop.Wpf`), it is the reference for how the app builds a request. Ask where it is, or check `site-notes.md`.

## Auth (`/th auth`, first-time setup)

Run this when the skill is invoked with `auth`, when the user asks to set up or connect to their Core, or when `passwordSalt` is missing:

1. **Config.** If `config.json` doesn't exist, copy `config.example.json` to it. Ask the user to fill in `host` (the Core's IP), `username` and `password` (a local Core user with admin rights, not a TapHome cloud account) and to tell you when it's saved. Don't read the values back to them.
2. **Run** `node probe/auth.mjs 2>&1 | grep -viE "token"`. It finds the installed TapHome Store app, reads the salt from `TapHome.Core.Lib.Common.dll`, logs in once to check it, and only then writes `passwordSalt` to `config.json`. It never prints the salt. It also stores the session in `.session.json` (gitignored), which every tool reuses, so later runs don't log in again.
3. **Read the outcome:**
   - **"TapHome app not found":** the user installs "TapHome" from the Microsoft Store, sets `appDir`, or passes the DLL path (`node probe/auth.mjs <dll>`). On macOS or Linux, they copy the DLL from a Windows install.
   - **"login failed":** the username or password is wrong, or the user is a cloud account. Ask the user to fix `config.json`. Don't retry in a loop, because repeated failed logins may lock the user.
   - **"could not reach the Core":** check `host` and that this machine is on the Core's LAN.
4. **Confirm** with a read-only `node probe/dump.mjs`, and tell the user how many devices and rules the Core has.

Other auth commands:
- `node probe/auth.mjs status`: which config values are set, and whether the stored session still works. It checks without the password.
- `node probe/auth.mjs logout`: forget the stored session.

The tools log in again by themselves when the Core rejects the stored session. `NO_SESSION=1` forces a fresh login. Several tools can share the stored session at the same time; for example, `listen.mjs` keeps running while `ask.mjs` is used.

## Which tool for what

**Start with the composite tools.** They are read-only, take a device or rule **id or name words** (any case, diacritics optional, Slovak inflections match: `teplota garaz`), and read the live configuration from their own session, so they need no `dump.mjs` first. One run (about 1 s) replaces several `ask.mjs` calls plus grepping `out/config/`. A name that matches several objects prints the candidates with their ids; rerun with the id.

| Need | Tool |
|---|---|
| Find a device, rule, zone or category by name; a device's live values (manual override and non-OK status included) | `find.mjs <query> [<query> …] [--rules] [--json]`. `--rules` adds each device's rules with their role (input / condition / variable / output) |
| "Why did / didn't X happen?" for a device | `why.mjs <device> [--log N] [--brief]`: live values and device errors, the log with rule and device names, every rule writing it with live status, priority, summary and the current value of each variable its condition/formula reads, a script rule's last run, and the rules that only read it |
| Everything about one smart rule | `rule.mjs <rule>`: summary and full script/formula, live status on each output (and the other rules competing there), current variable and input values, errors, a script rule's last run |
| Value history | `history.mjs <device> [ValueLogType] [--hours N \| --days N] [--agg raw\|1h\|1d\|1m] [--fn Avg] [--all] [--csv]`: builds the request (dates, aggregation chosen by range), warns when the value or aggregation isn't recorded, prints min/max/avg (for switches: on-time and switch-ons) and the points |

The tools below are the building blocks; use them for what the composite tools don't cover.

| Need | Tool |
|---|---|
| First-time setup: salt into `config.json`, checked by a login; stores the session | `auth.mjs [dll]`, `auth.mjs status`, `auth.mjs logout` |
| Full configuration (devices, rules, zones, dashboards) | `dump.mjs` → `out/reconnect.json`; `export.mjs` → `out/config/` (`devices.json`, `smartrules.txt`, `smartrules-by-device.json`, per-device JSON, scripts as `.txt`) |
| Any single request, read-only by default | `ask.mjs '<json>'` (or `@file.json`). It refuses non-read requests unless `--write`. `DRY=1` encodes only; `WATCH=<s>` keeps listening; `RAW=1` prints raw JSON. It pretty-prints history points, device logs and script values |
| Switch or set a device | `control.mjs <deviceId> set <ValueLogType>=<value>`, or a raw action key (`switch true`, `push-button long`, `module-led-start`) |
| Edit a smart rule | `rule-edit.mjs pull\|push\|restore <ruleId> [--send]` |
| Create, rename or delete a rule (TEST names only) | `rules-write.mjs` |
| Create, rename or delete a virtual device or variable (TEST names only) | `devices-write.mjs` |
| Media library | `media.mjs list\|get\|put\|delete` (put and delete: TEST names only) |
| Modbus health | `modbus-health.mjs [hours]` |
| Watch what the Core broadcasts to other clients | `listen.mjs [seconds]` (run it in the background during a write) |
| Check the encoder offline | `roundtrip.mjs rules\|reconnect` (must print `same`) |
| Regenerate the schema after a TapHome update | `build-schema.mjs [modelDir]` |

The request formats for `ask.mjs` are in the reference files. Copy them instead of guessing field names. The encoder is strict and rejects unknown keys, which catches typos.

## Safety routine (for anything that changes the Core)

Writes have kept every test reversible when done this way. There are two tiers.

### Tested writes: just do them

When the user asks for a change that uses a write already tested live, carry it out without presenting a plan or waiting for approval. The user's request is the approval. Tested writes are:
- device control with `control.mjs` (switch, set a value, push-button actions, module LED)
- creating a PushButton rule, editing a rule with `rule-edit.mjs` (actions, name, `IsEnabled`), and renaming/deleting TEST rules with `rules-write.mjs`
- every section of `references/writing.md` that isn't marked as untested (virtual devices and variables, device properties such as zone/category/name, value history, manual override, zones, date periods, exports, media, week plans)
- the TapHome Bus sequence tested in `references/bus-modules.md`, only on a module with no terminal devices in use

Still run the mechanical safety steps: dry-run the encoding, snapshot `out/reconnect.json`, check each reply, verify with a diff afterwards, and report what changed. Stop and ask before going on if:
- the dry run, a reply or the diff shows anything you didn't intend (another rule or device changed, a removed list that isn't empty)
- the change reaches beyond what the user named (bulk edits, several objects at once, overwriting a rule the user didn't mention)
- it deletes something that wasn't created in this session
- the request is ambiguous: which device or rule is meant, or what the action should do

If the change needs a physical check (pressing a button, looking at a light), tell the user what to check once it's done.

### Everything else: plan first

Writes that have not been tested live, and anything a reference file says needs its own plan (script properties, terminal configuration of a module with devices in use), go through the full routine. A vague "continue" is not approval for such a write; ask for an explicit yes to the specific plan.

1. **Research read-only first.** Find how the app does it in the decompiled client (e.g. `ClientCommunicationManager.cs`, `*CommunicationHelper.cs`) and send exactly what the app sends. Several requests fail without an app-side detail. For example, an export profile needs a client-generated `Id`, and a new zone needs `DashboardTypeId` 3 and empty content.
2. **Dry-run the encoding** (`DRY=1`, or `push` without `--send`) and check that it decodes back to what you intended.
3. **Present a plan as a table** and wait for approval. Give each step, the change on the Core, the expected result, and what the user can check in the app, plus the risks. Prefer throwaway objects named `TEST … (delete me)`, with a final step that deletes them.
4. **Snapshot** `out/reconnect.json` to a scratch folder before the first write.
5. **Execute step by step**, checking each reply (`ErrorCode` 1 = Ok; `flags=1` = Handled). Stop at a checkpoint where the user looks at the app. If anything unexpected shows up, stop and investigate before the next write. That includes a screenshot showing something you didn't account for, or an extra device in a removed list.
6. **Verify.** Dump again and diff against the snapshot: devices (ignoring `CurrentValues`/`AggregatedValues`), rules, dashboards, dashboard sets and interfaces. Report what changed and what did not.
7. **Record** what you learned: protocol facts go in the repo README if the user maintains it, and installation facts go in `site-notes.md`. Once a new write has worked live, add it to the reference files so it counts as tested next time.

Never touch these, even when asked casually without a specific plan (the tested tier never covers them):
- firmware updates
- Core restart, reset, restore, clone or update
- network settings
- users and passwords
- the exposed TapHome API devices ("expose devices"), which other integrations may depend on
- access-card links
- raw Modbus/HTTP transactions
- blind calibration (it moves blinds)
- the terminal configuration of TapHome Bus modules that have devices in use (see `references/bus-modules.md`)

## Common workflows

**"Why did / didn't X happen?"** Run `why.mjs <device>` first; it combines everything below. Then read the answer off it: the log line names the rule and device that caused a change, and for each rule the status plus the variable values let you evaluate its condition formula by hand (e.g. `Te + 2 < Se` with `Te=48`, `Se=51`). Follow up with `rule.mjs <id>` for a rule, or `why.mjs` on the device that started the chain (`from device …`). The pieces, for when you need them separately:
- **the device log:** each change with its origin (Manual / App / SmartRule), the rule id and the triggering device. `{"$type":"MessageGetDeviceLogRequest","DeviceId":N}`
- **the rules affecting the device** and their live status (`LimitedByCondition` = blocked by its limiting condition right now). `{"$type":"MessageGetAffectingTriggersInfoRequest","DeviceId":N}`
- **the rule text and condition formula,** from `out/config/smartrules.txt` and `smartrules/<id>-*.json`
- **the current values** of the condition's input devices
- **the last-run variable values** for script or formula rules: `MessageGetScriptLastRunValuesRequest`

**History.** Use `history.mjs`. History exists only for values with recording on (`EnabledValueAggregations` on the device). The Core keeps raw values for about 5 h, hourly averages for about 8 days, and daily and monthly averages for 1 year. Older data is only in the TapHome cloud. See `references/reading.md`.

**Shared code.** `probe/lib.mjs` holds what the tools share: `connect()` (one session with the live configuration and an `ask(req)` that returns the decoded reply), the name index (`resolveDevice`, `resolveRule`, `valueText`, `describeRule`, rules by device), and the decoders for history, logs, script values and errors. A new read-only tool is a few lines on top of it; see `why.mjs`.

**Editing a rule.**
1. Run `pull <id>`. Edit `out/edit/<id>.json`, copying action shapes from existing rules in `out/config/smartrules/`.
2. Run `push <id>` (a dry run). It shows a field diff, and it refuses if there are typos, if the `Id` changed, or if the live rule changed since the pull.
3. If the diff shows only what you intended, run `push <id> --send` (a tested write; see "Safety routine").
4. The Core fills in `TriggerInputs` and `Priorities` itself. `restore <id> --send` undoes the change.

## Reference files

Read only the one you need:
- `references/protocol.md`: connection, framing, auth, encoder rules and gotchas (Node's built-in WebSocket fails; use `rawws.mjs`).
- `references/smart-rules.md`: `TriggerModel` fields, limiting conditions, action shapes, rule types, and details of writing and editing rules.
- `references/reading.md`:
  - history, device logs and script values
  - affecting rules and service attributes
  - Modbus and bus health
  - the settings pages: users, location, network, exports, access
  - other read-only requests
- `references/writing.md`:
  - device control action keys
  - virtual devices and device properties
  - the history toggle and manual override
  - zones, date periods and exports
  - media and week plans
  - which changes the Core broadcasts
- `references/bus-modules.md`: TapHome Bus terminal configuration (the full-list diff that can delete devices), the serial-number scheme, EXT/INT port sensors, the module LED, and health.
