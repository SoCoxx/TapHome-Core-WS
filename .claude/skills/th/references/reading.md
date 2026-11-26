# Reading: history, logs, diagnostics, settings

Everything here is read-only and goes through `ask.mjs`, run from the clone root:

```
node probe/ask.mjs '<request json>' 2>&1 | grep -viE "token|password"
```

`ask.mjs` pretty-prints history points, device logs and script values; add `RAW=1` for the decoded JSON. A shell-safe way to build JSON with dates:

```bash
from=$(node -e 'console.log(new Date(Date.now()-6*3600e3).toISOString())'); now=$(node -e 'console.log(new Date().toISOString())')
node probe/ask.mjs "{\"\$type\":\"MessageDeviceValueHistoryDataRequest\",\"DeviceId\":$ID,\"ValueLogType\":\"RealTemperature\",\"ValueAggregation\":{},\"DateTimeFromUtc\":\"$from\",\"DateTimeToUtc\":\"$now\"}"
```

## Value history

The request is `MessageDeviceValueHistoryDataRequest {DeviceId, ValueLogType, ValueAggregation, DateTimeFromUtc, DateTimeToUtc}`.

- **Only values with recording on have history.** Check `Devices[].EnabledValueAggregations` in `out/reconnect.json`. Without it the reply has no `Container`, and the last cloud flush shows `MinValue`.
- **`ValueAggregation`:**
  - `{}` means raw values.
  - Hourly averages are `{"StatisticsFunction":"Avg","PeriodType":"CurrentPeriod","Period":"Period1H"}`; use `Period1D` or `Period1M` for daily and monthly ones.
  - The functions are CurrentValue, Min, Max, Avg, Count, SumOrIntegral and Derivate.
- **Retention on the Core:** raw about 5 h, hourly about 8 days, daily and monthly 1 year. Older data is only in the TapHome cloud. Daily buckets start at local midnight.
- **Values:** on/off values (SwitchState) come back as bits and temperatures as scaled ints; `ask.mjs` expands them all into `[utc, value]`. An int below -8000000 means NaN.
- **Recording:** a new point is stored when the value changes. `LastHistoryCloudFlushOnTUtc` in the reply shows when the Core last pushed data to the cloud.

## Device log (the app's "show all logs")

The request is `{"$type":"MessageGetDeviceLogRequest","DeviceId":N}` and returns the last ~40 changes. Each line shows:
- the local time
- the values (`SwitchState=1`)
- the origin `[Manual|App|SmartRule|Startup|Time|…]`
- `rule <id>`: the last rule that handled the change (`-1` = the rule no longer exists)
- `from device <id>`: the device that started the chain
- `user <id>`, for app commands

Examples:
- A button press: `[Manual] rule <r>, from device <button>`.
- A schedule: `[SmartRule] rule <r>, from device 1` (device 1 = the clock).
- A device set from outside through the exposed TapHome API (presence detection, other integrations): `[SlaveInterface] from device 1`. Repeated flapping there often explains rules switching back and forth. A device with no rules but such log lines is in use, so never treat it as unused.
- An app press of a physical button: `[App] rule <r>, from device <button>, user <id>`.
- A press that changed nothing leaves no line on the output. Compare the button's own log (`ButtonPressed=1` short, `2` long) with the output's log to spot presses that lost against a holding rule (see smart-rules.md).

## Rules affecting a device

The request is `{"$type":"MessageGetAffectingTriggersInfoRequest","DeviceId":N}`. It returns `Actions {ruleId: {Status}}`, the same list as on the app's device page. Possible statuses:
- `NoInfo`
- `Disabled`
- `ShouldNotEvaluate`
- `LimitedByCondition`: its limiting condition blocks it right now (the app marks it as limited)
- `ReturnedNoAction`
- `ReturnedAction`
- `ReturnedActionAndActionAplied`

Rule errors: `MessageGetTriggerErrorsRequest {TriggerId}`. In the reconnect, `SmartRuleErrorStatuses {ruleId: status}` is 0 for every rule when they are healthy.

## Script debugger (last-run values)

The request is `{"$type":"MessageGetScriptLastRunValuesRequest","LastRunId":{"ObjectIdType":"Device","ObjectId":<deviceId>,"ScriptKey":"ReadTemperatureScriptPacketParser"}}`.

