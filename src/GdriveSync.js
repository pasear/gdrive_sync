const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const FOLDER_TYPE = 'application/vnd.google-apps.folder';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class GdriveSync {
    constructor (auth) {
        this.drive = google.drive({ version: 'v3', auth });
        this.thread_count = 10;
    }

    async getById(fileId) {
        const { data, status, statusText } = await this.drive.files.get({
            fileId
        });
        if (status !== 200) throw Error(statusText);
        return data;
    }

    async listFiles(remote_parent) {
        const fileMap = new Map();
        let pageToken = null;
        do {
            const { data, status, statusText } = await this.drive.files.list({
                fields: 'nextPageToken, files(id, name, mimeType, size)',
                spaces: 'drive',
                q: `'${remote_parent.id}' in parents`
            });
            if (status !== 200) throw Error(statusText);
            const { files, nextPageToken } = data;
            pageToken = nextPageToken;
            if (Array.isArray(files)) {
                files.forEach((f) => {
                    fileMap.set(f.name, f);
                });
            } else break;
        } while (pageToken);
        return fileMap;
    }

    async uploadFile(local_path, name, remote_parent) {
        console.log('upload file', local_path, remote_parent);
        const fileMetadata = {
            name,
            parents: [remote_parent.id]
        };
        const media = {
            body: fs.createReadStream(local_path)
        };
        const { data, status, statusText } = await this.drive.files.create({
            resource: fileMetadata,
            media,
            fields: 'id, name, mimeType',
            enforceSingleParent: true
        });
        if (status !== 200) throw Error(statusText);
        console.log('upload file', data);
        return data;
    }

    async mkdir(name, remote_parent) {
        console.log('mkdir', name, remote_parent);
        const fileMetadata = {
            name,
            mimeType: FOLDER_TYPE,
            parents: [remote_parent.id]
        };
        const { data, status, statusText } = await this.drive.files.create({
            resource: fileMetadata,
            fields: 'id, name, mimeType'
        });
        if (status !== 200) throw Error(statusText);
        console.log('mkdir', data);
        return data;
    }

    async rm(fObj) {
        console.log('rm', fObj);
        const { status, statusText } = await this.drive.files.delete({
            fileId: fObj.id
        });
        console.log({ status, statusText });
        if (status >= 300) throw Error(statusText);
    }

    async* dfs(local_folder, remote_folder) {
        // copy contents in local_folder to remote_folder
        const [contents, fileMap] = await Promise.all([
            fs.promises.readdir(local_folder, { encoding: 'utf-8', withFileTypes: true }),
            this.listFiles(remote_folder)]);
        contents.sort((a, b) => {
            const t1 = a.isFile() ? 0 : a.isDirectory() ? 1 : 2;
            const t2 = b.isFile() ? 0 : b.isDirectory() ? 1 : 2;
            return t1 - t2;
        });
        // console.log(fileMap);
        // console.log(contents);
        for (const cont of contents) {
            const fp = path.join(local_folder, cont.name);
            if (fileMap.has(cont.name)) {
                const f = fileMap.get(cont.name);
                if (cont.isDirectory()) {
                    if (f.mimeType !== FOLDER_TYPE) await this.rm(f);
                    else continue;
                } else {
                    const stats = await fs.promises.stat(fp);
                    // console.log('same name', stats);
                    if (parseInt(f.size) === stats.size) {
                        console.log('ignore duplicate', fp);
                        continue;
                    } else await this.rm(f);
                }
            }
            if (cont.isFile()) {
                const task = async () => this.uploadFile(fp, cont.name, remote_folder);
                yield task;
            } else if (cont.isDirectory()) {
                const fid = await this.mkdir(cont.name, remote_folder);
                yield* this.dfs(fp, fid);
            }
        }
    }

    async doSync({ localRootFolder, gDriveRootFolderFileId}) {
        const local_root = localRootFolder;
        const remote_root = await this.getById(gDriveRootFolderFileId);

        if (!fs.existsSync(local_root)) throw new Error(`${local_root} does not exist`);
        if (!remote_root.mimeType === FOLDER_TYPE) throw new Error(`Google drive file ID ${gDriveRootFolderFileId} is not a folder`);
        console.log({ local_root, remote_root: remote_root.name });

        let running = 0;
        const max_queue = 5;
        for await (const task of this.dfs(local_root, remote_root)) {
            while (running === max_queue) await sleep(1000);
            (async () => {
                ++running;
                await task();
                --running;
            })();
        }
    }
}

module.exports = GdriveSync;
