# TapHome-Core-WS

A Node.js client for the TapHome Core's own WebSocket protocol, the one the TapHome apps use. It connects
on the local network with no cloud involved and can:

- read the full configuration (devices, interfaces, zones, smart rules) and export it as readable files
- stream every device value change live
- read value history, device logs, script debugger values and the live status of smart rules
- control devices, edit smart rules, and make the other changes the app makes

It complements the REST `TapHomeApi`, which only covers the devices exposed to it.

> **Unofficial.** This project is not affiliated with or endorsed by TapHome. The protocol was worked out from
> the Windows app. Writes are as real as changes made in the app, and a wrong request can delete devices or rules.
> Make a Core backup first, and read [Safety](#safety) before sending anything that is not a read.

## Setup

You need:
- Node.js 20 or newer. There are no npm dependencies.
- The TapHome Core on your LAN.
- A **local Core user with admin rights**: in the app, a user that is not a TapHome cloud account.
- The **TapHome Windows app**, installed from the Microsoft Store. `auth.mjs` reads the password salt from it (step 2).

The protocol schema (message classes, field numbers, enums) ships with the repository as `schema/taphome-schema.json`. It was extracted from the app's `TapHome.Core.Lib.Model` assembly, and the repository contains no decompiled source and no salt.

1. **Create your config.** Copy `config.example.json` to `config.json` and fill it in:

   | Key | Value |
   |---|---|
   | `host` | the Core's IP address (the `CORE_IP` environment variable overrides it) |
   | `username`, `password` | the local admin user |
   | `passwordSalt` | leave it as is; step 2 fills it in |
   | `appDir` | optional: where `TapHome.Core.Lib.Common.dll` is, if the Store app isn't installed on this machine |
   | `translations` | optional: a TapHome translations `.resx` file, to resolve built-in names such as `${zone_livingRoom}` (decompile `runtime/<lang>/TapHome.Translations.resources.dll`) |
   | `modelDir` | optional: the decompiled `TapHome.Core.Lib.Model`, only needed to regenerate the schema (see below) |
   | `cloud.email`, `cloud.password` | optional: a TapHome account, used only with `MODE=cloud` |

   Relative paths are resolved from the config file's folder. `TAPHOME_CONFIG=<file>` points the tools to another config file.
2. **Authenticate:** `node probe/auth.mjs`, or `/th auth` in Claude Code.
   - The Core expects the password as `hex(SHA512(SHA512(password + salt)))`. The salt is a string constant in the class `TapHome.Core.Lib.Password` of the app's `TapHome.Core.Lib.Common.dll`.
   - `auth.mjs` finds the installed app (`Get-AppxPackage TapHome.TapHome`) and reads the constant straight from the assembly's .NET metadata; no decompiler is needed. It then logs in once with your user, and only if that works does it write `passwordSalt` to `config.json`. The salt is never printed.
   - On a machine without the app (macOS, Linux), copy `TapHome.Core.Lib.Common.dll` from a Windows install (the `TapHome.Client.Desktop.Wpf` folder of the package), then run `node probe/auth.mjs <path to the dll>`.
   - The login's session is stored in `.session.json`, next to `config.json`. The tools reuse it instead of logging in on every run, and they log in again by themselves when the Core rejects it. `node probe/auth.mjs status` checks the stored session without using the password. `node probe/auth.mjs logout` forgets it. `NO_SESSION=1` makes a tool log in fresh.
3. **Test it** with a read-only dump:
   ```
   node probe/dump.mjs      # -> out/reconnect.json, the full configuration
   node probe/export.mjs    # -> out/config/, readable files
   ```

**When TapHome updates the protocol** (a new Core and app version that the committed schema doesn't decode), regenerate the schema from the new app:
1. Decompile the model assembly. With `-p`, ILSpy writes one folder per namespace, which is the layout `build-schema.mjs` expects:
   ```
   ilspycmd -p -o <dir>/TapHome.Core.Lib.Model TapHome.Core.Lib.Model.dll
   ```
2. Set `modelDir`, then run `node probe/build-schema.mjs`. It prints which classes, enums and tags changed.
3. Check the result with `node probe/roundtrip.mjs reconnect`.

Don't commit the decompiled folder. The client assembly (`TapHome.Client.Desktop.Wpf`) is worth decompiling too when you research a new write, because it shows exactly how the app builds each request.

`config.json`, `.session.json`, `out/` and `site-notes.md` are gitignored. Never commit them: `config.json` holds the credentials, `.session.json` holds the session id, and `out/` holds module passwords from the Core's configuration. The tools also write a random client id to `probe/device-id.txt` once, so the Core sees one stable client device.

## Using it with Claude Code

The repository includes a Claude Code skill in [.claude/skills/th/](.claude/skills/th/SKILL.md). It teaches Claude which tool to use for which question, the request formats, and a safety routine: Claude researches and dry-runs a change, then presents a plan and waits for your approval before anything is written.

- **In this repository:** open Claude Code in the clone; the skill is available automatically.
- **From any folder:** copy (or link) `.claude/skills/th` to `~/.claude/skills/`, and set the environment variable `TAPHOME_CORE_WS` to the clone's path so the skill can find the tools.

Facts about your own installation belong in `site-notes.md` in the clone root (gitignored). The skill reads it and adds to it. Examples: which devices are safe to test with, which modules must never be touched, and where your backups are.

An example of various Claude Code interactions in VS Code

<table>
<tr>
<th><code>/th auth</code></th>
<th><code>/th Turn on the light in the kitchen</code></th>
<th><code>/th Add a smart rule to button 2.13 that toggles the room's light</code></th>
</tr>
<tr>
<td valign="top"><img width="455" height="1074" alt="/th auth in VS Code" src="https://github.com/user-attachments/assets/2ca17da8-b7f0-4cee-9852-461a13616a50" /></td>
<td valign="top"><img width="459" height="1112" alt="/th turning on the kitchen light in VS Code" src="https://github.com/user-attachments/assets/d882b67d-e641-483b-9476-a89f4aae5594" /></td>
<td valign="top"><img width="448" height="1873" alt="/th adding a smart rule in VS Code" src="https://github.com/user-attachments/assets/3b4c4e33-0bcc-48b6-a9c2-cab8c7d6f775" /></td>
</tr>
</table>



## Tools

All tools live in `probe/` and read `config.json`. Run them from the clone root.

| Tool | Purpose |
|---|---|
| `auth.mjs [dll]` / `status` / `logout` | read the password salt from the TapHome app, check it with one login, save it to `config.json` and store the session; check or forget the stored session |
| `dump.mjs` | full configuration → `out/reconnect.json` (+ raw `reconnect.bin`) |
| `export.mjs` | `out/reconnect.json` → readable files in `out/config/` (offline) |
| `ask.mjs '<json>'` | send any single request and print the decoded reply; read-only unless `--write` |
| `control.mjs <device> …` | device commands, the way the app sends them |
| `rule-edit.mjs pull\|push\|restore <rule>` | edit a smart rule as JSON, with checks and undo |
| `rules-write.mjs` | create, rename and delete smart rules (`TEST …` names only) |
| `devices-write.mjs` | create, rename and delete virtual devices and variables (`TEST …` names only) |
| `media.mjs` | media library: list, download, upload and delete (`TEST …` names only) |
| `modbus-health.mjs [hours]` | Modbus register health report |
| `listen.mjs [seconds]` | listen-only session that prints what the Core broadcasts |
| `roundtrip.mjs rules\|reconnect` | offline encoder check: decode, encode, compare bytes |
| `build-schema.mjs [modelDir]` | regenerate `schema/taphome-schema.json` from a decompiled `TapHome.Core.Lib.Model` |

Environment variables:
- `MODE=cloud` logs in with the TapHome account.
- `CORE_IP` overrides `host`.
- `FRAMES=1` logs every WebSocket frame.
- `NO_SESSION=1` ignores the stored session and logs in.
- `DRY=1` (`ask`, `control`) prints the encoded frame without connecting.

## Safety

Everything in this README was tested against a real Core, mostly on throwaway objects named `TEST …` that were deleted afterwards. A routine that kept every test reversible:

1. Find out how the app does it in the decompiled client, and send exactly what the app sends.
2. Dry-run the encoding (`DRY=1`, `rule-edit push` without `--send`) and check that it decodes back to what you meant.
3. Save `out/reconnect.json` before the first write.
4. Send one step at a time and check each reply (`ErrorCode` 1 = Ok, `ResponseFlags` 1 = Handled).
5. Dump again and diff devices, rules, dashboards and interfaces against the saved copy.

Don't experiment with:
- firmware updates, and Core restart, reset, restore, clone or update
- network settings, users and passwords
- the exposed TapHome API devices that other integrations rely on
- access-card links
- raw Modbus/HTTP transactions
- blind calibration (it moves the blinds)
- the terminal configuration of a TapHome Bus module whose devices are in use (see [TapHome Bus modules](#taphome-bus-modules-terminal-configuration))

## Status

Tested with Core `2025.2.32396` (protocol 89, about 580 devices):

| Step | Local user | Cloud account |
|---|---|---|
| `/Identify` → LocationId | ok | ok |
| `MessageLoginRequest` → `LoginResult` | Ok | Ok |
| Reconnect #1 (empty DbHash) | FaultyStorageClient (expected) | FaultyStorageClient (expected) |
| Reconnect #2 with returned DbHash | Ok, full config | Ok, full config |
| Live broadcasts | ~15 value changes/s | same |

## Protocol in one screen

- `ws://<core>/Core`, port 80, no TLS, no headers, no sub-protocol. The server is websocket-sharp.
- One binary message = one protobuf-net `MessageBase`. The subtype is nested under its `ProtoInclude` tag (e.g. 108 login, 110 reconnect, 107 value broadcast) and written **before** `RequestsId` (field 1). A Guid is a bcl.Guid `{fixed64 lo=1, fixed64 hi=2}` in .NET byte order.
- The Core fragments large messages into 1016-byte frames, which have to be reassembled.
- **Auth:** the secret is the local password. For a cloud account it is the per-location `authorizationToken` from `POST https://cloudapi.taphome.com/api/user/login2` (a lowercase Guid). It is sent as `hex(SHA512(SHA512(secret + salt)))`; see [Setup](#setup) for the salt.
- **Flow:**
  1. `/Identify` returns one frame, `LocationInfo`.
  2. A throwaway `/Core` socket sends `MessageLoginRequest` (`RequestsId` 0, `IsLocalAccount`, `ServerClientDeviceId` 0, `ClientProtocolVersion` 89) and gets a `SessionId` back.
  3. A new `/Core` socket sends `MessageReconnectRequest` (`RequestsId` 1). A fresh client gets result 4 plus the Core's `DbHash` (response field 37).
  4. Repeat the reconnect with that `DbHash` (request field 24) → result 1.
- **Keepalive:** every 4 s, ack every received non-ack, non-stream message with `MessageReceiveAcknowledgement` (tag 100, repeated int64 `stamp = MessageType << 32 | RequestsId`). Send a WebSocket ping every 6 s.
- `MessageContainer` (tag 383, field 1 = repeated serialized `MessageBase`) carries most broadcasts. Ack the container, not its children.
- **Value change:** `MessageDeviceValueChangedBroadcast` (107) = `DeviceId`(1), `ValueTypeId`(2), `Value`(3, double).
- **Control:** `MessageDeviceAction` (101) = `DeviceId`, `DeviceName`, `Action` key, typed `ProtoParameters`. See [Writing values](#writing-values-device-control).

## Gotcha: Node's built-in `WebSocket` does not work

Sending the identical reconnect frame through Node 24's built-in `WebSocket` (undici) makes the Core close with `1007 Invalid message received (a3)` right after it acks the request. The same bytes over the raw-socket client in `probe/rawws.mjs` (header, mask and payload in one `write`) work every time. The cause is not pinned down; use `rawws.mjs`, or verify another library against the Core first.

## Reading the whole configuration

There is no "list devices" request. The successful `MessageReconnectResponse` (several hundred kB) **is** the full configuration:
- interfaces (`Ccus`)
- all devices, with properties and current values
- dashboard sets and dashboards (zones, categories, dashboards)
- smart rules, as serialized blobs
- permissions and Core properties

After that the Core pushes deltas: `MessageDeviceValueChangedBroadcast`, `MessageDeviceUpdatedBroadcast`, `MessageDeviceListUpdatedBroadcast` and the dashboard broadcasts.

`probe/schema.mjs` decodes any message into named JSON, using the schema in `schema/taphome-schema.json`. The schema holds about 830 `[ProtoContract]` classes, 150 enums and the message tag map. `build-schema.mjs` builds it by parsing the decompiled `TapHome.Core.Lib.Model` sources. The rules it implements:
- **Root-first inheritance:** a `GenericDevice` is written as `DeviceBase` fields, with the `GenericDevice` part nested under include tag 100. Always decode from the root of the `ProtoInclude` chain.
- A collection used as a map value or a list element is wrapped in one more message (field 1).
- Guid, DateTime and TimeSpan use the protobuf-net bcl encodings; enums decode to their names.

Where things live:

| What | Where |
|---|---|
| Interface (TapHome Bus, Packet Parser, Modbus RTU, …) | `Ccus[]`: `CcuId`, `Name`, `Model` (`PacketParserCCU`, `ModbusRtuCCU`, …) |
| Module | a device whose `Model` contains `Module` (`PacketParserModuleHttp`, `ModbusModule`); its children point to it via `HardwareParentId` |
| Device config (scripts, poll interval, IP, min/max, …) | `DeviceProperties`, string→string. Modbus examples: `ReadScript`, `InitializeScript`, `ReadCurrentTemperature`, `WriteDesiredTemperature`, `PrefetchModeId`. Packet Parser examples: `ReadScriptPacketParser`, `IpAddress`, `Port`, … |
| Zones, categories, dashboards | `Dashboards[]` with `DashboardTypeId` 1 / 2 / 0; the order is in `DashboardSets[].DashboardIdsString`; devices reference them by `ZoneId` / `CategoryId` |
| Dashboard layout | `Dashboard.Content` = a serialized `DashboardModel` → sections (`DeviceSectionModel.DeviceIds`, `DashboardSectionModel`, charts, schemes) |
| Built-in names like `${zone_livingRoom}` | translation keys, resolved by `export.mjs` when `translations` is set |

`export.mjs` writes `out/config/`:
- `zones.json`, `categories.json` and `dashboards.json`, each with its devices
- `devices.json`, a flat index
- `interfaces.json` and `core.json`
- `interfaces/<ccu>/<module>/` with `_module.json` and one JSON per device (properties, zone, category, current values). Every script is also saved as its own `.txt` file, so two exports diff cleanly.
- the smart-rule files described below

## Writing values (device control)

The app sends every control as `MessageDeviceAction` (MessageBase include 101, `MessageType.Request`):

| Field | Content |
|---|---|
| 1 `DeviceId` | device ID |
| 2 `DeviceName` | display name (the app fills it in; informational) |
| 3 `Action` | action key, see below |
| 4 `ProtoParameters` | repeated `ProtoParameterBase`; the subtype sits under its include tag and the value in field 1: 100 String, 101 Int, 102 Long, 103 Double, 104 Bool, 105 AlarmMode, 106 ClickKind (1 Normal, 2 Long, 3 Double, 4 Tripple), 107 Guid, … |

The Core replies with `MessageGenericResponse` (102), using the same `RequestsId`:
- **Success:** `ResponseFlags` 1 = Handled, followed by `MessageDeviceValueChangedBroadcast` frames for the device. The broadcast is sent even when the value doesn't change.
- **Failure:** flags 0 with `ErrorCode` 3 and an `ErrorMessage` (the Core's exception text). For example, an unknown key gives "Unknown device action received from App".
- **Value 0:** protobuf-net omits default values, so `0`/`false` is sent as an empty subtype message (e.g. `ba06 00`).

The action key and parameter for each value, as built by the app's `DeviceActionsHelper.GetDeviceKeyAction` / `GetValueToBe`:

| ValueLogType (REST `valueTypeId`) | Action key | Parameter |
|---|---|---|
| SwitchState (48) | `switch` | Bool |
| MultiValueSwitchState (49) | `multi-value-switch` (protocol ≥ 74, else `switch`) | Double (state index) |
| TemperatureSetPoint (6) | `temperature` | Double °C |
| VariableState (62) | `variable-set-value` | Double |
| AnalogOutputValue (42) | `dim-level` | Double 0..1 |
| BlindsLevel (46) / SlideLevel | `blind-level` (slope-capable) / `slide-level` | Double 0..1 |
| BlindsSlope (10) | `blind-slope` | Double 0..1 |
| ButtonPressed (52) | `push-button` | ClickKind |
| ButtonHeldState | `push-button-held` | Bool (start/stop) |
| CorrelatedColorTemperature / HueBrightness | `cct` / `hue-brightness` | Double |
| AlarmMode | `alarm` | AlarmMode |

The app sends other keys too:
- blinds: `blind-force-up-for-time` / `blind-force-down-for-time` (UInt16 ms, Bool), `blind-force-{up,down}-indefinetely-{start,stop}`, `blind-start-calibration-{up,down}`, `blind-start-hardware-calibration`, `blind-declare-current-position-as`, `blind-alarm-stop`
- light colour: `hue-value`, `hue-value-and-state`, `cct-and-brightness`
- other: `calibrate-co2-sensor`, `module-identification-{start,stop}`, `module-led-{start,stop}`

`MessageTapHomeApiSetDeviceValueRequest` (a `{ValueLogType: double}` map, include 101 of `MessageDeviceAction`) exists, but the Core rejects it from an app session with "Unknown device action". `control.mjs set` instead maps a ValueLogType to the matching action key, the way the app does.

```
node probe/control.mjs <deviceId> set VariableState=1      # REST-style: by ValueLogType name or id
node probe/control.mjs <deviceId> switch true               # raw action key + typed parameters
node probe/control.mjs <deviceId> push-button long
DRY=1 node probe/control.mjs <deviceId> set 48=1            # print the frame only
```

Tested on a virtual variable with no smart rules (its current value written back) and on a TapHome Bus light (switched off and on again). Each time the Core answered Handled after about 250 ms, and the value broadcast followed about 50 ms later.

## Smart rules

`MessageReconnectResponse.SmartRules` (field 35) is a list of serialized `TriggerModel` blobs; the app decodes each one with `ProtobufSerializer.Deserialize<TriggerModel>`. Some are `IsDeleted` tombstones, which the app hides; the Core reuses their ids for new rules.

`TriggerModel` fields:

| Field | Content |
|---|---|
| 1 `Id` | rule id |
| 2 `TriggerTypeId` | type, enum `TriggerType` |
| 3 `Name` | name |
| 4 `Version` | format version (from the reconnect's `TriggerVersions[typeId]`) |
| 5 `IsEnabled` | enabled flag |
| 6 `IsDeleted` | tombstone flag |
| 7 `ChangesetId` | changeset |
| 8–11 limiting condition | `LimitingConditionTypeId`, version, enabled flag, `LimitingConditionParameters` |
| 12 `TriggerParameters` | type-specific parameters (`PushButtonTriggerParameters`, …) |
| 13 `TriggerInputs` | devices whose value change wakes the rule (`{ValueLogType: [deviceIds]}`) |
| 14 `LimitingConditionInputs` | devices the condition reads |
| 15 `Priorities` | `{outputDeviceId: priority}`: the devices the rule writes to |

**Limiting condition.** Any rule type can have one. The rule acts only while the condition holds. `LimitingConditionTypeId` (0 = none) picks one of four parameter classes:

| Type | Parameters | Meaning |
|---|---|---|
| 1 Formula | `InputVariables[] {DeviceId, ValueLogType, Abbreviation}`, `EvaluationFormula` | the rule acts while the script returns TRUE |
| 2 Time | `NonLimitingTimeStart`, `NonLimitingTimeEnd` (TimeSpan, may pass midnight) | the rule acts inside the window |
| 3 Multi-value switch | `MultiValueSwitchId`, `IsValue0Limiting` … | blocked at the marked values |
| 4 Switch | `SwitchId`, `IsOffValueLimiting`, `IsOnValueLimiting` | blocked while the switch is in a marked state |

`IsLimitingConditionEnabled` is the condition's "active" toggle in the app. The Core fills `LimitingConditionInputs` itself from the condition's devices, the same way it fills `TriggerInputs`. `export.mjs` lists each condition's variables and full formula in `smartrules.txt`, and gives each device read by a condition the role `condition` in `smartrules-by-device.json`. The encoder reproduces conditions byte for byte, so `rule-edit.mjs` can change one like any other field: the formula, the variables, the time window, or the enabled flag.

Actions are `ActionModel { ActionType (DeviceAction | NotifyAction), Parameters }`:
- `DeviceActionParameters` holds `OutputDeviceId` and `ValueLogTypeValueRequests[]`.
- Each request is `{ ActionType (On, Off, Toggle, SetValue, PerformClick, NextValue, …), ValueLogType, Parameters.DoubleParameters.Value, TimingParameters (PWM pulse, fade, delay), ForceOneTimeOnly }`.

Rule types seen so far, with their main parameters:

| Type | Main parameters |
|---|---|
| PushButton | `PushButtonIds`, `PushActions` (press), `LongPushActions`, `DoubleClickActions`, `TrippleClickActions` |
| PushButtonBlindControl | up/down button ids, blind ids, press type |
| DailySchedule | start/end time (`StartTriggeredBy` can be Sunset), in-period and out-of-period actions |
| Switch | input device, `OnActions` / `OffActions` |
| CountdownTimer | triggering buttons, target device, timeout |
| Access | access reader, granted/denied actions |
| KeepDefaultValues | default actions |
| WeekSchedule | week plan and its actions |
| Evaluation | variables, a formula, true/false actions, min/max duration |
| Script | read-only and read-write variables, script, trigger variables |
| Link | master/slave device ids |
| LightingTimer | motion sensors, brightness threshold, timeouts, per-button press/long/double/triple actions, active time window |
| MultiValueSwitch | `Value0Actions`… per state |
| MultiValueSwitchLightSceneSequence | buttons cycling a multi-value switch through light scenes |
| PushButtonDimming | dimmer ids, up/down buttons, fade timing |

`export.mjs` writes four rule outputs:
- `smartrules.json`: an index of the rules, with inputs, outputs, type and enabled flag.
- `smartrules.txt`: one readable block per rule, e.g. `LongPushActions -> 84 "<device name>": Off SwitchState`.
- `smartrules-by-device.json`: for each device, the rules that read it (input or condition) or write to it (output).
- `smartrules/<id>-<name>.json`: the full decoded rule. Scripts and formulas are also saved as separate `.txt` files.

### Creating, renaming and deleting rules (`probe/rules-write.mjs`)

Source: `ClientCommunicationManager.UpdateSmartRules` and `SmartRuleCommunicationHelper` in the client.

```
node probe/rules-write.mjs create <buttonId> "TEST …"   # a disabled PushButton rule with no actions
node probe/rules-write.mjs rename <ruleId> "TEST …"
node probe/rules-write.mjs delete <ruleId>
```

- **Create or update:** `MessageUpdateTriggerModelsRequest` (299), `TriggerModels` = a list of full `TriggerModel`s. `Id` 0 creates a new rule. When the app duplicates a rule it clears `Priorities` and `TriggerInputs`, so the Core recomputes them.
- **Reply:** `MessageGenericResponse.ErrorCode` 1 = ok, 16 = incompatible smart-rule version.
- **Delete:** `MessageDeleteTriggerModelsRequest` (`TriggerIds`).
- **Afterwards:** the Core broadcasts `MessageTriggerModelsUpdatedBroadcast` (300, blobs + changeset) or `MessageTriggerModelsDeletedBroadcast` (302). Every request is also followed by an unrequested `MessageGetAffectingTriggersInfoResponse`.
- **Simple edits:** the reconnect hands over each rule's original bytes, so a top-level change such as `IsEnabled` (field 5) or `Name` (3) can be patched into the blob and sent back as is.

Test: a disabled rule was created on a push button. It got the id of a deleted tombstone, and the Core filled in its `TriggerInputs`. The rule was then renamed (changeset +2) and deleted, after which it was a tombstone again. `rules-write.mjs` renames or deletes only rules whose name starts with `TEST `. Before sending, it decodes the frame back and aborts if the result differs from what was intended.

### Full rule editing (`probe/rule-edit.mjs`)

`schema.mjs` also has an encoder, `makeEncoder(schema, {strict})`, which is the inverse of the decoder. `probe/roundtrip.mjs` checks it offline: decode, encode, compare bytes. Both of these come back **byte-identical**:
- every rule blob
- the whole reconnect response (all devices, dashboards, everything)

protobuf-net details the encoder has to reproduce:
- **Field order:** the subtype's include path comes first, then each class's own fields in ascending field number.
- **Optional fields:** a field is written only when present. The decoder keeps presence, so absent ≠ zero.
- **Maps:** a map is a repeated `{1 key, 2 value}` entry. When the value is a list or a map, it is written as repeated field 2 with no wrapper (`AggregatedValues` is a map of maps). Dictionaries keep insertion order; the decoder stores it under the `WIRE_ORDER` symbol.
- **Packed lists:** written even when empty (a zero-length field).
- **NaN:** encoded with the .NET bit pattern (`0xFFF8000000000000` for double, `0xFFC00000` for float). A missing humidity reading is NaN, not null.
- **bcl TimeSpan:** uses the largest exact unit; scale 15 means MinValue/MaxValue.
- **Guid:** zero halves are omitted.

```
node probe/rule-edit.mjs pull 20            # -> out/edit/20.json (edit it) + out/edit/20.orig.bin (undo copy)
node probe/rule-edit.mjs push 20            # checks + field diff, sends nothing
node probe/rule-edit.mjs push 20 --send     # store it on the Core
node probe/rule-edit.mjs restore 20 --send  # put the pulled version back
```

`push` refuses to send when:
- the rule on the Core has changed since `pull`
- the JSON has an unknown key (typos like `PushActons` are rejected)
- `Id` or `TriggerTypeId` was changed
- the encoded bytes don't decode back to exactly the edited JSON

It copies the live map order, so unchanged parts stay byte-identical. After sending, it checks the stored copy in the 300 broadcast and reports what the Core derived on its own.

Live test on a throwaway rule for a push button, acting on a light:

| Step | Result |
|---|---|
| create `TEST ws-probe edit (delete me)` with `rules-write.mjs` | Ok |
| add `LongPushActions → <light>: Off SwitchState`, still disabled | Ok, stored exactly as sent. The Core added **`Priorities {<light>: 102}`** itself, the next number after the existing rule's 101 for the same output, so priorities never need to be set by hand |
| set `IsEnabled: true` | Ok, stored exactly as sent |
| long press on the physical button | the light went off. A long press does **not** fire the short-press `PushActions` |
| delete | Ok; all other rule blobs were byte-identical before and after |

How the app writes an action (copy this shape from an existing rule):

```json
{ "ActionType": "DeviceAction", "Parameters": { "$type": "DeviceActionParameters",
  "ValueLogTypeValueRequests": [ { "ActionType": "Off", "ValueLogType": "SwitchState", "Parameters": {}, "ForceOneTimeOnly": true } ],
  "OutputDeviceId": 74 } }
```

`TriggerInputs` stays `ButtonPressed: [<button>]` for long presses too.

## Reading history, logs, script values and rule state (`probe/ask.mjs`)

`ask.mjs` sends any request message given as JSON and prints the decoded reply. It only sends requests whose class name looks read-only (`Get…`, `…History…`, `…Info…`, `…Diagnostics…`, `…Discovery`, `…Download`); anything else needs `--write`. With `DRY=1` it prints the encoded frame without connecting. `WATCH=<s>` keeps listening that long after the reply, and `RAW=1` prints the decoded JSON instead of the pretty form.

```
node probe/ask.mjs '{"$type":"MessageGetDeviceLogRequest","DeviceId":74}'
node probe/ask.mjs @request.json
```

All of these were tested (read-only):

| Request | What it returns |
|---|---|
| `MessageDeviceValueHistoryDataRequest {DeviceId, ValueLogType, ValueAggregation, DateTimeFromUtc, DateTimeToUtc}` | value history. `Container` is a serialized `HistoryItemsContainer`, which `ask.mjs` expands into `[utc, value]` points |
| `MessageGetDeviceLogRequest {DeviceId}` | the device's log (the app's "show all logs"): every value change with its origin and cause |
| `MessageGetScriptLastRunValuesRequest {LastRunId: {ObjectIdType, ObjectId, ScriptKey}}` | the script debugger: every variable at each capture step of the last run, plus the result |
| `MessageGetAffectingTriggersInfoRequest {DeviceId}` | the rules that affect a device, with their current state |
| `MessageGetTriggerErrorsRequest {TriggerId}` | a rule's errors |
| `MessageGetAvailableServiceAttributesAndActionsRequest` / `MessageGetServiceAttributeValuesRequest {ObjectIdTypeId: 0, ObjectId}` | a module's service-settings diagnostics: built-in counters (`d_ScriptStats`, `d_AdapterTaskSuccess`, received data) plus the results of its `ServiceAttributesScripts…` script |

**History.** A device has history only for the values listed in its `EnabledValueAggregations`, i.e. where recording is turned on in the app.
- A temperature typically records raw values plus an `Avg` per hour, day and month.
- `ValueAggregation` is `{StatisticsFunction, PeriodType, Period}`. `{}` means raw values. For hourly averages use `{"StatisticsFunction":"Avg","PeriodType":"CurrentPeriod","Period":"Period1H"}`; `Period1D` and `Period1M` give daily and monthly ones. The functions are CurrentValue, Min, Max, Avg, Count, SumOrIntegral and Derivate.
- Without recording, the reply has no `Container`. `LastHistoryCloudFlushOnTUtc` shows when the Core last pushed data to the cloud.

The Core itself keeps only recent data; the app gets older data from the TapHome cloud. Measured on a temperature sensor:

| Granularity | Kept on the Core |
|---|---|
| raw | ~5 h |
| hourly | ~8 days |
| daily, monthly | 1 year |

Daily buckets start at local midnight. The container format comes from `HistoryItemsSerializer` in `TapHome.Core.Lib.Common`:
- Each session has `StartedOn` (TapHomeTime = seconds since 2016-01-01 UTC), `TimeDifferences[]` (seconds) and exactly one value array.
- `Double`/`Single` values are stored as is. `BitValues` pack on/off values 32 to a `uint`.
- `AbsoluteIntN` is value×N. `RelativeIntN` is `FirstIntValue` plus a running sum of deltas, ×N.
- An int below -8000000 is NaN.
- ILSpy could not decode the `[ProtoMember]` attributes of `HistoryItemsSession`. `schema.mjs` hard-codes the numbers recovered from the IL: fields 4–19, and the ints are ZigZag.

**Device log.** The request returns about the last 40 changes. Each entry is a `ValueChangedDeviceLogEntry` with these fields:
- `TapHomeTime`
- `Values` = `KeyValuePair<ValueLogType,double>[]`
- `ChangeOriginId` = enum `ChangeOrigin`: Manual, App, SmartRule, Startup, Time, …
- `HandlingStatus {LastTriggerId, SourceUserId, FirstDeviceId, FirstAffectedDeviceId, LastAffectedDeviceId}`

`ask.mjs` prints each entry as one line. Examples:
- A button press shows as `[Manual] rule 20, from device 75`: the rule that handled it, and the button.
- An app command shows as `[App] user …`.
- A schedule shows as `[SmartRule] rule 90, from device 1`, where device 1 is the clock.
- A rule that no longer exists is reported as `LastTriggerId -1`.

**Script last-run values.**
- `ObjectIdType` is Device, Ccu or Smartrule. `ScriptKey` is the name of the device property that holds the script, e.g. `ReadTemperatureScriptPacketParser`. Smart rules need no key.
- Values are `DataType`s. `SerializerValueTypeId` is `EDataTypeProtobuf`: 4 Double, 11 Bool, 13 String, …. A number sits in the low bytes of the int64 `SerializerValueBytes`, used as raw memory. Strings and objects come in `ProtoString`.
- Step 0 holds the values before the run (left over from the previous one); the last step holds the values after it. For a Packet Parser weather station, for example, it shows the HTTP response JSON, the parsed value, and the result.

**Affecting rules.** `AffectingTriggerStatus` is one of:
- NoInfo
- Disabled
- ShouldNotEvaluate
- LimitedByCondition: the rule's limiting condition currently blocks it (the app marks it as limited)
- ReturnedNoAction
- ReturnedAction
- ReturnedActionAndActionAplied

They match what the app shows on the device's list of affecting rules. Combined with the device log and the condition formula from `smartrules.txt`, this answers most "why didn't X happen" questions.

## Changing settings

The requests in this section were tested with `ask.mjs … --write`, unless a dedicated tool is named.

### Variables and virtual devices (`probe/devices-write.mjs`)

```
node probe/devices-write.mjs add Variable VirtualVariableGeneral "TEST …"
node probe/devices-write.mjs add PushButton VirtualPushButton "TEST …"
node probe/devices-write.mjs rename <id> "TEST …"
node probe/devices-write.mjs delete <id>
```

Messages:
- `MessageAddDeviceRequest {DeviceName, Interface, Model, DeviceTypeId}` → `MessageAddDeviceResponse {Ccus, AddedDevice}` plus a `MessageDeviceListUpdatedBroadcast`.
- `MessageUpdateDeviceNameRequest {DeviceId, Name}` → ErrorCode 1 plus a `MessageDeviceUpdatedBroadcast`.
- `MessageDeleteDeviceRequest {DeviceId, ForceDelete: true}` → ErrorCode 1 plus a `MessageDeviceListUpdatedBroadcast`. Without `ForceDelete`, a device still in use gives ErrorCode 3.

The app's own lists of interface/model pairs are in `AddVirtualVariableDialog` and `AddVirtualDeviceDialog`:
- `Variable` + `VirtualVariableGeneral`, the time variables (`VirtualVariableHourOfDay`, …) and the sun variables
- `Switch`/`VirtualSwitch`, `MultiValueSwitch`/`VirtualMultiValueSwitch` (+ `DeviceTypeId` for presence, fan, …), `Thermostat`/`VirtualThermostatDummy`, `TemperatureSensor`/`VirtualTemperatureSensor`, …

Safety guards: new names must start with `TEST `. `rename` and `delete` only touch a CCU-1 (virtual) device whose current name starts with `TEST `.

In the test, the new variable appeared after 0.8 s with no zone or category and `VariableState` 0. `control.mjs <id> set VariableState=5` was Handled, and the app showed 5. The Core gave a new virtual push button an icon by itself, and pressing it was Handled. After both were deleted, every other device, rule, interface and dashboard was identical.

### Device properties (zone, category, …)

`MessageUpdateDevicePropertiesRequest {DeviceId, DeviceName, DeviceProperties: {"ZoneId": "<guid>"}}`. Send **only the changed keys**, as the app's `GetChangedDeviceProperties()` does. A new device starts with no zone or category; the app opens its settings right after adding it, and this request is the equivalent. Moving a device into a static zone (type 1, such as the whole-house zone) also changes that zone's stored content.

Script properties can be changed the same way, but a bad script breaks a real device. That was not tested.

### Value history on or off

`MessageToggleHistoryForDeviceValueTypeRequest {DeviceId, ValueLogType, ValueAggregation: {} (instant), HistoryShouldBeOn}`. This is the history switch on a device's statistics page in the app.

Tested on a Packet Parser temperature sensor that had no recording:
- The Core replied ErrorCode 1 "Ok" and sent a `MessageDeviceUpdatedBroadcast`.
- It created the raw history plus hourly, daily and monthly `Avg` aggregations by itself, the same set as other temperature sensors have.
- Only that device changed; rules, interfaces and dashboards were identical.
- The first raw point was readable right away. Points are stored when the value changes.

`HistoryShouldBeOn: false` turns it off again. `MessageToggleAggregationForDeviceValueTypeRequest {…, AggregationShouldBeOn}` switches a single aggregation (not tried).

### Manual override

`MessageSetDeviceManualOverrideStateRequest {DeviceId, DeviceName, ActivateManualOverride}`: Ok for both on and off, each with a `DeviceUpdated` broadcast.

### Zones and date periods

| Request | Result |
|---|---|
| `MessageAddDashboardRequest {DashboardId (new Guid), Name, AccentColorId, Version: 1, DashboardTypeId: 3, Content: "", IconId}` | Ok, with a `MessageDashboardUpdatedBroadcast`. This is the app's "add zone": type 3 = `DynamicZoneDashboard`, and the content is an empty `DashboardModel`, which is 0 bytes. Sent this way (the app's "save only" mode), the zone is not added to any `DashboardSet`, so the app lists it under "other" and the favourites order is untouched; the app's favourites variants also send `UpdateDashboardSet` |
| `MessageUpdateDashboardPropertiesRequest {DashboardId, Properties: {Name}}` | Ok |
| `MessageDeleteDashboardRequest {DashboardId}` | Ok, with a `MessageDashboardDeletedBroadcast`. The zone stays in `Dashboards` as a tombstone (`DeletedOnTUtc`, `DeletedByUserId`), like zones deleted in the app |
| `MessageAddDateRangeRequest {DateRange: {Name}}` | `MessageAddDateRangeResponse` with the new `Id` |
| `MessageRemoveDateRangeRequest {DateRangeIds}` | Ok |

Editing dashboard content was not tried.

### Data exports

| Request | Result |
|---|---|
| `MessageCreateUpdateDataExportProfileRequest {DataExportProfile: {Id, Name, Version: 1, ProfileTypeId: 0, SerializedConfig}, CreateMissingDeviceValueAggregations}` | The **`Id` must be set by the client**, as the app does with `Guid.NewGuid()`; without it the Core answers "Invalid id." (ErrorCode 6). The reply is `MessageCreateUpdateDataExportProfileResponse {UrlChange, …}`: the Core spends a few seconds registering a TapHome cloud download URL for the profile, which disappears again with the delete |
| `SerializedConfig` | a serialized `DeviceValueExportProfileConfig {PeriodId (ValueHistoryPeriod), Columns [{ValueLogTypeId, StatisticsFunctionId, DeviceId}], FileTypeId (2 = JSON), QueryPeriodSelectionId, QueryPeriodId, QueryTimeUnits, AutoExecPeriodId?, AutoExecDay, AutoExecMonth}`. Example: `{"PeriodId":30,"Columns":[{"ValueLogTypeId":5,"StatisticsFunctionId":3,"DeviceId":<sensor>}],"FileTypeId":2,"QueryPeriodSelectionId":1,"QueryPeriodId":45,"QueryTimeUnits":1,"AutoExecDay":1,"AutoExecMonth":1}` gives hourly temperature averages over the last day. With no `AutoExecPeriodId` the profile never runs automatically. Access logs use `AccessLogExportProfileConfig` (`ProfileTypeId` 1) |
| `MessageExecuteNowDataExportProfileRequest {Id}` | `{SessionId, FinalSize, Buffer, Md5Hash}`. A small result arrives whole; larger ones continue with `MessageGetDataExportProfileResultDataChunkRequest {Id, SessionId, Position, BufferSize}`. The result was identical to the file downloaded from the app |
| `MessageGetStoredDataExportProfileResultRequest {Id, BufferSize}` (read-only) | the result of the last automatic run |
| `MessageDeleteDataExportProfileRequest {ProfileIds}` | Ok |

### Media library (`probe/media.mjs`)

```
node probe/media.mjs list                  # items with purpose, type, size, name, upload time
node probe/media.mjs get <id> [outDir]      # download (default out/media/), checked by size
node probe/media.mjs put <file.png|webp> "TEST …" [purpose=2]
node probe/media.mjs delete <id>            # only items whose name starts with TEST
```

- **Purposes:** `MediaPurpose` 0 Unknown, 1 DashboardBackground, 2 SchemeBackground. The app converts images to WebP before uploading.
- **Download:** `MessageMediaDownloadRequest {Id, Position, BufferSize}` returns the metadata (`OriginalMediaName`, `MediaType`, `Thumbnail`, `FinalSize`, …) and one chunk. The Core sends **at most 4096 B per chunk**, whatever `BufferSize` asks for, and **no `Md5Hash`**.
- **Upload:** `MessageMediaUploadRequest`, as the app sends it:
  1. a metadata message (`Id`, a new Guid; `MediaPurposeId`, `OriginalMediaName`, `MediaType`, `Thumbnail`, `ThumbnailType`, `FinalSize`, `Position: 0`, no `Buffer`)
  2. 80 000-byte chunks with `Position` and `Buffer`

  Every message carries the MD5 of the whole file. ErrorCode 27 means not enough space.
- **Delete:** `MessageDeleteMediaRequest {MediaIds}`.

In the test, a small PNG uploaded with "Ok" for both messages and appeared in the app's media library with its thumbnail. Downloading it returned the file byte-identical, and the delete restored the library's used space.

### Access-control week plans

Reading:
- `MessageGetWeekPlansRequest` → `WeekPlan[] {Id, Name, Priority, ValidFromTUtc, ValidToTUtc}`. These are .NET ticks: `ValidToTUtc` 3155378975999999999 = `DateTime.MaxValue`, which the app shows as unlimited.
- `MessageGetWeekPlanProperties {WeekPlanId: [ids]}` (no `Request` suffix) → `WeekPlanProperty[] {PlanId, WeekDay, StartTime, EndTime}`, with the times in seconds of the day. The default 24/7 plan is `WeekDay` 127, 0–86400 s.
- `MessageGetWeekPlanDateRangeRequest {WeekPlanIds}` → the date periods allowed or forbidden for each plan.

**`WeekDay` is a bit mask by .NET `DayOfWeek`:** bit 0 = Sunday, bit 1 = Monday, … bit 6 = Saturday. So 62 = weekdays, 65 = weekend and 127 = every day (`AccessHelper.GetDaysDescription`).

Writing, tested on a plan that was not linked to any card and was deleted afterwards:

| Request | Result |
|---|---|
| `MessageAddWeekPlanRequest {WeekPlan: {Name, Priority: 0, ValidFrom min, ValidTo max}}` | `MessageAddWeekPlanResponse` with the new `Id` |
| `MessageUpdateWeekPlanRequest {WeekPlan, AddProperties / RemoveProperties / UpdateProperties: [WeekPlanProperty]}` | Ok |
| `MessageDeleteWeekPlanRequest {WeekPlan}` | Ok; the plan's slots are removed with it |

Linking plans to cards and readers (`MessageAddWeekPlanAndCardRequest` / `…Update…` / `…Delete…`) was not tried, because it changes who gets in.

### Which changes the Core broadcasts

This was checked with a second, listen-only session (`probe/listen.mjs`) running during the writes. Other clients only stay in sync for the broadcast changes:

| Broadcast to all sessions | Silent |
|---|---|
| device create and delete (`DeviceListUpdated`) | export profiles (create, run, delete) |
| device rename, manual override, zone change (`DeviceUpdated`, plus `DashboardContentUpdated` for a static zone) | week plans, delete included |
| zone create (`DashboardUpdated`) and delete (`DashboardDeleted`) | media upload |
| media delete (`MediaDeleted`) | zone rename, and a move into a dynamic zone: nothing reached the writing session within 2 s |
| rule changes (300 / 302) | |
| bus terminal configuration (`DeviceListUpdated`) | |

Date periods were not checked. The app also doesn't redraw some lists by itself (the zone list, access control), so leaving and reopening the page is the reliable check.

## TapHome Bus modules: terminal configuration

The app configures a bus module (DO12, UI32, UI2, …) with one request: `MessageTapHomeBusConfigRequest {DeviceId: <module>, ConfigJson}`. `ConfigJson` is a JSON `TapHomeBusModuleConfig` (a class in `TapHome.Core.Lib.Common`) that lists the module's **complete** desired terminal configuration:

```json
{"Devices":[{"Index":1,"Type":"Reed","ExtraAttributes":{"DeviceName":"…","DeviceZoneId":"<guid>","DeviceCategoryId":"<guid>","TerminalType":"UI"}}]}
```

- **Types:** `Switch`, `SwitchOnUO`, `Blind`, `EncoderBlind`, `PushButton`, `Reed`, `ImpulseCounter`, `Thermometer`, `AnalogInput`/`AnalogOutput`, `Dimmer`, `LedDimmer`, `RGB`, `TunableWhite`, `Slide`, `WG` (Wiegand), …
- **Terminal types:** `DO`, `DI`, `UI`, `UO`, `AO`, `NTC`.
- **Extra attributes:** `TapHomeBusModuleConfigurationPage.ExportConfig` in the client shows which types need more: blind terminals (`TerminalUp`/`TerminalDown`), RGB outputs, PWM groups, state names and icons, `DeviceTypeProperties`.
- **Reply:** `MessageTapHomeBusConfigResponse {AddedDevices, RemovedDevices}` after about 1 s, and the Core writes the configuration to the module.

**The Core diffs the list against the module's terminal devices.** New entries become devices, and **terminal devices missing from the list are removed**, together with their history and their place in rules. A client must therefore rebuild the current list exactly and change only what it means to.

**Rebuilding the current list.** A device's serial number encodes its terminal: `<module serial>:<Type>-<terminal type>-<index>`. For example, `DO12-…:Switch-DO-3` is a switch on output DO 3. `HardwareParentId` is not reliable (it can be 0), so use the serial prefix to find a module's devices.

**Sensor ports are not in the list.** Some modules have external sensor connectors (a TWI bus: `TapHomeBusTHTwiSensor`, `TapHomeBusCo2Sensor`), and some have internal sensors. These appear as devices with serials ending in `-EXT` or `-INT`, e.g. `…:THSensor-EXT` or `…:Co2-EXT`. The app never creates them through the terminal configuration; they appear when the Core detects a connected sensor. The app only handles them when replacing a module (`TapHomeBusModuleReplacePage`), where it moves them to the new module or deletes them. Leaving them out of the list removes nothing.

| Module | EXT connectors |
|---|---|
| 2UI (UI2) | 2 |
| 6UI | 2 |
| 6UI/6UO | 2 |
| UI4DO2 | 1 |
| W2DI2DO2 | 0 |

A UI2's terminals are +24V/GND, bus A/B, UI1/GND and UI2/GND, plus the two EXT connectors.

Live test on a UI2 that had no terminal devices, only a sensor on its EXT port:

| Step | Result |
|---|---|
| device action `module-led-start` / `module-led-stop` on the module | Handled. This is the app's module identification (the LED blinks) |
| config `{Devices: [{Index 1, Reed, "TEST …", UI}]}` | after about 1 s, `AddedDevices` = one `TapHomeBusReedContact` with serial `…:Reed-UI-1`; nothing removed. The EXT sensor stayed. The app showed it as UI1 on the module page |
| config `{Devices: []}` | `RemovedDevices` = only that reed contact |
| fresh reconnect | no configuration changes, the module and its sensor included; rules, dashboards and interfaces identical |

`{AddModules: [serial]}` with `CcuId` adds a new module (not tried).

**Bus module health.**
- `MessageGetModuleInfoRequest {ModuleId}` makes a module report `MessageGetModuleVccAndTemperatureBroadcast {DeviceId, Vcc, Temperature, Vcc24}` (mV, °C × 100, mV), the same values as the app's module page. Modules don't reliably send these by themselves, so ask each module and catch the broadcasts (`WATCH=<s>` or `listen.mjs`).
- A module's service attributes also show its reset flags and communication counters (CRC errors, timeouts).
- `MessageGetAllModulesInfoRequest {CcuId}` returns every module's uptime in ms, as a `MessageGetAllModulesUptimeBroadcast`.
- `MessageGetModulesBoardHwRevisionRequest {ModuleIds}` returns the board revisions.

Not tried: firmware updates (`MessageUpdateModuleFirmwareRequest`), blind and presence calibration, bus scanning, module replacement, and changing a module that is in use.

## Modbus health (`probe/modbus-health.mjs`)

`node probe/modbus-health.mjs [hours=24]` is read-only. It is built on `MessageModbusRegistersInfoRequest {DeviceId: <Modbus module>}`, which returns, per register, the devices that use it, the last successful and the last failed transaction, and the response time. For each Modbus module the report shows:
- the register count, the last good read, and the average and maximum response time
- overdue registers: no good read for 3× the poll interval (`InternalPollInterval`) of the devices using them
- the last failed read or write of each register within the window, with its cause and the devices involved

The cause is one of three things:
- `CommunicationErrorMessage`, e.g. `CRCError` or `ModbusTransportException`
- the slave's Modbus exception (`Response.ExceptionMessage`, e.g. `IllegalDataAddress`)
- no response at all

The Core keeps only the **last** failure per register, so the report shows how recent the problems are, not how many there were. For one module type (a Systemair SAVE VTC 700), the Core itself throws a `NullReferenceException` when asked for its register info, a Core bug in `ModuleApiAdapter.FillRegisterInfo`.

## Settings pages (read side)

| App page | Source |
|---|---|
| My profile | reconnect `UserInfo` (the logged-in user) |
| All users | `MessageGetUsersListRequest` → `Users[] {Id, Login, Email, FullName, Permissions, IsLocalAccount, …}`, both TapHome accounts and local users. Group names are in the reconnect's `UserGroups` (-1 user, -2 admin, -3 service). The change history is in `MessageGetUserManagementLogRequest` |
| My location: information, attributes, network | `MessageGetBasicCorePropertiesRequest`, name/value pairs: Name, Latitude, Longitude, Version, Core process uptime, TimeZoneId, OS Image Version, Hardware Platform, Current Time, LanguageCode, Runtimes, mDNSName, Currency, CurrencyPositionId, DHCP, IpAddress, NetworkMask, Gateway, DNSServer, MACAddress. The reconnect's `CoreProperties` has only the first 10 |
| My location: date periods | `MessageGetDateRangesRequest` |
| My location: media library | `MessageGetMediaListRequest` → media ids, total and used space |
| Hardware | reconnect `Ccus` + devices; exported to `out/config/interfaces/` |
| Virtual devices, variables | devices on CCU 1 "Virtual devices" (`Virtual*` models) |
| Exposed devices | `MessageGetSlaveInterfacesRequest` → the "TapHome API" interface; its devices come from `MessageGetSlaveInterfaceDevicesRequest` |
| Access control | `MessageGetAccessCardsRequest` (cards), `MessageGetAccessLogsRequest {FromUtc, ToUtc}` (access log), `MessageGetWeekPlansAndCardsRequest {DeviceId, CardId, PlanId}` (empty without ids). The card readers are devices |
| Exports | `MessageGetDataExportProfilesRequest` → profiles with `SerializedConfig` (decodes as `DeviceValueExportProfileConfig`) |

More read-only requests that work:

| Request | Returns |
|---|---|
| `MessageGetCurrentConnectionsRequest` | connected app sessions (user, client device, LAN or tunnel) and the cloud tunnel connections |
| `MessageGetModuleInfoRequest {ModuleId}` | arrives as `MessageGetModuleUptimeBroadcast`: one module's uptime |
| `MessageGetDeviceErrorsRequest {DeviceId}` | the device's error list (some modules answer "Doesn't support new device errors") |
| `MessageGetUsedTcpPortsRequest`, `MessageGetAvailableCcuPortsRequest` | TCP ports in use, serial ports available for interfaces |

These replied with an error: `MessageGetModuleDiagnosticsDataRequest` ("Module does not support diagnostics data" on a DO12) and `MessageGetImageDataRequest` ("No image data available" for a doorbell camera). `MessageTapHomeApiGetDeviceValueRequest` got no reply; it probably serves only the exposed-devices (TapHome API) path.

Not touched, because they change or endanger the Core: backup creation and download (`MessageBackupCoreRequest`, `MessageBackupDownloadRequest`), restore, cloning, factory reset, restart (`MessageRestartCoreRequest`), Core update, and writing network settings.

## Schema notes

The round trips stay byte-identical with these fixes:
- A property whose `{` is on the next line used to be skipped. That lost fields in 10 classes, e.g. `ScriptLastRunValues.ValuesParameter`, `DataType.*` and the service-attribute messages.
- `KeyValuePair<K,V>` is a `{1 Key, 2 Value}` message.
- `HistoryItemsSession` uses hard-coded field numbers (see History). `build-schema.mjs` adds them, so they are in the committed schema.
