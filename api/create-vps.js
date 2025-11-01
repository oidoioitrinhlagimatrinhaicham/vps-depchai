import { Octokit } from '@octokit/rest';
import fs from 'fs';
import sodium from 'libsodium-wrappers';

const VPS_USER_FILE = '/tmp/vpsuser.json';

// Save VPS user to temporary storage
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

// Bỏ qua kiểm tra origin hoàn toàn (dùng cho dev/testing)
function checkOrigin(origin) {
    return true;
}

// Helper function to create repo secret
async function createRepoSecret(octokit, owner, repo, secretName, secretValue) {
    try {
        await sodium.ready;
        const { data: { key, key_id } } = await octokit.rest.actions.getRepoPublicKey({
            owner,
            repo,
        });
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
        console.log(`✅ Created/Updated repo secret ${secretName}`);
    } catch (error) {
        console.error('Error creating repo secret:', error);
        throw error;
    }
}

// Helper function to create or update file safely
async function createOrUpdateFile(octokit, owner, repo, path, content, message) {
    try {
        let sha = null;
        try {
            const { data: existingFile } = await octokit.rest.repos.getContent({
                owner,
                repo,
                path,
            });
            sha = existingFile.sha;
        } catch (error) {
            if (error.status !== 404) throw error;
        }
        const params = {
            owner,
            repo,
            path,
            message,
            content: Buffer.from(content).toString('base64'),
        };
        if (sha) {
            params.sha = sha;
        }
        await octokit.rest.repos.createOrUpdateFileContents(params);
        console.log(`${sha ? 'Updated' : 'Created'} file: ${path}`);
    } catch (error) {
        console.error(`Error with file ${path}:`, error.message);
        throw error;
    }
}

// Generate tmate.yml workflow content (giữ nguyên)
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
      - name: ⬇️ Checkout source
        uses: actions/checkout@v4
        with:
          token: \${{ secrets.GH_TOKEN }}
      # ... tiếp các bước tạo VPS ...
`;
}

// Generate auto-start.yml content (giữ nguyên)
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
      - name: 🚀 Trigger VPS Creation
        run: |
          curl -X POST https://api.github.com/repos/${repoFullName}/dispatches \
          -H "Accept: application/vnd.github.v3+json" \
          -H "Authorization: token \${{ secrets.GH_TOKEN }}" \
          -d '{"event_type": "create-vps", "client_payload": {"vps_name": "autovps", "backup": false}}'
`;
}

// Main API handler
export default async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const origin = req.headers.origin;
    if (!checkOrigin(origin)) {
        return res.status(403).json({ error: 'Unauthorized origin', origin });
    }

    const { github_token } = req.body;
    if (!github_token) {
        return res.status(400).json({ error: 'Missing github_token' });
    }
    if (!github_token.startsWith('ghp_') && !github_token.startsWith('github_pat_')) {
        return res.status(400).json({ error: 'Invalid GitHub token format' });
    }

    try {
        const octokit = new Octokit({ auth: github_token });
        const { data: user } = await octokit.rest.users.getAuthenticated();
        console.log(`Connected to GitHub for user: ${user.login}`);

        const repoName = `vps-project-${Date.now()}`;
        const { data: repo } = await octokit.rest.repos.createForAuthenticatedUser({
            name: repoName,
            private: false,
            auto_init: true,
            description: 'VPS Manager - Created by Hiếu Dz',
        });

        const repoFullName = repo.full_name;
        const ngrokServerUrl = `https://${req.headers.host}`;

        // Wait for initial commit to complete
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Create repo secret
        await createRepoSecret(octokit, user.login, repoName, 'GH_TOKEN', github_token);

        // Create workflow files
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
        
## 🖥️ VPS Information
        
- **OS**: Windows Server (Latest)
- **Access**: noVNC Web Interface via Browser
- **Password**: hieudz
- **Runtime**: ~5.5 hours with auto-restart

## 📋 Files
    
- .github/workflows/tmate.yml: Main VPS workflow
- auto-start.yml: Auto-start configuration
- remote-link.txt: Generated VPS access URL (check this file for the link)

## 🚀 Usage

1. The workflow runs automatically after creation
2. Wait 5-10 minutes for setup completion
3. Check remote-link.txt file for your VPS access URL
4. Open the URL in browser and use password: **hieudz**

## ⚡ Features

- Automatic restart on failure
- Windows Server with GUI
- noVNC web-based access
- Cloudflare tunnel for public access

---

*Generated by VPS Manager - hieuvn.xyz*
                `,
                message: 'Update README with VPS info',
            },
        };

        for (const [path, { content, message }] of Object.entries(files)) {
            try {
                await createOrUpdateFile(octokit, user.login, repoName, path, content, message);
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(`Failed to create ${path}:`, error.message);
            }
        }

        await new Promise(resolve => setTimeout(resolve, 5000));

        try {
            await octokit.rest.repos.createDispatchEvent({
                owner: user.login,
                repo: repoName,
                event_type: 'create-vps',
                client_payload: {
                    vps_name: 'initial-vps',
                    backup: true,
                    created_by: 'hieudz-vps-manager',
                },
            });
            console.log(`Workflow triggered for repository: ${repoFullName}`);
        } catch (error) {
            console.error('Error triggering workflow:', error.message);
        }

        return res.status(200).json({
            status: 'success',
            message: 'VPS creation initiated successfully',
            repository: repoFullName,
            workflow_status: 'triggered',
            estimated_ready_time: '5-10 minutes',
            instructions: 'Poll the remote-link.txt file in your repository for the VPS access URL',
        });
    } catch (error) {
        console.error('Error creating VPS:', error);
        if (error.status === 401) {
            return res.status(401).json({
                error: 'Invalid GitHub token. Please check your token permissions.',
                details: error.message,
            });
        }
        return res.status(500).json({ error: 'Failed to create VPS', details: error.message });
    }
};
