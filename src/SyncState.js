const fs = require('fs');
const path = require('path');
const config = require('config');
const yaml = require('js-yaml');
const log = require('./utils/log4js').getLogger('SyncState');

const STORE_PATH = path.join(__dirname, '../sync_state.yml');

class SyncState {
  constructor({ path_prefix = '' } = {}) {
    this.path_prefix = path_prefix;
    this.state = {};
  }

  async load() {
    if (fs.existsSync(STORE_PATH)) {
      const store = fs.readFileSync(STORE_PATH, { encoding: 'utf-8' });
      const obj = yaml.safeLoad(store);
      this.path_prefix = obj.path_prefix;
      this.state = obj.state;
    }
  }

  async save() {
    const obj = { path_prefix: this.path_prefix, state: this.state };
    fs.writeFileSync(STORE_PATH, yaml.safeDump(obj), { encoding: 'utf-8' });
    log.info('sync state saved');
  }

  get(abs_path) {
    const rel = this.rel_path(abs_path);
    return this.state[rel] || { ok: false };
  }

  setSuccess(abs_path, fileObj) {
    const rel = this.rel_path(abs_path);
    this.state[rel] = { ok: true, fileObj };
  }

  setFailed(abs_path, http_resp, error) {
    const rel = this.rel_path(abs_path);
    let msg;
    if (error) msg = error.message;
    this.state[rel] = { ok: false, http_resp, error: msg };
  }

  rel_path(abs_path) {
    const absp = String(abs_path);
    if (absp.startsWith(this.path_prefix)) {
      return absp.substring(this.path_prefix.length);
    }
    return abs_path;
  }
}

module.exports = SyncState;
