const { Octokit } = require('@octokit/rest');
const sodium = require('libsodium-wrappers');
const { loadRecords, saveRecords } = require('./vps-store');
const { deriveCallbackSecret } = require('./callback-secret');

const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/(vps-depchai\.vercel\.app|vps-github\.vercel\.app|hieuvn\.xyz)(\/.*)?$/;
const WORKFLOW_MINUTES = 330;

function maskToken(token = '') {
  if (token.length <= 10) {
    return `${token.slice(0, 3)}***`;
  }
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function checkOrigin(origin) {
  if (!origin) return false;
  return (
    ALLOWED_ORIGIN_PATTERN.test(origin) ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1')
  );
}

async function createRepoSecret(octokit, owner, repo, secretName, secretValue) {
  await sodium.ready;
  const { data } = await octokit.rest.actions.getRepoPublicKey({ owner, repo });
  const messageBytes = Buffer.from(secretValue);
  const keyBytes = Buffer.from(data.key, 'base64');
  const encryptedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
  const encrypted = Buffer.from(encryptedBytes).toString('base64');
  await octokit.rest.actions.createOrUpdateRepoSecret({
    owner,
    repo,
    secret_name: secretName,
    encrypted_value: encrypted,
    key_id: data.key_id.toString(),
  });
}

async function createOrUpdateFile(octokit, owner, repo, path, content, message) {
  let sha = null;
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
    sha = data.sha;
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
  if (sha) params.sha = sha;
  await octokit.rest.repos.createOrUpdateFileContents(params);
}

function appendLog(entry, message, timestamp = new Date().toISOString()) {
  if (!message) return entry;
  const safeEntry = entry || {};
  const logs = Array.isArray(safeEntry.logs) ? safeEntry.logs : [];
  logs.push({ message, at: timestamp });
  const maxLogs = 40;
  safeEntry.logs = logs.slice(-maxLogs);
  return safeEntry;
}

function registerPendingVps(repoFullName, tokenHint, requestedAt) {
  const records = loadRecords();
  records[repoFullName] = appendLog({
    repo: repoFullName,
    token_hint: tokenHint,
    status: 'creating',
    updated_at: requestedAt,
    requested_at: requestedAt,
  }, 'Workflow dispatched', requestedAt);
  saveRecords(records);
}

function markRecordError(repoFullName, message) {
  if (!repoFullName) return;
  const records = loadRecords();
  if (!records[repoFullName]) return;
  records[repoFullName] = appendLog({
    ...records[repoFullName],
    status: 'error',
    error: message,
    updated_at: new Date().toISOString(),
  }, `❌ ${message}`);
  saveRecords(records);
}

function buildCallbackUrl(req) {
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = forwardedHost || req.headers.host || process.env.VERCEL_URL || 'localhost:3000';
  const protoHeader = req.headers['x-forwarded-proto'];
  const isLocal = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = protoHeader || (isLocal ? 'http' : 'https');
  return `${protocol}://${host.replace(/\/$/, '')}/api/vpsuser`;
}

function generateTmateYml(repoFullName, callbackUrl, callbackSecret, vpsName, tokenHint, requestedAt) {
  return `name: Create VPS (Auto Restart)

on:
  workflow_dispatch:
  repository_dispatch:
    types: [create-vps]

env:
  VPS_NAME: ${vpsName}
  REPO_FULL_NAME: ${repoFullName}
  CALLBACK_URL: ${callbackUrl}
  CALLBACK_SECRET: ${callbackSecret}
  TOTAL_MINUTES: ${WORKFLOW_MINUTES}
  MACHINE_PASSWORD: hieudz
  TOKEN_HINT: ${tokenHint}
  REQUESTED_AT: ${requestedAt}

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

      - name: Provision Windows VPS
        shell: pwsh
        run: |
          $ErrorActionPreference = 'Stop'

          function Send-Callback([string]$status, [string]$link, [string]$logMessage) {
            $payload = [ordered]@{
              repo = $env:REPO_FULL_NAME
              status = $status
              callback_secret = $env:CALLBACK_SECRET
              token_hint = $env:TOKEN_HINT
              requested_at = $env:REQUESTED_AT
            }
            if ($link) {
              $payload.remote_link = $link
            }
            if ($logMessage) {
              $payload.log_entry = $logMessage
            }
            try {
              $json = $payload | ConvertTo-Json
              Invoke-RestMethod -Uri $env:CALLBACK_URL -Method Post -Body $json -ContentType 'application/json' -TimeoutSec 30 | Out-Null
              Write-Host "📡 Callback gửi: $status"
            } catch {
              Write-Host "⚠️ Callback thất bại: $_"
            }
          }

          function Write-ProgressLog([string]$message) {
            Write-Host $message
            Send-Callback 'log' $null $message
          }

          try {
            Send-Callback 'provisioning' $null 'Bắt đầu cấp phát capsule'

            Write-ProgressLog '📁 Chuẩn bị thư mục links/'
            New-Item -ItemType Directory -Path "links" -Force | Out-Null
            "VPS đang được khởi tạo lúc $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -FilePath "links/$($env:VPS_NAME).txt" -Encoding UTF8

            Write-ProgressLog '🛠️ Cài đặt TightVNC'
            Invoke-WebRequest -Uri 'https://www.tightvnc.com/download/2.8.63/tightvnc-2.8.63-gpl-setup-64bit.msi' -OutFile 'tightvnc.msi' -TimeoutSec 120
            $tightVncArgs = @(
              '/i','tightvnc.msi',
              '/quiet',
              '/norestart',
              'ADDLOCAL=Server',
              'SERVER_REGISTER_AS_SERVICE=1',
              'SERVER_ADD_FIREWALL_EXCEPTION=1',
              'SET_USEVNCAUTHENTICATION=1',
              'VALUE_OF_USEVNCAUTHENTICATION=1',
              'SET_PASSWORD=1',
              "VALUE_OF_PASSWORD=$($env:MACHINE_PASSWORD)",
              'SET_ACCEPTHTTPCONNECTIONS=1',
              'VALUE_OF_ACCEPTHTTPCONNECTIONS=1',
              'SET_ALLOWLOOPBACK=1',
              'VALUE_OF_ALLOWLOOPBACK=1'
            )
            $tightVncArgsString = ($tightVncArgs -join ' ')
            Start-Process msiexec.exe -Wait -ArgumentList $tightVncArgsString

            Write-ProgressLog '🔧 Thiết lập firewall cho cổng 5900 & 6080'
            netsh advfirewall firewall add rule name="Allow VNC 5900" dir=in action=allow protocol=TCP localport=5900 | Out-Null
            netsh advfirewall firewall add rule name="Allow noVNC 6080" dir=in action=allow protocol=TCP localport=6080 | Out-Null

            Write-ProgressLog '📦 Cài đặt Python dependencies'
            python -m pip install --upgrade pip
            pip install novnc websockify==0.11.0
            $noVncPath = (python -c "import novnc, os; print(os.path.dirname(novnc.__file__))").Trim()

            Write-ProgressLog '📥 Tải Cloudflared'
            Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'cloudflared.exe' -TimeoutSec 120

            Write-ProgressLog '🚀 Khởi chạy TightVNC'
            $tightVncDir = Join-Path $env:ProgramFiles 'TightVNC'
            $tightVncExe = Join-Path $tightVncDir 'tvnserver.exe'
            if (-not (Test-Path $tightVncExe)) {
              throw "Không tìm thấy TightVNC tại $tightVncExe"
            }
            Stop-Process -Name 'tvnserver' -Force -ErrorAction SilentlyContinue
            Stop-Service -Name 'tvnserver' -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 3
            Start-Process -FilePath $tightVncExe -ArgumentList '-run' -WindowStyle Hidden
            Start-Sleep -Seconds 10

            Write-ProgressLog '🌐 Khởi chạy websockify'
            $websockifyArgsString = ('-m websockify 6080 127.0.0.1:5900 --web "{0}"' -f $noVncPath)
            Start-Process -FilePath 'python' -ArgumentList $websockifyArgsString -WindowStyle Hidden

            $websockifyReady = $false
            for ($attempt = 1; $attempt -le 40; $attempt++) {
              Start-Sleep -Seconds 3
              try {
                $probe = Test-NetConnection -ComputerName '127.0.0.1' -Port 6080 -WarningAction SilentlyContinue
                if ($probe.TcpTestSucceeded) {
                  $websockifyReady = $true
                  break
                }
              } catch {
                Start-Sleep -Seconds 1
              }
            }

            if (-not $websockifyReady) {
              throw 'Websockify không phản hồi trên cổng 6080'
            }

            Write-ProgressLog '✅ Websockify sẵn sàng'

            Write-ProgressLog '☁️ Kích hoạt Cloudflared'
            $cloudflaredLog = 'cloudflared.log'
            $cloudflaredErrLog = 'cloudflared-error.log'
            Set-Content -Path $cloudflaredLog -Value '' -Encoding UTF8
            Set-Content -Path $cloudflaredErrLog -Value '' -Encoding UTF8
            $cloudflaredExe = Join-Path (Get-Location) 'cloudflared.exe'
            $cloudflaredArgsString = 'tunnel --url http://localhost:6080 --no-autoupdate --loglevel info'
            Start-Process -FilePath $cloudflaredExe -ArgumentList $cloudflaredArgsString -RedirectStandardOutput $cloudflaredLog -RedirectStandardError $cloudflaredErrLog -WindowStyle Hidden

            $cloudflaredUrl = ''
            for ($attempt = 1; $attempt -le 200; $attempt++) {
              Start-Sleep -Seconds 3
              foreach ($logFile in @($cloudflaredLog, $cloudflaredErrLog)) {
                if (Test-Path $logFile) {
                  $logContent = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
                  if ($logContent -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
                    $cloudflaredUrl = $matches[0]
                    break
                  }
                }
              }
              if ($cloudflaredUrl) { break }
            }

            if (-not $cloudflaredUrl) {
              Write-ProgressLog '⚠️ Không tìm thấy URL trong cloudflared logs'
              if (Test-Path $cloudflaredErrLog) {
                Write-Host '📄 cloudflared-error.log nội dung:'
                Write-Host (Get-Content $cloudflaredErrLog -Raw -ErrorAction SilentlyContinue)
              }
              throw 'Không thể lấy đường dẫn Cloudflared'
            }

            $remoteLink = "$cloudflaredUrl/vnc.html"
            Write-ProgressLog "🌌 Remote link: $remoteLink"

            Set-Content -Path 'remote-link.txt' -Value $remoteLink -Encoding UTF8
            git config --global user.email '41898282+github-actions[bot]@users.noreply.github.com'
            git config --global user.name 'github-actions[bot]'
            git add remote-link.txt
            git commit -m "🔗 Updated remote-link.txt - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" --allow-empty
            git push origin HEAD:main

            Send-Callback 'ready' $remoteLink 'Cloudflared tunnel sẵn sàng'

            $totalMinutes = [int]$env:TOTAL_MINUTES
            for ($minute = 1; $minute -le $totalMinutes; $minute++) {
              Start-Sleep -Seconds 60
              if ($minute % 15 -eq 0) {
                Write-Host "⏳ VPS đã chạy $minute / $totalMinutes phút"
              }
            }
          } catch {
            Write-Host "❌ Workflow lỗi: $_"
            Send-Callback 'error' $null "Workflow gặp lỗi: $($_.Exception.Message)"
            throw
          }
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const origin = req.headers.origin;
  if (!checkOrigin(origin)) return res.status(403).json({ error: 'Unauthorized origin', origin });

  const { github_token } = req.body || {};
  if (!github_token) return res.status(400).json({ error: 'Missing github_token' });
  if (!github_token.startsWith('ghp_') && !github_token.startsWith('github_pat_')) {
    return res.status(400).json({ error: 'Invalid GitHub token format' });
  }

  let repoFullName;

  try {
    const octokit = new Octokit({ auth: github_token });
    const { data: user } = await octokit.rest.users.getAuthenticated();

    const repoName = `vps-project-${Date.now()}`;
    const { data: repo } = await octokit.rest.repos.createForAuthenticatedUser({
      name: repoName,
      private: true,
      auto_init: true,
      description: 'VPS Manager - Generated automatically',
    });

    repoFullName = repo.full_name;

    await createRepoSecret(octokit, user.login, repoName, 'GH_TOKEN', github_token);

    const callbackUrl = buildCallbackUrl(req);
    const callbackSecret = deriveCallbackSecret(repoFullName);
    const tokenHint = maskToken(github_token);
    const requestedAt = new Date().toISOString();
    registerPendingVps(repoFullName, tokenHint, requestedAt);

    const files = {
      '.github/workflows/tmate.yml': {
        content: generateTmateYml(repoFullName, callbackUrl, callbackSecret, repoName, tokenHint, requestedAt),
        message: 'Add VPS workflow',
      },
      '.github/workflows/auto-start.yml': {
        content: generateAutoStartYml(repoFullName),
        message: 'Add auto-start configuration',
      },
      'README.md': {
        content: `# VPS Project - ${repoName}\n\nTruy cập VPS bằng Cloudflare Tunnel (tự động cập nhật remote-link.txt).\n\n- Repo: ${repoFullName}\n- Password VNC: hieudz\n- Runtime: ~5.5h\n`,
        message: 'Add project README',
      },
    };

    for (const [path, payload] of Object.entries(files)) {
      await createOrUpdateFile(octokit, user.login, repoName, path, payload.content, payload.message);
      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    await octokit.rest.repos.createDispatchEvent({
      owner: user.login,
      repo: repoName,
      event_type: 'create-vps',
      client_payload: { vps_name: 'initial-vps', backup: true, created_by: 'vps-manager' },
    });

    return res.status(200).json({
      status: 'success',
      message: 'Workflow dispatched. Link sẽ tự cập nhật khi cloudflared sẵn sàng.',
      repository: repoFullName,
    });
  } catch (error) {
    console.error('Create VPS error:', error);
    markRecordError(repoFullName, error.message);
    return res.status(500).json({ error: 'Failed to create VPS', details: error.message });
  }
};
