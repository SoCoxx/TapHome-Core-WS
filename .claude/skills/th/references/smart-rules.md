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

## How the Core decides an output (verified live)

**Holding rules beat one-shot actions.**
- Clock-driven rules hold their output continuously. Examples are LightingTimer while it is active and KeepDefaultValues. A one-shot action on that output from a PushButton rule (`ForceOneTimeOnly`) does not stick, **even when the PushButton rule has the higher priority**: the holder puts its value back. Nothing appears in the device log, so the press looks as if it did nothing.
- The one-shot is also lost when the same press flips the input of the holder's limiting condition. The holder lets go only after the action has already lost. Changing the order of actions in the rule does not help.
- A holder that becomes limited lets go at once, and the next holder in priority order takes over. A KeepDefaultValues rule switches the output to its default immediately.

**Pattern: a button that must win against automation.** Don't let the button act on the output directly.
- The button sets virtual switches.
- Holding rules drive the output. For example, a Switch rule "virtual switch On → output On" outranks a KeepDefaultValues rule. A "manual off" virtual switch in the automation rule's limiting condition makes that rule let go.
- For a toggle, use two PushButton rules on the same buttons with opposite conditions on the output's own state (`St = 0` / `St = 1`). The condition is evaluated at press time, so exactly one of them fires.
- Reset the virtual switches from the event that should give control back to the automation.

**Switch rules (`OnActions`/`OffActions`)** act on the input's change.
- A later one-shot on the same output overrides them; they don't hold against it.
- **Storing a Switch rule (create or edit) makes the Core evaluate it once at once.** The actions for the input's current state run immediately. Check what they do before you push.

**Operation mode.**
- Devices have an `OperationMode`: 1 Manual, 2 Automatic.
- A one-shot button action on a virtual switch puts it into Manual. The log shows `OperationMode=1 [DontCare]` by that rule.
- A rule action sets it back to Automatic (`OperationMode=2`).
- `DeviceActionParameters.OperationMode` (`ManualOnlyOrNone`, `Manual`, `Automatic`) can request this explicitly. Not tried.

**LightingTimer (`TriggerTypeId` 39).**
- `ActiveActions` are hold-only. `MotionSensorIds` can be any binary input, e.g. a reed contact.
- Its buttons are `PushButtonIds` plus per-press dictionaries `ShortPressActions` / `LongPressActions` / `DoubleClickActions` / `TrippleClickActions`, each mapping `{buttonId: None|On|Off|Toggle}`.
- `ControlButtonActiveTimeout` defaults to MaxValue. A light switched on by a button then stays on indefinitely and **ignores the motion sensor**, until a button switches it off. `ControlButtonInactiveTimeout` is how long the sensor is ignored after a button switched the light off.
- Live states: Default, ActivatedByMotionSensor, ActivatedByControlButton, LimitingCondition.
- When its limiting condition becomes true again while the sensor is inactive, it does **not** start the motion timeout. It just doesn't hold the light.
- TimeSpans decode as strings such as `"180s"` and `"MaxValue"`.

## Generic rule names

A rule created without a name is stored as a translation key in the form `${smartrule_name_<type>}` with an optional ` (2)` suffix. The tools print the key, but the app shows the translation.

**Talk to the user with the app's names, not with rule or device ids.** The app shows no ids. Add the rule's input or output when several rules share a name.

The Slovak translations are in the app's `TapHome.Translations.i18n.sk.resx` (a decompiled `TapHome.Translations.sk`). Examples:

| Key | sk | en (app) |
|---|---|---|
| `smartrule_name_lightingtimertrigger`, `…trigger2` | Časovač osvetlenia | Lighting timer |
| `smartrule_name_keepdefaultvaluestrigger` | Nastaviť predvolenú hodnotu | Keep default values |
| `smartrule_name_switchtrigger` | Vykonaj akcie pri zapnutí / vypnutí | Switch |

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

Edits tested live:
- actions added, removed and reordered
- `IsEnabled` changed
- a Formula limiting condition added, changed and removed

Gotchas:
- **Key order of an added top-level key.** The decode-back check compares JSON text, so a key added at the end of the file (e.g. `IsEnabled` on a disabled rule, where it is absent) aborts the push. Insert it where the decoder puts it: `IsEnabled` goes right after `Version`. Limiting-condition keys go after `ChangesetId`, in the order `LimitingConditionTypeId`, `IsLimitingConditionEnabled`, `LimitingConditionParameters`.
- **Disabling.** After `IsEnabled: false` the Core stores the field as absent (default). `push` then reports "stored differs" with no field diff, which is harmless.
- **Adding a condition.** Set `LimitingConditionTypeId: 1`, `IsLimitingConditionEnabled: true` and `LimitingConditionParameters` as a `FormulaLimitingConditionParameters`. The Core derives `LimitingConditionInputs`.
- **Removing a condition.** Delete all four keys (including `LimitingConditionInputs`).
- **Removing all actions of a list.** Delete the key; an empty list does not encode.
- **Formula syntax** seen in working rules: `Va = 0`, `RETURN (Va = 1 & Rc = 1)`, `IF (St=0) RETURN (TRUE); END`, and `#` comments with `\r\n` line ends.

## Creating, renaming and deleting rules

- **Create/update** is `MessageUpdateTriggerModelsRequest` (299) `{1: [TriggerModel bytes]}`; `Id` 0 creates. The reply's `ErrorCode` is 1 for ok and 16 for an incompatible smart-rule version. The broadcast is 300 (blobs + changeset).
- **Delete** is `MessageDeleteTriggerModelsRequest` (301) `{TriggerIds}`; the broadcast is 302.
- **`rules-write.mjs create <buttonId> "TEST …"`** creates a **disabled** PushButton rule with no actions. `rename` and `delete` only touch rules named `TEST …`.
- **Simple top-level changes** such as `IsEnabled` or `Name` can be byte-patched into the Core's own blob.
- **A complete new rule** (any type, enabled, with actions and a condition) is the same 299 request with a full `TriggerModel` and no `Id`. It needs `TriggerTypeId`, `Name`, `Version` (from `TriggerVersions`), `IsEnabled`, the limiting-condition keys and `TriggerParameters`. Leave `TriggerInputs`, `LimitingConditionInputs` and `Priorities` to the Core.
  - Tested live for Switch rules and for PushButton rules with a Formula condition.
  - There is no dedicated tool. A one-off script does it: encode with the strict encoder, check decode-back, send tag 299, and wait for the reply plus the 300 broadcast, as `rule-edit.mjs` `store()` does.
  - A free id of a deleted rule may be reused.

**Tested sequence (all reverted):**
1. Create a disabled TEST rule on a push button.
2. `pull`, add a `LongPushActions` Off on a light, `push --send`.
3. Set `IsEnabled: true`, `push --send`. A long press on the physical button switched the light off.
4. Delete the rule. The other rule blobs were byte-identical before and after.
