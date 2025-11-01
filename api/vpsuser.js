import fs from 'fs';

const VPS_USER_FILE = '/tmp/vpsuser.json';

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

export default async (req, res) => {
    const users = loadVpsUsers();
    let formattedUsers = [];

    for (const [token, link] of Object.entries(users)) {
        const fixedLink = link.replace(/https?:\/\/[^\/]+/, 'https://vps-depchai-vercel.app');
        formattedUsers.push({ token, link: fixedLink });
    }

    res.status(200).json({ status: 'success', users: formattedUsers });
};
