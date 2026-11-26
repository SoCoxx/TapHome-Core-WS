# Writing: requests that change the Core

Each section below was tested live on throwaway `TEST …` objects and reverted afterwards, unless noted otherwise. Tested sections count as tested writes under the safety routine in SKILL.md (dry run, execute, verify, with no plan needed); anything marked untested needs a plan and the user's approval. Writes go through `node probe/ask.mjs '<json>' --write` unless a dedicated tool exists. A reply `ErrorCode` of 1 means ok.

## Device control (`control.mjs`)

The request is `MessageDeviceAction` (101) `{DeviceId, DeviceName, Action, ProtoParameters}`. The reply is `MessageGenericResponse` with `flags=1` (Handled), followed by value broadcasts. A failure is flags 0 with `ErrorCode` 3 and an `ErrorMessage`.

| ValueLogType | Action key | Parameter |
|---|---|---|
| SwitchState (48) | `switch` | Bool |
| MultiValueSwitchState (49) | `multi-value-switch` | Double (state index) |
| TemperatureSetPoint (6) | `temperature` | Double °C |
| VariableState (62) | `variable-set-value` | Double |
| AnalogOutputValue (42) | `dim-level` | Double 0..1 |
| BlindsLevel (46) / slide | `blind-level` / `slide-level` | Double 0..1 |
| BlindsSlope (10) | `blind-slope` | Double 0..1 |
| ButtonPressed (52) | `push-button` | ClickKind: Normal, Long, Double, Tripple |
| ButtonHeldState | `push-button-held` | Bool |
| CCT / HueBrightness / AlarmMode | `cct` / `hue-brightness` / `alarm` | |

```
node probe/control.mjs <id> set SwitchState=0     # maps ValueLogType -> action key, like the app
node probe/control.mjs <button> push-button long
node probe/control.mjs <module> module-led-start  # bus module identification (LED blinks); module-led-stop
DRY=1 node probe/control.mjs <id> set 48=1        # print the frame only
```

`MessageTapHomeApiSetDeviceValueRequest` is rejected from an app session ("Unknown device action"); don't use it.

## Virtual devices and variables (`devices-write.mjs`)

```
node probe/devices-write.mjs add Variable VirtualVariableGeneral "TEST …"
node probe/devices-write.mjs add PushButton VirtualPushButton "TEST …"
node probe/devices-write.mjs rename <id> "TEST …"
node probe/devices-write.mjs delete <id>          # ForceDelete true, as the app
```

- **Requests:**
  - `MessageAddDeviceRequest {DeviceName, Interface, Model, DeviceTypeId}`; the reply holds `AddedDevice`
  - `MessageUpdateDeviceNameRequest`
  - `MessageDeleteDeviceRequest`
- **Interface/model pairs** come from the app's `AddVirtualVariableDialog` and `AddVirtualDeviceDialog`. Examples: `Switch`/`VirtualSwitch`, `MultiValueSwitch`/`VirtualMultiValueSwitch`, `Thermostat`/`VirtualThermostatDummy`, `TemperatureSensor`/`VirtualTemperatureSensor`, plus the time and sun variables.
- **A new device has no zone or category.** Set them with device properties (below).
- **Non-TEST names.** `devices-write.mjs` refuses anything not named `TEST …`. For a real device the user asked for, send the same request directly: `ask.mjs '{"$type":"MessageAddDeviceRequest","DeviceName":"…","Interface":"Switch","Model":"VirtualSwitch","DeviceTypeId":0}' --write`. The reply is `MessageAddDeviceResponse`; find the new id with `find.mjs <name>`. Tested live.

## Device properties (zone, category, name, …)

`{"$type":"MessageUpdateDevicePropertiesRequest","DeviceId":N,"DeviceName":"<current name>","DeviceProperties":{"ZoneId":"<guid>"}}`. Send **only the changed keys**, as the app's `GetChangedDeviceProperties()` does. Zone and category can go in one request (`{"ZoneId":…,"CategoryId":…}`; tested). The reply can be slow or missing although the change was applied, so verify with `find.mjs <id>`.

- Moving a device into a static zone (type 1, e.g. the whole-house zone) also changes that zone's stored content; moving it out restores it.
- Script properties can be changed this way too, but a bad script breaks a real device. That needs its own plan, and it was not tested.

## Value history on or off

`{"$type":"MessageToggleHistoryForDeviceValueTypeRequest","DeviceId":N,"ValueLogType":"RealTemperature","ValueAggregation":{},"HistoryShouldBeOn":true}`

This is the same switch as on the device's statistics page. For a temperature, the Core adds the hourly, daily and monthly averages by itself. `MessageToggleAggregationForDeviceValueTypeRequest` switches a single aggregation (not tried).