- **Keys:** `ScriptKey` is the device property that holds the script; see the device's `DeviceProperties` or `out/config/interfaces/…/*.txt`. For a smart rule use `{"ObjectIdType":"Smartrule","ObjectId":<ruleId>}` with no key. `Ccu` is the third object type.
- **Output:** the run time, the duration, the result, and each variable at each capture step. Step 0 holds the values before the run (left over from the previous one); the last step holds the values after it.

## Module diagnostics

- **Service attributes** (the app's service settings): `{"$type":"MessageGetServiceAttributeValuesRequest","ObjectIdTypeId":0,"ObjectId":<module>}`. They include built-in counters (`d_ScriptStats`, `d_AdapterTaskSuccess`, received data) plus the results of the module's `ServiceAttributesScripts…`. `MessageGetAvailableServiceAttributesAndActionsRequest` lists the names.
- **Modbus:** `node probe/modbus-health.mjs [hours]` reports, for each module:
  - the register count and the last good read
  - the response times
  - registers overdue: no good read for 3× the `InternalPollInterval` of their devices
  - the last failure per register, with its cause: a communication error (`CRCError`, `ModbusTransportException`), the slave's exception answer (`IllegalDataAddress`), or no response

  The Core keeps only the **last** failure per register, so the report shows recency, not frequency. The raw request is `MessageModbusRegistersInfoRequest {DeviceId: <ModbusModule id>}`. A Systemair SAVE VTC 700 module makes the Core throw a NullReferenceException there (a Core bug).
- **TapHome Bus:**
  - All module uptimes: `MessageGetAllModulesInfoRequest {CcuId: <bus CCU>}`. The answer arrives as `MessageGetAllModulesUptimeBroadcast`, in ms.
  - Board revisions: `MessageGetModulesBoardHwRevisionRequest {ModuleIds}`.
  - Voltages and temperature: `MessageGetModuleInfoRequest {ModuleId}` (one per module) makes the module report `MessageGetModuleVccAndTemperatureBroadcast {DeviceId, Vcc mV, Temperature °C×100, Vcc24 mV}`. Modules don't reliably send these by themselves, so request them, and catch the broadcasts with `WATCH=<s>` or `listen.mjs`.
  - The module's service attributes also show reset flags and communication counters (CRC errors, timeouts).
- **Device errors:** `MessageGetDeviceErrorsRequest {DeviceId}`.
- **Other:** current connections (`MessageGetCurrentConnectionsRequest`) and ports (`MessageGetUsedTcpPortsRequest`, `MessageGetAvailableCcuPortsRequest`).

## Settings pages

| App page | Request (all read-only) |
|---|---|
| My profile | the reconnect's `UserInfo` |
| All users | `MessageGetUsersListRequest`; history: `MessageGetUserManagementLogRequest`. The list contains e-mail addresses: summarise it, don't dump it |
| My location (info, attributes, network, uptime, MAC, time) | `MessageGetBasicCorePropertiesRequest` (a name/value list) |
| Date periods | `MessageGetDateRangesRequest` |
| Media library | `media.mjs list` / `get <id>` (the Core sends ≤ 4096 B per chunk and no MD5) |
| Exposed devices (TapHome API) | `MessageGetSlaveInterfacesRequest`, `MessageGetSlaveInterfaceDevicesRequest` (read only; never change it). **The interface's `Parameter1` holds the API token in plain text**: filter it (`grep -viE "token\|password\|Parameter1"`). In `MessageGetSlaveInterfaceDevicesRequest {SlaveInterfaceId}`, field 1 of each device's base64 `SerializedParameters` is its API id |
| Access control | `MessageGetAccessCardsRequest`, `MessageGetAccessLogsRequest {FromUtc, ToUtc}`, `MessageGetWeekPlansRequest`, `MessageGetWeekPlanProperties {WeekPlanId:[ids]}` (no `Request` suffix), `MessageGetWeekPlanDateRangeRequest {WeekPlanIds}` |
| Exports | `MessageGetDataExportProfilesRequest` (the `SerializedConfig` decodes as `DeviceValueExportProfileConfig`); `MessageGetStoredDataExportProfileResultRequest {Id, BufferSize}` returns the last automatic result, as JSON |

`ask.mjs` treats these as read-only:
- `…Get…Request`
- `…History…`
- `…Info…`
- `…Diagnostics…`
- `…Discovery`
- `…Download`
- `MessageGetWeekPlanProperties`

Anything else needs `--write`, which is a deliberate speed bump.
