const fs = require('fs');
const path = require('path');
const config = require('config');
const readline = require('readline');
const yaml = require('js-yaml');
const { google } = require('googleapis');
const GdriveSync = require('./GdriveSync');
const SyncState = require('./SyncState');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = path.join(__dirname, '../token.json');

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 * @param {Object} credentials The authorization client credentials.
 */
async function authorize(credentials) {
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  try {
      const token = await fs.promises.readFile(TOKEN_PATH, { encoding: 'utf-8' });
      oAuth2Client.setCredentials(JSON.parse(token));
      return oAuth2Client;
  } catch (err) {
    return getAccessToken(oAuth2Client);
  }
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
 */
async function getAccessToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
    rl.question('Enter the code from that page here: ', (code) => {
        rl.close();
        oAuth2Client.getToken(code, (err, token) => {
          if (err) {
            console.error('Error retrieving access token', err);
            return reject(err);
          }
          oAuth2Client.setCredentials(token);
          fs.writeFile(TOKEN_PATH, JSON.stringify(token), { encoding: 'utf-8' }, (err) => {
            if (err) {
                console.error(err);
                return reject(err);
            }
            console.log('Token stored to', TOKEN_PATH);
            resolve(oAuth2Client);
          });
        });
      });
  });
}

async function setup() {
    const secret = await fs.promises.readFile(path.join(__dirname, '../client_secret.json'), { encoding: 'utf-8' });
    return authorize(JSON.parse(secret));
}

/**
 * Lists the names and IDs of up to 10 files.
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */

async function main() {
  const app_cfg = yaml.safeLoad(fs.readFileSync(path.join(__dirname, '../app.yml'), { encoding: 'utf-8' }));
  const auth = await setup();
  const sync_state = new SyncState({ path_prefix: app_cfg.localRootFolder || '' });
  await sync_state.load();
  const gd = new GdriveSync(auth, app_cfg, sync_state);
  setInterval(() => sync_state.save(), config.schedule.sync_state_save * 1000 * 60);
  try {
    await gd.doSync();
  } finally {
    await sync_state.save();
    process.exit(0);
  }
}

main();