## Manual override

`{"$type":"MessageSetDeviceManualOverrideStateRequest","DeviceId":N,"DeviceName":"…","ActivateManualOverride":true|false}`

## Zones

- **Add:** `{"$type":"MessageAddDashboardRequest","DashboardId":"<new guid>","Name":"…","AccentColorId":1,"Version":1,"DashboardTypeId":3,"Content":"","IconId":0}`. This is the app's "add zone" (type 3 = dynamic zone, empty content). Sent this way (the app's "save only" mode), the zone lands under "other" and the favourites order is untouched. The app's favourites variants also send `UpdateDashboardSet`.
- **Rename:** `MessageUpdateDashboardPropertiesRequest {DashboardId, Properties: {"Name": "…"}}`.
- **Delete:** `MessageDeleteDashboardRequest {DashboardId}`. The zone remains as a tombstone (`DeletedOnTUtc`), which is normal.
- **Dashboard content editing:** not researched.

## Date periods

- **Add:** `MessageAddDateRangeRequest {DateRange: {Name}}`; the reply holds the new `Id`.
- **Remove:** `MessageRemoveDateRangeRequest {DateRangeIds}`.
- **Intervals:** `MessageAddDateRangeIntervalRequest` (not tried).

## Data exports

1. **Create:** `MessageCreateUpdateDataExportProfileRequest {DataExportProfile: {Id: <new guid, required>, Name, Version: 1, ProfileTypeId: 0, SerializedConfig: <base64>}, CreateMissingDeviceValueAggregations: false}`.
   - Without an `Id` the Core answers "Invalid id." (6).
   - Creating a profile registers a TapHome cloud download URL (`UrlChange`); it disappears with the delete.
2. **`SerializedConfig`:** encode `{"$type":"DeviceValueExportProfileConfig","PeriodId":30,"Columns":[{"ValueLogTypeId":5,"StatisticsFunctionId":3,"DeviceId":<sensor>}],"FileTypeId":2,"QueryPeriodSelectionId":1,"QueryPeriodId":45,"QueryTimeUnits":1,"AutoExecDay":1,"AutoExecMonth":1}` as `DataExportProfileConfigBase`. This one gives hourly temperature averages over the last day, as JSON. Without `AutoExecPeriodId` it never runs automatically.
3. **Run:** `MessageExecuteNowDataExportProfileRequest {Id}` → `{SessionId, FinalSize, Buffer}`. Larger results continue with `MessageGetDataExportProfileResultDataChunkRequest`. The result matched the app's download exactly.
4. **Delete:** `MessageDeleteDataExportProfileRequest {ProfileIds}`.

## Media library (`media.mjs`)

`put <file.png|webp> "TEST …" [purpose=2]` sends a metadata message (`Position` 0, no `Buffer`, MD5 of the whole file), then 80 000-byte chunks. `delete <id>` only deletes `TEST…` items. Purposes: 1 = dashboard background, 2 = scheme background. ErrorCode 27 means not enough space.

## Access-control week plans

1. **Add:** `{"$type":"MessageAddWeekPlanRequest","WeekPlan":{"Name":"TEST …","ValidToTUtc":"3155378975999999999"}}` → the new `Id`.
2. **Add a slot:** `MessageUpdateWeekPlanRequest {WeekPlan:{…}, AddProperties:[{PlanId, WeekDay, StartTime, EndTime}]}`, with the times in seconds of the day.
3. **Delete:** `MessageDeleteWeekPlanRequest {WeekPlan:{…}}`.

`WeekDay` bits follow .NET `DayOfWeek`: bit 0 = Sunday … bit 6 = Saturday (62 = Mon–Fri, 65 = weekend, 127 = all). **Never link plans to cards or readers** (`…WeekPlanAndCard…`); that changes who gets in.

## Which changes the Core broadcasts to other clients

Checked with `listen.mjs` in a second session. Clients stay in sync only for the broadcast changes; tell the user when the open app needs a reload.

| Broadcast | Silent |
|---|---|
| device create/delete (`DeviceListUpdated`) | export profiles |
| device rename, manual override, zone change (`DeviceUpdated`, plus `DashboardContentUpdated` for a static zone) | week plans (delete included) |
| zone create (`DashboardUpdated`) and delete (`DashboardDeleted`) | media upload |
| media delete (`MediaDeleted`) | zone rename, and a move into a dynamic zone: nothing reached the writing session within 2 s |
| rule changes (300/302) | |
| bus terminal config (`DeviceListUpdated`) | |

Date periods were not checked.

The app also doesn't redraw some lists by itself (the zone list, access control), so leaving and reopening the page is the reliable check.
