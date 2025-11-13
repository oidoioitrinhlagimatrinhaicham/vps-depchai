const { loadRecords, saveRecords } = require('./vps-store');
const { deriveCallbackSecret } = require('./callback-secret');

function sanitizeRecord(record) {
  const { callback_secret, ...safeRecord } = record;
  return safeRecord;
}

function sortByUpdatedAt(a, b) {
  const aTime = new Date(a.updated_at || 0).getTime();
  const bTime = new Date(b.updated_at || 0).getTime();
  return bTime - aTime;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const records = loadRecords();
    const users = Object.values(records).map(sanitizeRecord).sort(sortByUpdatedAt);
    return res.status(200).json({ status: 'success', users });
  }

  if (req.method === 'POST') {
    const {
      repo,
      remote_link: remoteLink,
      callback_secret: callbackSecret,
      status,
      token_hint: tokenHint,
      requested_at: requestedAt,
    } = req.body || {};

    if (!repo || !callbackSecret) {
      return res.status(400).json({ error: 'Missing repo or callback_secret' });
    }

    const expectedSecret = deriveCallbackSecret(repo);
    if (callbackSecret !== expectedSecret) {
      return res.status(403).json({ error: 'Invalid callback secret' });
    }

    const records = loadRecords();
    const entry = records[repo] || { repo };

    if (remoteLink) {
      if (!/^https?:\/\//i.test(remoteLink)) {
        return res.status(400).json({ error: 'Invalid remote_link' });
      }
      entry.remote_link = remoteLink;
    }

    const normalizedStatus = status || (entry.remote_link ? 'ready' : entry.status || 'creating');
    entry.status = normalizedStatus;
    entry.updated_at = new Date().toISOString();
    if (tokenHint) {
      entry.token_hint = tokenHint;
    }
    if (requestedAt) {
      entry.requested_at = requestedAt;
    } else if (!entry.requested_at) {
      entry.requested_at = entry.updated_at;
    }
    if (normalizedStatus === 'error') {
      delete entry.remote_link;
    }

    records[repo] = entry;
    saveRecords(records);

    return res.status(200).json({ status: 'success' });
  }

  if (req.method === 'DELETE') {
    const { repo } = req.body || {};
    const records = loadRecords();

    if (repo) {
      if (records[repo]) {
        delete records[repo];
        saveRecords(records);
        return res.status(200).json({ status: 'success', removed: 1 });
      }
      return res.status(404).json({ error: 'Record not found' });
    }

    const total = Object.keys(records).length;
    if (total === 0) {
      return res.status(200).json({ status: 'success', removed: 0 });
    }

    saveRecords({});
    return res.status(200).json({ status: 'success', removed: total });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
