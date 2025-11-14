const crypto = require('crypto');

const CALLBACK_SALT = process.env.CALLBACK_SALT || 'vps-manager-salt';

function deriveCallbackSecret(repoFullName = '') {
  return crypto.createHmac('sha256', CALLBACK_SALT).update(repoFullName).digest('hex');
}

module.exports = {
  deriveCallbackSecret,
};
