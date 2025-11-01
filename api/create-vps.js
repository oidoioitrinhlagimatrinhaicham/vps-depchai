import { Octokit } from '@octokit/rest';
import fs from 'fs';
import sodium from 'libsodium-wrappers';

const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/(vps-depchai\.vercel\.app)(\/.*)?$/;
const VPS_USER_FILE = '/tmp/vpsuser.json';

function saveVpsUser(githubToken, remoteLink) {
    try {
        let users = {};
        if (fs.existsSync(VPS_USER_FILE)) {
            const data = fs.readFileSync(VPS_USER_FILE, 'utf8');
            users = JSON.parse(data);
        }
        users[githubToken] = remoteLink;
        fs.writeFileSync(VPS_USER_FILE, JSON.stringify(users, null, 2));
        console.log(`VPS user saved: ${githubToken.substring(0, 10)}...`);
    } catch (error) {
        console.error('Error saving VPS user:', error);
    }
}

function checkOrigin(origin) {
    if (!origin) return false;
    return ALLOWED_ORIGIN_PATTERN.test(origin) || origin.includes('localhost') || origin.includes('127.0.0.1');
}

async function createRepoSecret(octokit, owner, repo, secretName, secretValue) {
    await sodium.ready;
    const { data: { key, key_id } } = await octokit.rest.actions.getRepoPublicKey({ owner, repo });
    const messageBytes = Buffer.from(secretValue);
    const keyBytes = Buffer.from(key, 'base64');
    const encryptedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
    const encrypted = Buffer.from(encryptedBytes).toString('base64');
    await octokit.rest.actions.createOrUpdateRepoSecret({
        owner,
        repo,
        secret_name: secretName,
        encrypted_value: encrypted,
        key_id: key_id.toString(),
    });
    console.log(`Created/Updated repo secret ${secretName}`);
}

async function createOrUpdateFile(octokit, owner, repo, path, content, message) {
    let sha = null;
    try {
        const { data: existingFile } = await octokit.rest.repos.getContent({ owner, repo, path });
        sha = existingFile.sha;
    } catch (error) {
        if (error.status !== 404) throw error;
    }
    const params = { owner, repo, path, message, content: Buffer.from(content).toString('base64') };
    if (sha) params.sha = sha;
    await octokit.rest.repos.createOrUpdateFileContents(params);
    console.log(`${sha ? 'Updated' : 'Created'} file: ${path}`);
}

function generateTmateYml(ngrokServerUrl, vpsName, repoFullName) {
    return `name: Create VPS (Auto Restart)
on:
  workflow_dispatch:
  repository_dispatch:
    types: [create-vps]
env:
  VPS_NAME: ${vpsName}
  TMATE_SERVER: nyc1.tmate.io
  GITHUB_TOKEN_VPS: \${{ secrets.GH_TOKEN }}
  NGROK_SERVER_URL: ${ngrokServerUrl}
jobs:
  deploy:
    runs-on: windows-latest
    permissions:
      contents: write
      actions: write
    steps:
      - name: Checkout source
        uses: actions/checkout@v4
        with:
          token: \${{ secrets.GH_TOKEN }}
      # Các bước tạo VPS và ghi file remote-link.txt
`;
}

function generateAutoStartYml(repoFullName) {
    return `name: Auto Start VPS on Push
on:
  push:
    branches: [main]
    paths-ignore:
      - 'restart.lock'
      - '.backup/**'
      - 'links/**'
jobs:
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger VPS Creation
        run: |
          curl -X POST https://api.github.com/repos/${repoFullName}/dispatches \\
          -H "Accept: application/vnd.github.v3+json" \\
          -H "Authorization: token \${{ secrets.GH_TOKEN }}" \\
          -d '{"event_type": "create-vps", "client_payload": {"vps_name": "autovps", "backup": false}}'
`;
}

export default async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const origin = req.headers.origin;
    if (!checkOrigin(origin)) return res.status(403).json({ error: 'Unauthorized origin', origin });

    const { github_token } = req.body;
    if (!github_token) return res.status(400).json({ error: 'Missing github_token' });
    if (!github_token.startsWith('ghp_') && !github_token.startsWith('github_pat_'))
        return res.status(400).json({ error: 'Invalid GitHub token format' });

    try {
        const octokit = new Octokit({ auth: github_token });
        const { data: user } = await octokit.rest.users.getAuthenticated();
        console.log(`Connected to GitHub: ${user.login}`);

        const repoName = `vps-project-${Date.now()}`;
        const { data: repo } = await octokit.rest.repos.createForAuthenticatedUser({
            name: repoName,
            private: true,
            auto_init: true,
            description: 'VPS Manager - Created by Hiếu Dz',
        });
        const repoFullName = repo.full_name;
        const ngrokServerUrl = `https://${req.headers.host}`;

        await new Promise(resolve => setTimeout(resolve, 3000));
        await createRepoSecret(octokit, user.login, repoName, 'GH_TOKEN', github_token);

        const files = {
            '.github/workflows/tmate.yml': {
                content: generateTmateYml(ngrokServerUrl, repoName, repoFullName),
                message: 'Add VPS workflow',
            },
            'auto-start.yml': {
                content: generateAutoStartYml(repoFullName),
                message: 'Add auto-start configuration',
            },
            'README.md': {
                content: `# VPS Project - ${repoName}
## VPS Information
- OS: Windows Server (Latest)
- Access: noVNC Web Interface
- Password: hieudz
- Runtime approx 5.5 hours with auto-restart
## Files
- .github/workflows/tmate.yml: main workflow
- auto-start.yml: auto start config
- remote-link.txt: VPS access link (check this file)
## Usage
1. Workflow runs automatically
2. Wait 5-10 mins for setup
3. Check remote-link.txt for access link
4. Open in browser - pass: hieudz
*Generated by VPS Manager*`,
                message: 'Update README',
            }
        };

        for (const [path, { content, message }] of Object.entries(files)) {
            await createOrUpdateFile(octokit, user.login, repoName, path, content, message);
            await new Promise(r => setTimeout(r, 1000));
        }

        await new Promise(r => setTimeout(r, 5000));

        await octokit.rest.repos.createDispatchEvent({
            owner: user.login,
            repo: repoName,
            event_type: 'create-vps',
            client_payload: { vps_name: 'initial-vps', backup: true, created_by: 'hieudz-vps-manager' }
        });

        return res.status(200).json({ status: 'success', message: 'VPS creation started', repository: repoFullName });
    } catch (error) {
        console.error('Create VPS error:', error);
        return res.status(500).json({ error: 'Failed to create VPS', details: error.message });
    }
};
