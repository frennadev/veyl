// The relayer's keys and deployment, from env only.
'use strict';
const fs = require('fs'); const path = require('path');
const { Keypair } = require('@solana/web3.js');
/// Keys come from env only: RELAYER_SECRET_KEY / POSTMAN_SECRET_KEY (a JSON byte array or base58, for hosts like Render),
/// or RELAYER_KEY / POSTMAN_KEY (a path to a keypair file). Never logged.
function keyFromEnv(env, inline, file) {
  if (env[inline]) { const v = env[inline].trim(); return Keypair.fromSecretKey(v.startsWith('[') ? Uint8Array.from(JSON.parse(v)) : require('bs58').decode(v)); }
  if (env[file]) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(env[file], 'utf8'))));
  return null;
}
/// The deployment: DEPLOY_JSON (the file's contents), DEPLOY_FILE (a path), or deploy.<NETWORK>.json in the repo.
function deployFromEnv(env) {
  if (env.DEPLOY_JSON) return JSON.parse(env.DEPLOY_JSON);
  return JSON.parse(fs.readFileSync(env.DEPLOY_FILE || path.join(__dirname, '..', `deploy.${env.NETWORK || 'local'}.json`), 'utf8'));
}
module.exports = { keyFromEnv, deployFromEnv };
