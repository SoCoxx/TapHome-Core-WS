// Opens a working /Core session: /Identify -> login (throwaway socket) -> reconnect (+DbHash retry),
// or straight to the reconnect with a stored session (see sessionFile below).
// Returns { conn, next, reconnectRaw, send, close } where reconnectRaw is the full MessageBase buffer
// of the successful MessageReconnectResponse.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './proto.mjs';
import { connectRaw, messageStream } from './rawws.mjs';

// schema/tested.json: what this client sends (client) and the Core it was last tested against (core). TapHome changes
// the protocol from time to time, so every session compares the Core's reconnect reply with it: on any difference,
// reads go on with a warning and writes are refused (UNTESTED_OK=1 overrides). node probe/version.mjs checks a new
// Core and records it as tested.
export const TESTED_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'tested.json');
export const TESTED = JSON.parse(readFileSync(TESTED_FILE, 'utf8'));
const SW_VERSION = TESTED.client.softwareVersion;
const PROTO_VER = TESTED.client.protocolVersion;
const TOO_OLD = 'the Core rejects this client as too old (AppTooOld): TapHome changed the protocol. Regenerate the schema '
  + 'from the current app, then raise client.protocolVersion and client.softwareVersion in schema/tested.json '
  + '(README: "When TapHome updates the protocol")';

// the Core's versions from a MessageReconnectResponse body: 9 CurrentProtocolVersion, 27 TriggerVersions
// (smart rule type -> format version, a Dictionary<int,int> = repeated {1 key, 2 value}), 28 CoreVersionString
export function coreVersions(body) {
  const triggerVersions = {};
  for (const f of P.all(body, 27)) {
    const e = P.decode(f.v);
    triggerVersions[Number(P.get(e, 1)?.v ?? 0n)] = Number(P.get(e, 2)?.v ?? 0n);
  }
  return { version: P.str(P.get(body, 28)), protocolVersion: Number(P.get(body, 9)?.v ?? 0n), triggerVersions };
}
// what differs from the tested Core; [] = it is the tested one
export function versionDiffs(live, tested = TESTED.core) {
  const d = [];
  if (live.version !== tested.version) d.push(`core "${live.version}" (tested "${tested.version}")`);
  if (live.protocolVersion !== tested.protocolVersion) d.push(`protocol ${live.protocolVersion} (tested ${tested.protocolVersion})`);
  const lt = live.triggerVersions, tt = tested.triggerVersions;
  const rules = [...new Set([...Object.keys(lt), ...Object.keys(tt)])].filter((k) => lt[k] !== tt[k]).map((k) => `type ${k} ${tt[k] ?? '-'}->${lt[k] ?? '-'}`);
  if (rules.length) d.push(`smart rule formats ${rules.join(', ')}`);
  return d;
}

function deviceId() {
  const f = join(dirname(fileURLToPath(import.meta.url)), 'device-id.txt');
  if (!existsSync(f)) writeFileSync(f, randomBytes(16).toString('hex'));
  return readFileSync(f, 'utf8').trim();
}

