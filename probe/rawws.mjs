// Minimal RFC 6455 client over a raw TCP socket, so every frame header is visible.
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';

export function connectRaw(host, path, { port = 80, log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const wsKey = randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let open = false;
    const conn = {
      sock,
      onFrame: () => {},
      onClose: () => {},
      sendFrame(opcode, payload = Buffer.alloc(0), fin = true) {
        const len = payload.length;
        const hdr = [(fin ? 0x80 : 0) | opcode];
        if (len < 126) hdr.push(0x80 | len);
        else if (len < 65536) hdr.push(0x80 | 126, len >> 8, len & 0xff);
        else { hdr.push(0x80 | 127); const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); hdr.push(...b); }
        const mask = randomBytes(4);
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
        sock.write(Buffer.concat([Buffer.from(hdr), mask, masked]));
      },
      sendBinary(p) { this.sendFrame(0x2, p); },
      ping() { this.sendFrame(0x9, Buffer.alloc(0)); },
      close(code = 1000) { const b = Buffer.alloc(2); b.writeUInt16BE(code); try { this.sendFrame(0x8, b); } catch {} setTimeout(() => sock.destroy(), 200); },
    };
    sock.on('connect', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on('error', (e) => (open ? conn.onClose({ error: e }) : reject(e)));
    sock.on('close', () => conn.onClose({ tcp: true }));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!open) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        const accept = createHash('sha1').update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (!/^HTTP\/1\.1 101/.test(head) || !head.includes(accept)) return reject(new Error('bad handshake: ' + head.split('\r\n')[0]));
        log(`handshake ok: ${head.split('\r\n').slice(1).join(' | ')}`);
        open = true;
        resolve(conn);
      }
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0], b1 = buf[1];
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const masked = !!(b1 & 0x80);
        if (masked) off += 4;
        if (buf.length < off + len) return;
        let payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) { const m = buf.subarray(off - 4, off); for (let i = 0; i < len; i++) payload[i] ^= m[i & 3]; }
        buf = buf.subarray(off + len);
        conn.onFrame({ fin: !!(b0 & 0x80), rsv: (b0 >> 4) & 7, opcode: b0 & 0xf, len, payload, b0 });
      }
    });
  });
}

// Reassembles fragmented data messages; answers pings; reports close frames.
export function messageStream(conn, { onMessage, onClose, log = () => {} }) {
  let parts = null;
  conn.onFrame = (fr) => {
    log(`  <frame b0=0x${fr.b0.toString(16)} fin=${fr.fin} rsv=${fr.rsv} op=${fr.opcode} len=${fr.len}`);
    if (fr.opcode === 0x9) return conn.sendFrame(0xa, fr.payload);
    if (fr.opcode === 0xa) return;
    if (fr.opcode === 0x8) {
      const code = fr.len >= 2 ? fr.payload.readUInt16BE(0) : null;
      return onClose?.({ code, reason: fr.payload.subarray(2).toString() });
    }
    if (fr.opcode === 0x1 || fr.opcode === 0x2) parts = [fr.payload];
    else if (fr.opcode === 0x0 && parts) parts.push(fr.payload);
    if (fr.fin && parts) { const m = Buffer.concat(parts); parts = null; onMessage(m); }
  };
  conn.onClose = (e) => onClose?.(e);
}
