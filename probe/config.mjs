// Loads the installation settings from config.json in the repo root (or the file named by $TAPHOME_CONFIG).
// Relative paths in the file are resolved against the file's own folder. See config.example.json.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  const file = resolve(process.env.TAPHOME_CONFIG || join(REPO, 'config.json'));
  if (!existsSync(file)) throw new Error(`no ${file}: copy config.example.json to config.json and fill it in`);
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const base = dirname(file);
  const path = (p) => (p ? resolve(base, p) : null);
  const need = (v, name) => { if (!v) throw new Error(`${file}: "${name}" is not set`); return v; };

  const modelDir = path(c.modelDir);
  const cloud = process.env.MODE === 'cloud';
  return {
    file,
    host: process.env.CORE_IP || need(c.host, 'host'),
    modelDir,
    get msgDir() { return join(need(modelDir, 'modelDir'), 'TapHome.Core.Lib.Communication.Messages'); },
    translations: path(c.translations),
    // stored session (SessionId, LocationId, last DbHash) so a tool run doesn't log in again; NO_SESSION=1 disables it
    sessionFile: process.env.NO_SESSION ? null : join(base, '.session.json'),
    salt: c.passwordSalt,
    // MODE=cloud logs in with the TapHome account instead of the Core's local user
    cred() {
      if (cloud) return { u: need(c.cloud?.email, 'cloud.email'), p: need(c.cloud?.password, 'cloud.password'), isLocal: false };
      return { u: need(c.username, 'username'), p: need(c.password, 'password'), isLocal: true };
    },
    // salt may be empty here; openSession throws only when it actually needs to log in (not for a stored session)
    session(extra = {}) {
      return { host: this.host, cred: this.cred(), sessionFile: this.sessionFile, salt: this.salt, ...extra };
    },
  };
}
