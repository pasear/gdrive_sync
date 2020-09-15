const fs = require('fs');
const config = require('config');
const path = require('path');
const { google } = require('googleapis');
const BigNumber = require('bignumber.js');
const log = require('./utils/log4js').getLogger('GdriveSync');

const FOLDER_TYPE = config.get('consts.FOLDER_TYPE');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

BigNumber.config({
  FORMAT: {
    prefix: '',
    decimalSeparator: '.',
    groupSeparator: ',',
    groupSize: 3,
    secondaryGroupSize: 0,
    fractionGroupSeparator: ' ',
    fractionGroupSize: 0,
    suffix: ''
  }
});

function doRetransmit(func, pre_retry) {
  return new Promise((resolve, reject) => {
    let count_500 = 0;
    function f() {
      Promise.resolve(func)
      .then(({ data, status, statusText }) => {
        if (status < 300) resolve(data);
        else {
          log.debug('doRetransmit', status, statusText);
          if ((status >= 300 && status < 400) || (status === 429) || (status >= 500 && count_500 < 10)) {
            if (status >= 500) count_500 += 1;
            if (pre_retry) pre_retry().then(() => setTimeout(f, config.schedule.retransmit_interval)).catch((e) => reject(e));
            else setTimeout(f, config.schedule.retransmit_interval);
          } else throw new Error(statusText);
        }
      })
      .catch((error) => {
        reject(error);
      });
    }
    process.nextTick(f);
  });
}

class GdriveSync {
  constructor(auth, app_config, sync_state) {
    this.drive = google.drive({ version: 'v3', auth });
    this.app_config = app_config;
    this.sync_state = sync_state;
    this.cumulated_bytes = new BigNumber(0);
  }

  async getById(fileId) {
    return doRetransmit(this.drive.files.get({
      fileId
    }));
  }

  async listFiles(remote_parent) {
    const fileMap = new Map();
    const q = `'${remote_parent.id}' in parents and trashed = false`;
    const query = {
      fields: 'nextPageToken, files(id, name, mimeType, size, parents)',
      spaces: 'drive',
      q
    };
    try {
      let pageToken = null;
      do {
        if (pageToken) query.pageToken = pageToken;
        const data = await doRetransmit(this.drive.files.list(query));
        const { files, nextPageToken } = data;
        pageToken = nextPageToken;
        if (Array.isArray(files)) {
          files.forEach((f) => {
            fileMap.set(f.name, f);
          });
        } else break;
      } while (pageToken);
    } catch (err) {
      log.error('listFiles', remote_parent, err);
    }
    return fileMap;
  }

  async uploadFile(local_path, name, remote_parent) {
    log.debug('upload file', local_path, remote_parent);
    const fileMetadata = {
      name,
      parents: [remote_parent.id]
    };
    const media = {
      body: fs.createReadStream(local_path)
    };
    try {
      const data = await doRetransmit(this.drive.files.create({
        resource: fileMetadata,
        media,
        fields: 'id, name, mimeType, size',
        enforceSingleParent: true
      }), async () => {
        const query = {
          fields: 'files(id, name, mimeType, size)',
          spaces: 'drive',
          q: `'${remote_parent.id}' in parents and trashed = false and name = '${name}'`
        };
        const ret = await doRetransmit(this.drive.files.list(query));
        if (ret && Array.isArray(ret.files)) {
          await Promise.all(ret.files.map((f) => this.rm(f)));
        }
      });
      this.sync_state.setSuccess(local_path, data);
      this.cumulated_bytes = this.cumulated_bytes.plus(data.size);
      this.display_progress();
      // log.debug('upload file response', data);
      return data;
    } catch (err) {
      log.error('uploadFile', local_path, err);
      return {};
    }
  }

  async mkdir(name, remote_parent, fp) {
    log.debug('mkdir', name, remote_parent);
    const fileMetadata = {
      name,
      mimeType: FOLDER_TYPE,
      parents: [remote_parent.id]
    };
    try {
      const data = await doRetransmit(this.drive.files.create({
        resource: fileMetadata,
        fields: 'id, name, mimeType'
      }));
      this.sync_state.setSuccess(fp, data);
      return data;
    } catch (err) {
      log.error('mkdir', fp, err);
      return {};
    }
  }

