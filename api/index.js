const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/([\w\-]+\.)?(hieuvn\.xyz|vps-github\.vercel\.app)(\/.*)?$/;
const VPS_USER_FILE = '/tmp/vpsuser.json';

// Load VPS users from temporary storage
function loadVpsUsers() {
  try {
    if (fs.existsSync(VPS_USER_FILE)) {
      const data = fs.readFileSync(VPS_USER_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading VPS users:', error);
  }
  return {};
}

// Save VPS user to temporary storage
function saveVpsUser(githubToken, remoteLink) {
  try {
    const users = loadVpsUsers();
    users[githubToken] = remoteLink;
    fs.writeFileSync(VPS_USER_FILE, JSON.stringify(users, null, 2));
    console.log(`VPS user saved: ${githubToken.substring(0, 10)}...***`);
  } catch (error) {
    console.error('Error saving VPS user:', error);
  }
}

// Generate tmate.yml workflow content
function generateTmateYml(githubToken, ngrokServerUrl, vpsName, repoFullName) {
  return `name: Create VPS (Auto Restart)

on:
  workflow_dispatch:
  repository_dispatch:
    types: [create-vps]

env:
  VPS_NAME: ${vpsName}
  TMATE_SERVER: nyc1.tmate.io
  GITHUB_TOKEN_VPS: ${githubToken}
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
        token: ${githubToken}

    - name: 🐍 Tạo file VPS info
      run: |
        mkdir -Force links
        "VPS khởi tạo - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -FilePath "links/${vpsName}.txt" -Encoding UTF8

    - name: 🖥️ Cài đặt và chạy TightVNC, noVNC, Cloudflared
      shell: pwsh
      run: |
        Write-Host "📥 Installing TightVNC, noVNC, and Cloudflared..."
        
        try {
          Write-Host "📥 Installing TightVNC..."
          Invoke-WebRequest -Uri "https://www.tightvnc.com/download/2.8.63/tightvnc-2.8.63-gpl-setup-64bit.msi" -OutFile "tightvnc-setup.msi" -TimeoutSec 60
          Write-Host "✅ TightVNC downloaded"
          
          Start-Process msiexec.exe -Wait -ArgumentList '/i tightvnc-setup.msi /quiet /norestart ADDLOCAL="Server" SERVER_REGISTER_AS_SERVICE=1 SERVER_ADD_FIREWALL_EXCEPTION=1 SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_PASSWORD=1 VALUE_OF_PASSWORD=hieudz SET_ACCEPTHTTPCONNECTIONS=1 VALUE_OF_ACCEPTHTTPCONNECTIONS=1 SET_ALLOWLOOPBACK=1 VALUE_OF_ALLOWLOOPBACK=1'
          Write-Host "✅ TightVNC installed"
          
          Write-Host "🔧 Enabling loopback connections in TightVNC registry..."
          Set-ItemProperty -Path "HKLM:\\SOFTWARE\\TightVNC\\Server" -Name "AllowLoopback" -Value 1 -ErrorAction SilentlyContinue
          
          Write-Host "🔍 Stopping any existing tvnserver processes..."
          Stop-Process -Name "tvnserver" -Force -ErrorAction SilentlyContinue
          Stop-Service -Name "tvnserver" -Force -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 5
          
          Write-Host "🚀 Starting TightVNC server..."
          Start-Process -FilePath "C:\\Program Files\\TightVNC\\tvnserver.exe" -ArgumentList "-run -localhost no" -WindowStyle Hidden
          Start-Sleep -Seconds 40
          
          netsh advfirewall firewall add rule name="Allow VNC 5900" dir=in action=allow protocol=TCP localport=5900
          netsh advfirewall firewall add rule name="Allow noVNC 6080" dir=in action=allow protocol=TCP localport=6080
          Write-Host "✅ Firewall rules added"
          
          Write-Host "📥 Installing Python dependencies for noVNC and websockify..."
          python -m pip install --upgrade pip
          pip install novnc websockify==0.13.0
          
          Write-Host "📥 Installing Cloudflared..."
          Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "cloudflared.exe" -TimeoutSec 60
          Write-Host "✅ Cloudflared downloaded"
          
          Write-Host "🚀 Starting websockify..."
          Start-Process -FilePath "python" -ArgumentList "-m", "websockify", "6080", "127.0.0.1:5900", "--web", "C:\\Users\\runneradmin\\AppData\\Local\\Programs\\Python\\Python312\\Lib\\site-packages\\novnc" -WindowStyle Hidden
          Start-Sleep -Seconds 15
          
          Write-Host "🌐 Starting Cloudflared tunnel..."
          Start-Process -FilePath "cloudflared.exe" -ArgumentList "tunnel", "--url", "http://localhost:6080", "--no-autoupdate" -WindowStyle Hidden
          Start-Sleep -Seconds 40
          
          Write-Host "🌐 Retrieving Cloudflared URL..."
          $maxAttempts = 180
          $attempt = 0
          $cloudflaredUrl = ""
          
          do {
            $attempt++
            Write-Host "🔄 Checking Cloudflared URL (attempt $attempt/$maxAttempts)"
            Start-Sleep -Seconds 3
            
            $processes = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
            if ($processes) {
              $logContent = Get-Content "cloudflared.log" -Raw -ErrorAction SilentlyContinue
              if ($logContent -match 'https://[a-zA-Z0-9-]+\\.trycloudflare\\.com') {
                $cloudflaredUrl = $matches[0]
                Write-Host "✅ Found Cloudflared URL: $cloudflaredUrl"
                break
              }
            }
          } while ($attempt -lt $maxAttempts)
          
          if ($cloudflaredUrl) {
            $remoteLink = "$cloudflaredUrl/vnc.html"
            Write-Host "🌌 Remote VNC URL: $remoteLink"
            
            $remoteLink | Out-File -FilePath "remote-link.txt" -Encoding UTF8 -NoNewline
            
            git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git config --global user.name "github-actions[bot]"
            git add remote-link.txt
            git commit -m "🔗 Updated remote-link.txt - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" --allow-empty
            git push origin main
            Write-Host "✅ Remote link committed and pushed"
          } else {
            Write-Host "❌ Failed to retrieve Cloudflared URL after max attempts"
            exit 1
          }
        } catch {
          Write-Host "❌ Setup failed: $_"
          # Trigger restart workflow
          try {
            $headers = @{
              "Authorization" = "token ${env:GITHUB_TOKEN_VPS}"
              "Accept" = "application/vnd.github.v3+json"
            }
            $payload = @{
              "event_type" = "create-vps"
              "client_payload" = @{
                "vps_name" = "restart-vps"
                "backup" = $false
              }
            } | ConvertTo-Json
            Invoke-RestMethod -Uri "https://api.github.com/repos/${repoFullName}/dispatches" -Method Post -Headers $headers -Body $payload -TimeoutSec 30
            Write-Host "✅ Workflow restart triggered"
          } catch {
            Write-Host "❌ Restart failed: $_"
            exit 1
          }
        }
`;
}

// Generate auto-start.yml content
function generateAutoStartYml(githubToken, repoFullName) {
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
      - name: 🚀 Trigger tmate.yml
        run: |
          curl -X POST https://api.github.com/repos/${repoFullName}/dispatches \\
          -H "Accept: application/vnd.github.v3+json" \\
          -H "Authorization: token ${githubToken}" \\
          -d '{"event_type": "create-vps", "client_payload": {"vps_name": "autovps", "backup": false}}'
`;
}

// Check if origin is allowed
function checkOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERN.test(origin) || origin.includes('localhost') || origin.includes('127.0.0.1');  // Thêm localhost tạm thời để test
}

// Main API handler
module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { method, url } = req;
  const urlParts = url.split('/');
  const endpoint = urlParts[urlParts.length - 1];

  try {
    // VPS User endpoint
    if (endpoint === 'vpsuser') {
      if (method === 'GET') {
        const users = loadVpsUsers();
        const usersList = Object.entries(users).map(([token, link]) => ({
          token: token.substring(0, 10) + '***',
          link
        }));
        return res.status(200).json({
          status: 'success',
          total: usersList.length,
          users: usersList
        });
      }

      if (method === 'POST') {
        const { github_token, vnc_link } = req.body;
        
        if (!github_token) {
          return res.status(400).json({ error: 'Missing github_token' });
        }

        if (vnc_link) {
          saveVpsUser(github_token, vnc_link);
          return res.status(200).json({
            status: 'success',
            message: 'VPS user saved successfully',
            github_token: github_token.substring(0, 10) + '***',
            remote_link: vnc_link
          });
        } else {
          const users = loadVpsUsers();
          if (users[github_token]) {
            return res.status(200).json({
              status: 'success',
              remote_link: users[github_token],
              github_token: github_token.substring(0, 10) + '***'
            });
          } else {
            return res.status(404).json({ error: 'VPS user not found' });
          }
        }
      }
    }

    // Main API endpoint
    if (endpoint === 'create-vps' && method === 'POST') {
      const origin = req.headers.origin;
      
      if (!checkOrigin(origin)) {
        return res.status(403).json({ 
          error: 'Unauthorized origin', 
          origin 
        });
      }

      const { github_token } = req.body;
      
      if (!github_token) {
        return res.status(400).json({ error: 'Missing github_token' });
      }

      try {
        // Initialize Octokit
        const octokit = new Octokit({ auth: github_token });
        
        // Get user info
        const { data: user } = await octokit.rest.users.getAuthenticated();
        console.log(`Connected to GitHub for user: ${user.login}`);

        // Create repository
        const repoName = `vps-project-${Date.now()}`;
        const { data: repo } = await octokit.rest.repos.createForAuthenticatedUser({
          name: repoName,
          private: true,
          auto_init: true
        });

        const repoFullName = repo.full_name;
        const ngrokServerUrl = `https://${req.headers.host}`;

        // Create workflow files
        const files = {
          '.github/workflows/tmate.yml': generateTmateYml(github_token, ngrokServerUrl, repoName, repoFullName),
          'auto-start.yml': generateAutoStartYml(github_token, repoFullName)
        };

        for (const [path, content] of Object.entries(files)) {
          await octokit.rest.repos.createOrUpdateFileContents({
            owner: user.login,
            repo: repoName,
            path,
            message: `Add ${path}`,
            content: Buffer.from(content).toString('base64')
          });
        }

        // Trigger workflow
        await octokit.rest.repos.createDispatchEvent({
          owner: user.login,
          repo: repoName,
          event_type: 'create-vps',
          client_payload: {
            vps_name: 'manual-vps',
            backup: true
          }
        });

        // Wait for remote link (simplified - in production you might want to implement polling)
        setTimeout(async () => {
          try {
            const { data: file } = await octokit.rest.repos.getContent({
              owner: user.login,
              repo: repoName,
              path: 'remote-link.txt'
            });
            
            const remoteUrl = Buffer.from(file.content, 'base64').toString('utf8').trim();
            if (remoteUrl && !remoteUrl.includes('TUNNEL_FAILED')) {
              saveVpsUser(github_token, remoteUrl);
            }
          } catch (error) {
            console.log('Remote link not ready yet');
          }
        }, 300000); // Check after 5 minutes

        return res.status(200).json({
          status: 'success',
          message: 'VPS creation initiated',
          repository: repoFullName,
          workflow_status: 'triggered'
        });

      } catch (error) {
        console.error('Error creating VPS:', error);
        return res.status(500).json({ 
          error: 'Failed to create VPS',
          details: error.message 
        });
      }
    }

    return res.status(404).json({ error: 'Endpoint not found' });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
};
