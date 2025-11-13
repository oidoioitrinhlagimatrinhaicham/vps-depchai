const fs = require('fs');

const VPS_USER_FILE = '/tmp/vpsuser.json';

function loadRecords() {
  try {
    if (fs.existsSync(VPS_USER_FILE)) {
      const raw = fs.readFileSync(VPS_USER_FILE, 'utf8');
      if (!raw.trim()) {
        return {};
      }
      return JSON.parse(raw);
    }
  } catch (error) {
    console.error('Failed to read VPS store:', error);
  }
  return {};
}

function saveRecords(records) {
  try {
    fs.writeFileSync(VPS_USER_FILE, JSON.stringify(records, null, 2));
  } catch (error) {
    console.error('Failed to persist VPS store:', error);
  }
}

module.exports = {
  VPS_USER_FILE,
  loadRecords,
  saveRecords,
};
