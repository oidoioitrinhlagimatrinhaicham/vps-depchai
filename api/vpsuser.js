const { loadRecords, saveRecords } = require('./vps-store');

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const records = loadRecords();
    const users = Object.values(records).map(sanitizeRecord).sort(sortByUpdatedAt);
    return res.status(200).json({ status: 'success', users });
  }

  if (req.method === 'POST') {
    const { repo, remote_link: remoteLink, callback_secret: callbackSecret, status } = req.body || {};

    if (!repo || !callbackSecret) {
      return res.status(400).json({ error: 'Missing repo or callback_secret' });
    }

    const records = loadRecords();
    const entry = records[repo];

    if (!entry) {
      return res.status(404).json({ error: 'Unknown repo' });
    }

    if (entry.callback_secret !== callbackSecret) {
      return res.status(403).json({ error: 'Invalid callback secret' });
    }

    if (remoteLink) {
      if (!/^https?:\/\//i.test(remoteLink)) {
        return res.status(400).json({ error: 'Invalid remote_link' });
      }
      entry.remote_link = remoteLink;
    }

    const normalizedStatus = status || (entry.remote_link ? 'ready' : entry.status || 'creating');
    entry.status = normalizedStatus;
    entry.updated_at = new Date().toISOString();
    if (normalizedStatus === 'error') {
      delete entry.remote_link;
    }

    records[repo] = entry;
    saveRecords(records);

    return res.status(200).json({ status: 'success' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
