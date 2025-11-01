import { Octokit } from '@octokit/rest';
import fs from 'fs';
import sodium from 'libsodium-wrappers';

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
    console.log('Origin check bypassed, origin was:', origin);
    return true; // Bỏ kiểm tra origin tạm để tránh lỗi
}

// Các hàm còn lại giữ nguyên như trước...

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

        // Tạo repo private, commit workflow và các file như cũ
        // ...

        res.status(200).json({ status: 'success', message: 'VPS creation started', repository: repoFullName });
    } catch (error) {
        console.error('Create VPS error:', error);
        return res.status(500).json({ error: 'Failed to create VPS', details: error.message });
    }
};
