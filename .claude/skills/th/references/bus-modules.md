# TapHome Bus modules

The TapHome Bus is one of the Core's interfaces (`Ccus[]`; often CCU 2). Its modules (CORE21, DO12, UI32, UI2, UI4DO2, W2DI2DO2, LEDOC12, …) are devices whose `Model` is `TapHomeBus…Module`.

## Which device sits on which terminal

The **serial number** encodes it: `<module serial>:<Type>-<terminal type>-<index>`. For example:
- `DO12-…:Switch-DO-3` is a switch on DO output 3 of a DO12.
- `UI2-…:Reed-UI-1` is a reed contact on UI1.

Port sensors end in `-EXT` (external connector) or `-INT` (built-in), e.g. `…:THSensor-EXT` or `…:Co2-EXT`.

`HardwareParentId` is **not** reliable (a port sensor may have 0), so group a module's devices by the serial prefix before the `:`.

External sensor connectors (TWI bus, `TapHomeBusTHTwiSensor` / `TapHomeBusCo2Sensor`):

| Module | EXT connectors |
|---|---|
| 2UI (UI2) | 2 |
| 6UI, 6UI/6UO | 2 |
| UI4DO2 | 1 |
| W2DI2DO2 | 0 |

A UI2 has these terminals: +24V/GND, bus A/B, UI1/GND and UI2/GND, plus the two EXT connectors.

## Terminal configuration: the dangerous part

The app configures a module with one request:

```json
{"$type":"MessageTapHomeBusConfigRequest","DeviceId":<module id>,"ConfigJson":"<TapHomeBusModuleConfig as a JSON string>"}
```

The `ConfigJson` lists the module's **complete** desired terminal configuration:

```json
{"Devices":[{"Index":1,"Type":"Reed","ExtraAttributes":{"DeviceName":"…","DeviceZoneId":"<guid>","DeviceCategoryId":"<guid>","TerminalType":"UI"}}]}
```

- **Types:** `Switch`, `SwitchOnUO`, `Blind`, `BlindOnUO`, `EncoderBlind`, `CurrentLimitedBlind`, `PushButton`, `Reed`, `ImpulseCounter`, `Thermometer`, `AnalogInput`, `AnalogOutput`, `AnalogOutputOnDO`, `AnalogOutputOnUO`, `Dimmer`, `LedDimmer`, `RGB`, `TunableWhite`, `Slide`, `WG`, ….
- **Terminal types:** `DO`, `DI`, `UI`, `UO`, `AO`, `NTC`.
- **Extra attributes:** blind terminals (`TerminalUp`/`TerminalDown`), RGB outputs, PWM groups, state names and icons, and `DeviceTypeProperties`. They are defined by the class `TapHomeBusModuleConfig` in `TapHome.Core.Lib.Common` and built by `TapHomeBusModuleConfigurationPage.ExportConfig` in the client.
- **Reply:** `MessageTapHomeBusConfigResponse {AddedDevices, RemovedDevices}` after about 1 s. The Core then writes the configuration to the module.

**The Core diffs the list against the module's terminal devices.** New entries become devices, and **terminal devices missing from the list are removed**, together with their history and their place in rules. A partial list therefore deletes real lights, buttons and blinds. EXT/INT port sensors are not part of the list and are never removed by it.

### How to change a terminal safely

1. **Rebuild the module's current list exactly.** Take every device whose serial starts with the module serial and doesn't end in `-EXT`/`-INT`. Turn each `…:<Type>-<terminal>-<index>` into `{Index, Type, ExtraAttributes: {DeviceName, DeviceZoneId, DeviceCategoryId, TerminalType}}`. Types with extra attributes (blinds, RGB, PWM) need them copied from the client's export logic, so study `ExportConfig` first.
2. **Change only the one entry you mean to.**
3. **Compute which existing devices would be removed** before sending. That list must be empty, or contain only `TEST…` devices. Show it in the plan.
4. **After sending, check** the reply's `AddedDevices` and `RemovedDevices` against the expectation. If anything unexpected was removed, stop and tell the user immediately.

**The safest first target** is a module with no terminal devices at all (only port sensors, or nothing). Check `site-notes.md` for a module the user has agreed to. The sequence tested on such a UI2:
1. `module-led-start`/`-stop`, so the user can identify the module.
2. `{"Devices":[{"Index":1,"Type":"Reed",…"TerminalType":"UI"}]}`: one `…:Reed-UI-1` device added, nothing removed.
3. `{"Devices":[]}`: only that reed contact removed.

The configuration was identical afterwards. Any module with devices in use needs a specific plan and the user's explicit approval for that module.

## Other module functions

| Function | How | Status |
|---|---|---|
| Identify (LED blinks) | `node probe/control.mjs <module> module-led-start` / `module-led-stop` | tested, harmless |
| Uptime, board revision, Vcc/temperature/24 V | see reading.md | read-only |
| Add a new module | `MessageTapHomeBusConfigRequest {CcuId: <bus CCU>, ConfigJson: {"AddModules":["<serial>"]}}` | not tried (needs new hardware) |
| Bus scan | `MessageScanForNewDevicesRequest {CcuId, Duration}` | not tried |
| Reset statistics | `MessageAllModulesResetStatisticsRequest {CcuId}` | not tried |
| Blind / presence calibration | `MessageTapHomeBusBlindStartSoftwareCalibrationRequest`; presence calibration runs as a long-running task | **don't**: physically moves blinds |
| Firmware update | `MessageUpdateModuleFirmwareRequest` (chunked) | **never** |
| Replace a module | client `TapHomeBusModuleReplacePage` (moves terminal devices and port sensors by serial) | not tried |