  async rm(fObj) {
    log.debug('rm', fObj);
    try {
      await doRetransmit(this.drive.files.delete({
        fileId: fObj.id
      }));
    } catch (err) {
      log.error('rm', fObj, err);
    }
  }

  display_progress() {
    if (this.cumulated_bytes.minus(this.old_bytes).gt(this.level)) {
      this.old_bytes = this.cumulated_bytes;
      log.info('completed bytes:', this.cumulated_bytes.toFormat());
    }
  }

  async* dfs(local_folder, remote_folder) {
    log.info('>', local_folder);
    // copy contents in local_folder to remote_folder
    const [contents] = await Promise.all([fs.promises.readdir(local_folder, { encoding: 'utf-8', withFileTypes: true })]);
    contents.sort((a, b) => {
      const t1 = a.isFile() ? 0 : a.isDirectory() ? 1 : 2;
      const t2 = b.isFile() ? 0 : b.isDirectory() ? 1 : 2;
      return t1 - t2;
    });
    let fileMap = new Map();
    contents.forEach((cont) => {
      const fp = path.join(local_folder, cont.name);
      const { ok, fileObj } = this.sync_state.get(fp);
      if (ok && fileObj) fileMap.set(cont.name, fileObj);
    });
    if (fileMap.size !== contents.length) {
      fileMap = await this.listFiles(remote_folder);
      for (const [k, v] of fileMap.entries()) {
        const fp = path.join(local_folder, k);
        this.sync_state.setSuccess(fp, v);
      }
    }

    // log.debug(remote_folder.name, 'fileMap', fileMap);
    for (const cont of contents) {
      const fp = path.join(local_folder, cont.name);
      if (fileMap.has(cont.name)) {
        const f = fileMap.get(cont.name);
        if (cont.isDirectory()) {
          if (f.mimeType !== FOLDER_TYPE) {
            log.info(`${f.name} should be a folder but get ${f.mimeType}. Deleting file...`);
            await this.rm(f);
            fileMap.delete(cont.name);
          }
        } else {
          const stats = await fs.promises.stat(fp);
          this.cumulated_bytes = this.cumulated_bytes.plus(stats.size);
          this.display_progress();
          if (parseInt(f.size) === stats.size) {
            // log.debug('ignore duplicate', fp);
            continue;
          } else {
            log.info(`${f.name} size mismatch: remote ${f.size}, local ${stats.size}. Deleting...`);
            await this.rm(f);
          }
        }
      }
      if (cont.isFile()) {
        const task = async () => this.uploadFile(fp, cont.name, remote_folder);
        yield task;
      } else if (cont.isDirectory()) {
        let fobj;
        if (fileMap.has(cont.name)) fobj = fileMap.get(cont.name);
        if (!fobj) fobj = await this.mkdir(cont.name, remote_folder, fp);
        // log.debug('fobj', fobj);
        yield* this.dfs(fp, fobj);
      }
    }
  }

  async doSync() {
    const { localRootFolder, gDriveRootFolderFileId } = this.app_config;
    const local_root = localRootFolder;
    const remote_root = await this.getById(gDriveRootFolderFileId);

    if (!fs.existsSync(local_root)) throw new Error(`${local_root} does not exist`);
    if (!remote_root.mimeType === FOLDER_TYPE) throw new Error(`Google drive file ID ${gDriveRootFolderFileId} is not a folder`);
    log.info({ local_root, remote_root: remote_root.name });

    let running = 0;
    const max_concurrency = config.get('consts.max_concurrency');
    this.cumulated_bytes = new BigNumber(0);
    this.old_bytes = new BigNumber(0);
    this.level = new BigNumber(1 << 20);
    for await (const task of this.dfs(local_root, remote_root)) {
      while (running >= max_concurrency) await sleep(1000);
      (async () => {
        ++running;
        try {
          await task();
        } catch (err) {
          log.error(err);
        } finally {
          --running;
        }
      })();
    }
    while (running > 0) {
      await sleep(1000);
    }
  }
}

module.exports = GdriveSync;
