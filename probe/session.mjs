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

const SW_VERSION = '2025.2.32363.0';
const PROTO_VER = 89;

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
export async function openSession({ host, cred, salt, tagMap, log = console.log, sessionFile = null, fresh = false, noLogin = false }) {
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
  if (r.res !== 1) throw new Error(`reconnect failed, ReconnectResult=${r.res}`);
  const { c, raw } = r;
  log(`[reconnect] ok${saved && sess.sessionId === saved.sessionId ? ' (stored session)' : ''}, ${raw.length} bytes`);
  if (sessionFile) {
    store[key] = { ...sess, dbHash: r.hash?.length ? r.hash.toString('hex') : null, savedAt: new Date().toISOString() };
    writeFileSync(sessionFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  let nextId = 2;
  const ackT = setInterval(() => { if (toAck.length) c.sendBinary(P.wrap(100, Buffer.concat(toAck.splice(0).map((s) => P.fVarint(1, s))))); }, 4000);
  const pingT = setInterval(() => c.ping(), 6000);
  return {
    conn: c,
    reconnectRaw: raw,
    stamp,
    newRequestId: () => nextId++,
    async next(ms) { const r = await c.next(ms); if (r) stamp(P.unwrap(r, tagMap)); return r; },
    close() { clearInterval(ackT); clearInterval(pingT); c.close(1000); },
  };
}