function readStore(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

async function open(host, path) {
  const conn = await connectRaw(host, path, process.env.FRAMES ? { log: (m) => console.error(m) } : {});
  const q = [];
  let waiter = null, closed = null;
  messageStream(conn, {
    onMessage: (m) => { q.push(m); waiter?.(); },
    onClose: (c) => { closed ||= c; waiter?.(); },
  });
  conn.next = async (ms = 15000) => {
    const t0 = Date.now();
    while (!q.length) {
      if (closed) return null;
      if (Date.now() - t0 > ms) throw new Error(`timeout on ${path}`);
      await new Promise((r) => { waiter = r; setTimeout(r, 200); });
    }
    return q.shift();
  };
  conn.closeInfo = () => closed;
  return conn;
}

// sessionFile: reuse a stored SessionId (skips /Identify and the login) and remember the last DbHash; falls back to a
// fresh login when the Core rejects the stored session. fresh: always log in (and store the new session).
// noLogin: use only the stored session, never the password (throws when there is none or it is rejected).
// warn: print the untested-Core warning to stderr (version.mjs turns it off and reports by itself).
export async function openSession({ host, cred, salt, tagMap, log = console.log, sessionFile = null, fresh = false, noLogin = false, warn = true }) {
  const dev = deviceId();
  const login = cred.u.toLowerCase();
  const key = `${cred.isLocal ? 'local' : 'cloud'}:${host}:${login}`;
  const store = sessionFile ? readStore(sessionFile) : {};
  const saved = fresh ? null : store[key];
  if (noLogin && !saved) throw new Error('no stored session');

  async function fullLogin() {
    if (!salt) throw new Error('"passwordSalt" is empty in config.json: run node probe/auth.mjs (or /th auth) first');
    let secret = cred.p;
    if (!cred.isLocal) {
      const r = await fetch('https://cloudapi.taphome.com/api/user/login2', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ DeviceId: dev, Platform: 'Windows', SoftwareVersion: SW_VERSION, Email: cred.u, Password: cred.p, LanguageCode: 'en-US', DeviceName: 'ws-probe' }),
      });
      if (!r.ok) throw new Error(`cloud login HTTP ${r.status}`);
      const loc = (await r.json()).myInfo?.myLocations?.find((l) => l.ipOnLocalNetwork === host);
      if (!loc) throw new Error(`no cloud location with ip ${host}`);
      secret = String(loc.authorizationToken).toLowerCase();
    }
    const idc = await open(host, '/Identify');
    const idf = P.decode(await idc.next());
    idc.close();
    const locationId = P.decGuid(P.get(idf, 1));
    log(`[identify] ${P.str(P.get(idf, 2))} @ ${host}`);

    const lc = await open(host, '/Core');
    lc.sendBinary(P.wrap(108, Buffer.concat([
      P.fGuid(1, locationId), P.fString(2, login), P.fString(3, P.passwordHash(secret, salt)),
      P.fString(4, 'Windows'), P.fString(5, SW_VERSION), P.fString(6, dev), P.fString(7, 'ws-probe'),
      P.fBool(9, cred.isLocal), P.fVarint(10, PROTO_VER),
    ])));
    let lr;
    for (;;) {
      const m = await lc.next();
      if (!m) throw new Error('login socket closed');
      lr = P.unwrap(m, tagMap);
      if (lr.tag === 109) break;
    }
    lc.close();
    const loginResult = Number(P.get(lr.body, 1)?.v ?? 0n);
    if (loginResult === 6) throw new Error(TOO_OLD);
    if (loginResult !== 1) throw new Error(`login failed, LoginResult=${loginResult}`);
    log(`[login] ok as ${login} (${cred.isLocal ? 'local' : 'cloud'})`);
    return { locationId, sessionId: P.decGuid(P.get(lr.body, 2)) };
  }

  const toAck = [];
  const stamp = (m) => {
    if (m.type == null || m.type === P.TYPE.Acknowledgement || m.type === P.TYPE.Stream) return;
    toAck.push((BigInt(m.type) << 32n) | BigInt.asUintN(32, BigInt(m.requestsId)));
  };

  async function reconnect({ locationId, sessionId }, dbHash) {
    const c = await open(host, '/Core');
    c.sendBinary(P.wrap(110, Buffer.concat([
      P.fGuid(1, locationId), P.fString(2, login), P.fGuid(3, sessionId), P.fBool(4, cred.isLocal),
      P.fString(5, 'Windows'), P.fString(6, SW_VERSION), P.fString(7, dev), P.fString(8, 'ws-probe'),
      P.fVarint(11, PROTO_VER), ...(dbHash ? [P.fBytes(24, dbHash)] : []),
    ]), 1));
    for (;;) {
      const raw = await c.next(60000);
      if (!raw) throw new Error(`reconnect socket closed ${JSON.stringify(c.closeInfo())}`);
      const m = P.unwrap(raw, tagMap);
      stamp(m);
      if (m.tag === 111) return { c, rr: m, raw, res: Number(P.get(m.body, 1)?.v ?? 0n), hash: dbHash };
    }
  }
  async function attempt(sess, dbHash) {
    let r = await reconnect(sess, dbHash);
    if (r.res === 4) { // FaultyStorageClient: retry with the Core's DbHash
      r.c.close(); toAck.length = 0;
      r = await reconnect(sess, Buffer.from(P.get(r.rr.body, 37)?.v ?? []));
    }
    return r;
  }

  let sess = saved ? { locationId: saved.locationId, sessionId: saved.sessionId } : await fullLogin();
  let r;
  try { r = await attempt(sess, saved?.dbHash ? Buffer.from(saved.dbHash, 'hex') : null); }
  catch (e) { if (!saved) throw e; r = { res: -1, err: e.message }; }
  if (saved && r.res !== 1) {
    r.c?.close(); toAck.length = 0;
    const why = r.err || `ReconnectResult=${r.res}`;
    if (noLogin) throw new Error(`stored session rejected (${why})`);
    log(`[session] stored session rejected (${why}), logging in`);
    sess = await fullLogin();
    r = await attempt(sess, null);
  }
  if (r.res === 6) throw new Error(TOO_OLD);
  if (r.res !== 1) throw new Error(`reconnect failed, ReconnectResult=${r.res}`);
  const { c, raw } = r;
  const live = coreVersions(r.rr.body);
  const diffs = versionDiffs(live);
  if (diffs.length && warn)
    console.error(`[version] UNTESTED Core: ${diffs.join('; ')}. Reads may decode wrongly and writes are refused; check it with node probe/version.mjs`);
  log(`[reconnect] ok${saved && sess.sessionId === saved.sessionId ? ' (stored session)' : ''}, ${raw.length} bytes`);
  if (sessionFile) {
    store[key] = { ...sess, dbHash: r.hash?.length ? r.hash.toString('hex') : null, savedAt: new Date().toISOString() };
    writeFileSync(sessionFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  let nextId = 2;
  const ackT = setInterval(() => { if (toAck.length) c.sendBinary(P.wrap(100, Buffer.concat(toAck.splice(0).map((s) => P.fVarint(1, s))))); }, 4000);
  const pingT = setInterval(() => c.ping(), 6000);
  const close = () => { clearInterval(ackT); clearInterval(pingT); c.close(1000); };
  return {
    conn: c,
    reconnectRaw: raw,
    stamp,
    versions: { live, tested: TESTED.core, diffs },
    // write tools call this right before sending a write: on an untested Core it prints why and exits (code 3)
    requireTested(what = 'write') {
      if (!diffs.length) return;
      if (process.env.UNTESTED_OK) { console.error(`[version] UNTESTED_OK: sending ${what} to an untested Core`); return; }
      console.error(`[refused] ${what}: the Core is not the tested version (${diffs.join('; ')}).\n`
        + '  Check it with node probe/version.mjs; when its checks pass, node probe/version.mjs accept records it as tested.\n'
        + '  UNTESTED_OK=1 sends anyway.');
      close();
      process.exit(3);
    },
    newRequestId: () => nextId++,
    async next(ms) { const r = await c.next(ms); if (r) stamp(P.unwrap(r, tagMap)); return r; },
    close,
  };
}
