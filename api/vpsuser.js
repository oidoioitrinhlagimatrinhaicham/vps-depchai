import fs from 'fs';

// Định nghĩa file lưu trữ user
const VPS_USER_FILE = '/tmp/vpsuser.json';

// Load all users
function loadVpsUsers() {
  try {
    if (fs.existsSync(VPS_USER_FILE)) {
      const data = fs.readFileSync(VPS_USER_FILE, 'utf8');
      return JSON.parse(data);
    }
    return {};
  } catch (error) {
    console.error('Error loading VPS users:', error);
    return {};
  }
}

// Save VPS user (same as before)
function saveVpsUser(githubToken, remoteLink) {
  try {
    let users = loadVpsUsers();
    users[githubToken] = remoteLink;
    fs.writeFileSync(VPS_USER_FILE, JSON.stringify(users, null, 2));
    console.log(`VPS user saved: ${githubToken.substring(0, 10)}...`);
  } catch (error) {
    console.error('Error saving VPS user:', error);
  }
}

export default async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const users = loadVpsUsers();

  if (req.method === 'GET') {
    // Return list of users for Manage tab
    const userList = Object.entries(users).map(([token, link]) => ({
      token: `${token.substring(0, 10)}***`,  // Preview token
      link
    }));
    return res.status(200).json({
      users: userList,
      total: userList.length
    });
  }

  if (req.method === 'POST') {
    try {
      const { github_token, vnc_link } = req.body;

      if (!github_token) {
        return res.status(400).json({ error: 'Missing github_token' });
      }

      if (vnc_link) {
        // Save from workflow
        saveVpsUser(github_token, vnc_link);
        return res.status(200).json({
          status: 'success',
          message: 'VPS link saved successfully'
        });
      } else {
        // Get link for poll
        const remoteLink = users[github_token];
        if (remoteLink) {
          return res.status(200).json({
            status: 'success',
            remote_link: remoteLink
          });
        } else {
          return res.status(404).json({ error: 'VPS user not found' });
        }
      }
    } catch (error) {
      console.error('Error in /vpsuser:', error);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
