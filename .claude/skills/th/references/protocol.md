# Protocol and encoder

## Connection

- **Endpoint:** `ws://<core>/Core`, port 80, with no TLS, no headers and no sub-protocol. The server is websocket-sharp. The Core's address is `host` in `config.json`; the env variable `CORE_IP` overrides it.
- **Node's built-in `WebSocket` (undici) does not work.** The Core closes it with `1007 Invalid message received (a3)` right after it acks the reconnect. Use the raw-socket client `probe/rawws.mjs`; `probe/session.mjs` wraps the whole login.
- **Framing:** the Core splits large messages into 1016-byte frames, and `rawws.mjs` reassembles them. `FRAMES=1` logs every frame.

## Message framing

- **One binary message is one protobuf-net `MessageBase`.** The subtype is nested under its `ProtoInclude` tag and written **before** `RequestsId` (field 1). Examples:
  - 101 `MessageDeviceAction`
  - 102 `MessageGenericResponse`
  - 107 value broadcast
  - 108 login
  - 110 reconnect
  - 299 update rules
  - 300 rules-updated broadcast
  - 383 `MessageContainer`
- **Tag map:** `loadSchema().tagMap` (from `schema/taphome-schema.json`) maps each tag to its class name and `MessageType` (Request 1, Response 2, Broadcast 3, Acknowledgement 5, Container 6). `P.wrap(tag, body, rid)` and `P.unwrap(raw, tagMap)` are in `proto.mjs`.
- **Containers:** `MessageContainer` (383, field 1 = repeated serialized `MessageBase`) carries most broadcasts. Unwrap it and look inside. Ack the container, not its children.
- **Replies:** a reply carries the request's `RequestsId` and has type Response. Every write is also followed by an unrequested `MessageGetAffectingTriggersInfoResponse`; ignore it.
- **Keepalive** (`session.mjs` handles it): every 4 s, ack every non-ack message with `MessageReceiveAcknowledgement` (tag 100, `stamp = MessageType << 32 | RequestsId`). Send a WebSocket ping every 6 s.

## Login and reconnect

1. `/Identify` returns the location (one frame, `LocationInfo`).
2. A throwaway `/Core` socket sends `MessageLoginRequest` (`RequestsId` 0, `ClientProtocolVersion` 89) and gets back a `SessionId`.
3. A new `/Core` socket sends `MessageReconnectRequest`. A fresh client gets result 4 plus the Core's `DbHash`. Repeating the request with that `DbHash` gives result 1 and the **full configuration**, several hundred kB.

**Auth:**
- The secret is the local user's password. With `MODE=cloud` it is the per-location `authorizationToken` from TapHome's cloud login (`cloud` in `config.json`).
- It is sent as `hex(SHA512(SHA512(secret + salt)))` (`P.passwordHash`). The salt is `passwordSalt` in `config.json`.
- `probe/device-id.txt` (gitignored) keeps one stable client device id.

There is no "list devices" request: the reconnect response *is* the configuration. It contains:
- `Ccus` (interfaces)
- `Devices`, with `DeviceProperties`, current values and aggregations
- `Dashboards` (zones, categories, dashboards) and `DashboardSets`
- `SmartRules` (serialized `TriggerModel` blobs) and `SmartRuleErrorStatuses`
- `UserGroups`, `CoreProperties` and `LocationInfo`

After it, the Core pushes deltas.

## Where things live in the configuration

| What | Where |
|---|---|
| Interface (TapHome Bus, Packet Parser, Modbus RTU; Virtual devices = CCU 1) | `Ccus[]`: `CcuId`, `Name`, `Model` |
| Module | a device whose `Model` contains `Module`. Its children point to it via `DeviceProperties.HardwareParentId`; TapHome Bus children are also linked by serial number (see bus-modules.md) |
| Device configuration (scripts, poll interval, IP, …) | `DeviceProperties`, string→string. Modbus examples: `ReadScript`, `InternalPollInterval`, `SlaveId`. Packet Parser examples: `ReadScriptPacketParser`, `IpAddress` |
| Zones, categories, dashboards | `Dashboards[]` with `DashboardTypeId` 1 or 3 = zone, 2 or 4 = category, 0 = dashboard. The order is in `DashboardSets`. Deleted ones remain as tombstones (`DeletedOnTUtc`) |
| History recording switched on | `Devices[].EnabledValueAggregations {ValueLogType: [aggregation]}` |
| Built-in names like `${zone_livingRoom}` | translation keys; `export.mjs` resolves them with the `.resx` set as `translations` in `config.json` |

## Schema and encoder (`probe/schema.mjs`)

`loadSchema()` reads `schema/taphome-schema.json`: about 830 `[ProtoContract]` classes, the enums and the tag map. `build-schema.mjs` regenerates the file from a decompiled `TapHome.Core.Lib.Model`, using `buildSchema(modelDir)`. `makeDecoder` and `makeEncoder(schema, {strict})` turn bytes into named JSON and back. The encoder is byte-exact: all rule blobs and the full reconnect re-encode identically (`roundtrip.mjs`).

The rules it follows (reproduce them in any new code):
- **Root-first inheritance:** a subclass is written as its root class, with the subclass nested under the include tag. Decode from the root of the include chain, and give the JSON a `$type` to select the subclass.
- **Optional fields:** a field is written only when present, so absent ≠ 0. protobuf-net omits defaults, so a value of 0 often arrives as a missing field (e.g. register `Index` 0; `ValueAggregation {}` = instant).
- **Maps:** a map is a repeated `{1 key, 2 value}`. Map or list values are a repeated field 2 with no wrapper. Insertion order is kept under the `WIRE_ORDER` symbol.
- **Other encodings:**
  - Packed lists are written even when empty.
  - NaN uses the .NET bit pattern.
  - A bcl TimeSpan is shown as e.g. `"57600s"`; scale 15 means MinValue/MaxValue.
  - A Guid omits zero halves.
  - A DateTime is an ISO string.
  - `long` values come back as strings.
- **`KeyValuePair<K,V>`** is `{1 Key, 2 Value}`.
- **Hard-coded fixes:** the field numbers 4–19 of `HistoryItemsSession` (ZigZag ints) were recovered from the IL, because ILSpy could not decode them. Property declarations whose `{` is on the next line are handled.
- **Strict mode:** the strict encoder throws on unknown keys and on undecoded markers (`$unknown`, `$wireMismatch`).

**Time bases:**
- TapHomeTime = seconds since 2016-01-01 UTC (log entries, `ChangedOnTHUtc`, `EnabledOnTHUtc`).
- `…TUtc` longs are .NET ticks (`3155378975999999999` = `DateTime.MaxValue`).

**Decompiled sources:**
- `TapHome.Core.Lib.Model`: the model and messages. It is only needed to regenerate the schema.
- The client app (`TapHome.Client.Desktop.Wpf`), if decompiled, holds the app logic. It is the reference for how a request is built.
- Some classes live in `TapHome.Core.Lib.Common`, e.g. `HistoryItemsSerializer`, `TapHomeBusModuleConfig` and `Password` (the salt). Decompile that DLL from the app with `ilspycmd`; `ilspycmd -il` shows attribute bytes that ILSpy cannot decode.
