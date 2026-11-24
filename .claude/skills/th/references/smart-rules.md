# Smart rules

## Where they are

`MessageReconnectResponse.SmartRules` is a list of serialized `TriggerModel` blobs (base64 in `out/reconnect.json`). Decode each one with `dec.message(buf, 'TriggerModel')`. Some are `IsDeleted` tombstones: the app hides them, and the Core reuses their ids for new rules.

`export.mjs` writes:
- `smartrules.txt`: one readable block per rule, e.g. `LongPushActions -> <id> "<device>": Off SwitchState`, plus the condition with its variables and full formula
- `smartrules.json`: an index of the rules
- `smartrules-by-device.json`: for each device, the rules where it is an input, a condition or an output
- `smartrules/<id>-<name>.json`: the full decoded rule; scripts and formulas are also saved as `.txt`

## `TriggerModel` fields

| Field | Content |
|---|---|
| 1 `Id`, 2 `TriggerTypeId`, 3 `Name`, 4 `Version`, 5 `IsEnabled`, 6 `IsDeleted`, 7 `ChangesetId` | `Version` comes from the reconnect's `TriggerVersions[typeId]` |
| 8–11 limiting condition | `LimitingConditionTypeId`, version, `IsLimitingConditionEnabled` (the condition's "active" toggle), `LimitingConditionParameters` |
| 12 `TriggerParameters` | type-specific, e.g. `PushButtonTriggerParameters {PushButtonIds, PushActions, LongPushActions, DoubleClickActions, TrippleClickActions}` |
| 13 `TriggerInputs` | devices whose change wakes the rule. **Filled in by the Core** |
| 14 `LimitingConditionInputs` | devices the condition reads. **Filled in by the Core** |
| 15 `Priorities` | `{outputDeviceId: priority}`. **Filled in by the Core** for new outputs, e.g. 102 when another rule already has 101 for the same output |

## Limiting conditions

A rule acts only while its condition holds.

| `LimitingConditionTypeId` | Parameters | Meaning |
|---|---|---|
| 1 Formula | `InputVariables[] {DeviceId, ValueLogType, Abbreviation}`, `EvaluationFormula` | the rule acts while the formula returns TRUE |
| 2 Time | `NonLimitingTimeStart`, `NonLimitingTimeEnd` (TimeSpan; may pass midnight) | the rule acts inside the window |
| 3 Multi-value switch | `MultiValueSwitchId`, `IsValue0Limiting`, … | blocked at the marked values |
| 4 Switch | `SwitchId`, `IsOffValueLimiting`, `IsOnValueLimiting` | blocked in the marked state |

A typical pattern: several rules drive the same output, each gated by a formula on a mode or presence device, so that exactly one of them is unblocked at a time. The live status (`LimitedByCondition`) comes from `MessageGetAffectingTriggersInfoRequest` (see reading.md). Read each formula in `smartrules.txt` and compare it with the input devices' current values.

## Actions

`ActionModel {ActionType: DeviceAction | NotifyAction, Parameters}`. A device action, written the way the app writes it (copy this shape):

```json
{ "ActionType": "DeviceAction", "Parameters": { "$type": "DeviceActionParameters",
  "ValueLogTypeValueRequests": [ { "ActionType": "Off", "ValueLogType": "SwitchState", "Parameters": {}, "ForceOneTimeOnly": true } ],
  "OutputDeviceId": 74 } }
```

- **Request `ActionType` values:** `On`, `Off`, `Toggle`, `SetValue` (with `Parameters.DoubleParameters.Value`), `PerformClick`, `NextValue`, ….
- **`TimingParameters`** hold the PWM pulse, fade and delay.
- **When unsure,** copy from an existing rule in `out/config/smartrules/` that does something similar.

Rule types seen so far:
- PushButton
- PushButtonBlindControl
- DailySchedule (the start can be Sunset)
- Switch (`OnActions`/`OffActions`)
- CountdownTimer, Access, KeepDefaultValues, WeekSchedule
- Evaluation (a formula with true/false actions)
- Script, Link, LightingTimer, MultiValueSwitch, MultiValueSwitchLightSceneSequence, PushButtonDimming

Behaviour verified live:
- A long press does **not** fire the short-press `PushActions`.
- `TriggerInputs` stays `ButtonPressed: [button]` for long presses too.

## Editing an existing rule (`rule-edit.mjs`)

```
node probe/rule-edit.mjs pull <id>            # -> out/edit/<id>.json (edit this) + out/edit/<id>.orig.bin (undo copy)
node probe/rule-edit.mjs push <id>            # dry: field diff live -> edited, sends nothing
node probe/rule-edit.mjs push <id> --send     # store it (only after the user approved the plan)
node probe/rule-edit.mjs restore <id> --send  # put the pulled version back
```

`push` refuses to send when:
- the live rule changed since the pull (pull again)
- the JSON has an unknown key
- `Id` or `TriggerTypeId` changed
- the bytes don't decode back to exactly the edited JSON

It copies the live map order, so unchanged parts stay byte-identical. After sending, it checks the stored copy in the 300 broadcast and reports what the Core derived (Priorities, TriggerInputs) and the ChangesetId.

## Creating, renaming and deleting rules

- **Create/update** is `MessageUpdateTriggerModelsRequest` (299) `{1: [TriggerModel bytes]}`; `Id` 0 creates. The reply's `ErrorCode` is 1 for ok and 16 for an incompatible smart-rule version. The broadcast is 300 (blobs + changeset).
- **Delete** is `MessageDeleteTriggerModelsRequest` (301) `{TriggerIds}`; the broadcast is 302.
- **`rules-write.mjs create <buttonId> "TEST …"`** creates a **disabled** PushButton rule with no actions. `rename` and `delete` only touch rules named `TEST …`.
- **Simple top-level changes** such as `IsEnabled` or `Name` can be byte-patched into the Core's own blob.

**Tested sequence (all reverted):**
1. Create a disabled TEST rule on a push button.
2. `pull`, add a `LongPushActions` Off on a light, `push --send`.
3. Set `IsEnabled: true`, `push --send`. A long press on the physical button switched the light off.
4. Delete the rule. The other rule blobs were byte-identical before and after.
