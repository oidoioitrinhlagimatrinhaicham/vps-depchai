import { Octokit } from '@octokit/rest';
import fs from 'fs';
import sodium from 'libsodium-wrappers';
const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/([\w\-]+\.)?(hieuvn\.xyz|vps-github\.vercel\.app)(\/.)?$/;
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

// Check if origin is allowed
function checkOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERN.test(origin) || origin.includes('localhost') || origin.includes('127.0.0.1');
}

// Helper function to create repo secret
async function createRepoSecret(octokit, owner, repo, secretName, secretValue) {
  try {
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
      key_id: key_id.toString()
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
    // Try to get existing file first
    let sha = null;
    try {
      const { data: existingFile } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path
      });
      sha = existingFile.sha;
    } catch (error) {
      // File doesn't exist, that's fine
      if (error.status !== 404) {
        throw error;
      }
    }
    // Create or update the file
    const params = {
      owner,
      repo,
      path,
      message,
      content: Buffer.from(content).toString('base64')
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

// Generate tmate.yml workflow content
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
          
          Write-Host "🔍 Checking for port 5900 conflicts..."
          $portCheck = netstat -aon | FindStr :5900
          if ($portCheck) {
            Write-Host "⚠️ Port 5900 is already in use: $portCheck"
            Stop-Process -Id ($portCheck -split '\\s+')[-1] -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 5
          }
          
          Write-Host "🚀 Starting TightVNC server..."
          Start-Process -FilePath "C:\\Program Files\\TightVNC\\tvnserver.exe" -ArgumentList "-run -localhost no" -WindowStyle Hidden -RedirectStandardOutput "vnc_start.log" -RedirectStandardError "vnc_error.log"
          Start-Sleep -Seconds 40
          Get-Content "vnc_start.log" -ErrorAction SilentlyContinue | Write-Host
          Get-Content "vnc_error.log" -ErrorAction SilentlyContinue | Write-Host
          
          netsh advfirewall firewall add rule name="Allow VNC 5900" dir=in action=allow protocol=TCP localport=5900
          netsh advfirewall firewall add rule name="Allow noVNC 6080" dir=in action=allow protocol=TCP localport=6080
          Write-Host "✅ Firewall rules added"
          
          Write-Host "📥 Installing Python dependencies for noVNC and websockify..."
          Write-Host "🔍 Checking Python and pip versions..."
          python --version | Write-Host
          python -m pip --version | Write-Host
          
          $maxPipAttempts = 5
          for ($i = 1; $i -le $maxPipAttempts; $i++) {
            try {
              python -m pip install --upgrade pip --timeout 60 2>&1 | Out-File -FilePath "pip_install.log" -Append -Encoding UTF8
              pip install --force-reinstall numpy novnc websockify==0.13.0 --timeout 60 2>&1 | Out-File -FilePath "pip_install.log" -Append -Encoding UTF8
              Write-Host "✅ Python dependencies installed"
              break
            } catch {
              Write-Host "⚠️ Pip install attempt $i/$maxPipAttempts failed: $_"
              Get-Content "pip_install.log" -ErrorAction SilentlyContinue | Write-Host
              if ($i -eq $maxPipAttempts) {
                Write-Host "❌ Failed to install Python dependencies"
                exit 1
              }
              Start-Sleep -Seconds 10
            }
          }
          
          Write-Host "🔍 Checking noVNC installation via pip..."
          try {
            $novncInfo = pip show novnc
            Write-Host "📜 noVNC package info:"
            Write-Host $novncInfo
            $novncPath = ($novncInfo | Select-String "Location: (.*)").Matches.Groups[1].Value + "\\novnc"
            if (Test-Path "$novncPath") {
              dir $novncPath -Recurse | Write-Host
              if (-not (Test-Path "$novncPath/vnc.html")) {
                Write-Host "❌ noVNC directory is incomplete, vnc.html not found"
                Write-Host "🔄 Falling back to GitHub download..."
                $novncVersion = "v1.6.0"
                $maxDownloadAttempts = 5
                for ($i = 1; $i -le $maxDownloadAttempts; $i++) {
                  try {
                    Write-Host "📥 Downloading noVNC release $novncVersion (attempt $i/$maxDownloadAttempts)..."
                    Remove-Item -Recurse -Force noVNC -ErrorAction SilentlyContinue
                    $novncUrl = "https://github.com/novnc/noVNC/archive/refs/tags/$novncVersion.zip"
                    Write-Host "🔗 Using URL: $novncUrl"
                    $response = Invoke-WebRequest -Uri $novncUrl -OutFile "noVNC.zip" -TimeoutSec 60 -PassThru
                    Write-Host "ℹ️ HTTP Status: $($response.StatusCode) $($response.StatusDescription)"
                    Expand-Archive -Path "noVNC.zip" -DestinationPath "." -Force
                    Move-Item -Path "noVNC-$($novncVersion.Substring(1))" -Destination "noVNC" -Force
                    Write-Host "✅ noVNC downloaded and extracted"
                    $novncPath = "noVNC"
                    break
                  } catch {
                    Write-Host "⚠️ noVNC download attempt $i/$maxDownloadAttempts failed: $_"
                    if ($i -eq $maxDownloadAttempts) {
                      Write-Host "❌ Failed to download noVNC"
                      exit 1
                    }
                    Start-Sleep -Seconds 10
                  }
                }
              }
            } else {
              Write-Host "❌ noVNC directory does not exist, falling back to GitHub download..."
              $novncVersion = "v1.6.0"
              $maxDownloadAttempts = 5
              for ($i = 1; $i -le $maxDownloadAttempts; $i++) {
                try {
                  Write-Host "📥 Downloading noVNC release $novncVersion (attempt $i/$maxDownloadAttempts)..."
                  Remove-Item -Recurse -Force noVNC -ErrorAction SilentlyContinue
                  $novncUrl = "https://github.com/novnc/noVNC/archive/refs/tags/$novncVersion.zip"
                  Write-Host "🔗 Using URL: $novncUrl"
                  $response = Invoke-WebRequest -Uri $novncUrl -OutFile "noVNC.zip" -TimeoutSec 60 -PassThru
                  Write-Host "ℹ️ HTTP Status: $($response.StatusCode) $($response.StatusDescription)"
                  Expand-Archive -Path "noVNC.zip" -DestinationPath "." -Force
                  Move-Item -Path "noVNC-$($novncVersion.Substring(1))" -Destination "noVNC" -Force
                  Write-Host "✅ noVNC downloaded and extracted"
                  $novncPath = "noVNC"
                  break
                } catch {
                  Write-Host "⚠️ noVNC download attempt $i/$maxDownloadAttempts failed: $_"
                  if ($i -eq $maxDownloadAttempts) {
                    Write-Host "❌ Failed to download noVNC"
                    exit 1
                  }
                  Start-Sleep -Seconds 10
                }
              }
            }
          } catch {
            Write-Host "⚠️ Failed to check noVNC package via pip, falling back to GitHub download..."
            $novncVersion = "v1.6.0"
            $maxDownloadAttempts = 5
            for ($i = 1; $i -le $maxDownloadAttempts; $i++) {
              try {
                Write-Host "📥 Downloading noVNC release $novncVersion (attempt $i/$maxDownloadAttempts)..."
                Remove-Item -Recurse -Force noVNC -ErrorAction SilentlyContinue
                $novncUrl = "https://github.com/novnc/noVNC/archive/refs/tags/$novncVersion.zip"
                Write-Host "🔗 Using URL: $novncUrl"
                $response = Invoke-WebRequest -Uri $novncUrl -OutFile "noVNC.zip" -TimeoutSec 60 -PassThru
                Write-Host "ℹ️ HTTP Status: $($response.StatusCode) $($response.StatusDescription)"
                Expand-Archive -Path "noVNC.zip" -DestinationPath "." -Force
                Move-Item -Path "noVNC-$($novncVersion.Substring(1))" -Destination "noVNC" -Force
                Write-Host "✅ noVNC downloaded and extracted"
                $novncPath = "noVNC"
                break
              } catch {
                Write-Host "⚠️ noVNC download attempt $i/$maxDownloadAttempts failed: $_"
                if ($i -eq $maxDownloadAttempts) {
                  Write-Host "❌ Failed to download noVNC"
                  exit 1
                }
                Start-Sleep -Seconds 10
              }
            }
          }
          
          Write-Host "🔍 Checking noVNC directory structure..."
          if (-not (Test-Path "$novncPath/vnc.html")) {
            Write-Host "❌ noVNC directory is incomplete, vnc.html not found"
            exit 1
          }
          
          Write-Host "🔍 Checking for port 6080 conflicts..."
          $portCheck = netstat -aon | FindStr :6080
          if ($portCheck) {
            Write-Host "⚠️ Port 6080 is already in use: $portCheck"
            Stop-Process -Id ($portCheck -split '\\s+')[-1] -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 5
          }
          
          Write-Host "🚀 Starting websockify..."
          Start-Process -FilePath "python" -ArgumentList "-m", "websockify", "6080", "127.0.0.1:5900", "--web", "$novncPath", "--verbose" -RedirectStandardOutput "websockify.log" -RedirectStandardError "websockify_error.log" -NoNewWindow -PassThru
          Start-Sleep -Seconds 15
          Get-Content "websockify.log" -ErrorAction SilentlyContinue | Write-Host
          Get-Content "websockify_error.log" -ErrorAction SilentlyContinue | Write-Host
          
          Write-Host "📥 Installing Cloudflared..."
          Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "cloudflared.exe" -TimeoutSec 60
          Write-Host "✅ Cloudflared downloaded"
          
          Write-Host "🌐 Starting Cloudflared tunnel..."
          Start-Process -FilePath "cloudflared.exe" -ArgumentList "tunnel", "--url", "http://localhost:6080", "--no-autoupdate", "--edge-ip-version", "auto", "--protocol", "http2", "--logfile", "cloudflared.log" -WindowStyle Hidden
          Start-Sleep -Seconds 40
          Get-Content "cloudflared.log" -ErrorAction SilentlyContinue | Write-Host
          
          Write-Host "🚀 Checking noVNC and retrieving Cloudflared URL..."
          
          Write-Host "🔍 Checking for port 5900 and 6080 conflicts..."
          netstat -aon | FindStr :5900 | Write-Host
          netstat -aon | FindStr :6080 | Write-Host
          
          Write-Host "🔍 Checking VNC and websockify processes..."
          Get-Process -Name "tvnserver" -ErrorAction SilentlyContinue | Format-Table -Property Name, Id, StartTime
          Get-Process -Name "python" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*websockify*" } | Format-Table -Property Name, Id, StartTime
          
          $vncReady = $false
          for ($i = 1; $i -le 30; $i++) {
            try {
              $tcpConnection = Test-NetConnection -ComputerName "localhost" -Port 5900 -WarningAction SilentlyContinue
              if ($tcpConnection.TcpTestSucceeded) {
                try {
                  $vncTest = New-Object System.Net.Sockets.TcpClient
                  $vncTest.Connect("127.0.0.1", 5900)
                  Write-Host "✅ VNC server accepting connections"
                  $vncTest.Close()
                  $vncReady = $true
                  break
                } catch {
                  Write-Host "❌ VNC server not accepting connections: $_"
                  Get-Content "vnc_error.log" -ErrorAction SilentlyContinue | Write-Host
                }
              }
            } catch {
              Write-Host "⚠️ VNC connection test failed: $_"
            }
            Write-Host "⏳ Waiting for VNC server... ($i/30)"
            
            if ($i % 10 -eq 0) {
              Write-Host "🔄 Restarting VNC server..."
              Stop-Process -Name "tvnserver" -Force -ErrorAction SilentlyContinue
              Start-Sleep -Seconds 5
              Start-Process -FilePath "C:\\Program Files\\TightVNC\\tvnserver.exe" -ArgumentList "-run -localhost no" -WindowStyle Hidden -RedirectStandardOutput "vnc_start.log" -RedirectStandardError "vnc_error.log"
              Start-Sleep -Seconds 40
              Get-Content "vnc_start.log" -ErrorAction SilentlyContinue | Write-Host
              Get-Content "vnc_error.log" -ErrorAction SilentlyContinue | Write-Host
            }
            Start-Sleep -Seconds 2
          }
          
          if (-not $vncReady) {
            Write-Host "❌ VNC server not ready, exiting..."
            Get-Content "vnc_error.log" -ErrorAction SilentlyContinue | Write-Host
            exit 1
          }
          
          $websockifyReady = $false
          for ($i = 1; $i -le 3; $i++) {
            try {
              $response = Invoke-WebRequest -Uri "http://localhost:6080/vnc.html" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
              Write-Host "✅ noVNC web interface accessible"
              $websockifyReady = $true
              break
            } catch {
              Write-Host "⚠️ noVNC check failed (attempt $i/3): $_"
              Get-Content "websockify.log" -ErrorAction SilentlyContinue | Write-Host
              Get-Content "websockify_error.log" -ErrorAction SilentlyContinue | Write-Host
              Stop-Process -Name "python" -Force -ErrorAction SilentlyContinue
              Start-Sleep -Seconds 5
              Start-Process -FilePath "python" -ArgumentList "-m", "websockify", "6080", "127.0.0.1:5900", "--web", "$novncPath", "--verbose" -RedirectStandardOutput "websockify.log" -RedirectStandardError "websockify_error.log" -NoNewWindow -PassThru
              Start-Sleep -Seconds 15
            }
          }
          
          if (-not $websockifyReady) {
            Write-Host "❌ Failed to start noVNC, exiting..."
            Get-Content "websockify.log" -ErrorAction SilentlyContinue | Write-Host
            Get-Content "websockify_error.log" -ErrorAction SilentlyContinue | Write-Host
            exit 1
          }
          
          Write-Host "🌐 Retrieving Cloudflared URL..."
          $maxAttempts = 180
          $attempt = 0
          $cloudflaredUrl = ""
          
          do {
            $attempt++
            Write-Host "🔄 Checking Cloudflared URL (attempt $attempt/$maxAttempts)"
            Start-Sleep -Seconds 3
            
            if (Test-Path "cloudflared.log") {
              try {
                $logContent = Get-Content "cloudflared.log" -Raw -ErrorAction SilentlyContinue
                if ($logContent -match 'https://[a-zA-Z0-9-]+\\.trycloudflare\\.com') {
                  $cloudflaredUrl = $matches[0]
                  Write-Host "✅ Found Cloudflared URL: $cloudflaredUrl"
                  break
                }
              } catch {
                Write-Host "⚠️ Error reading cloudflared.log: $_"
              }
            }
            
            if ($attempt % 20 -eq 0) {
              Write-Host "🔄 Restarting Cloudflared..."
              Stop-Process -Name "cloudflared" -Force -ErrorAction SilentlyContinue
              Start-Sleep -Seconds 3
              Start-Process -FilePath "cloudflared.exe" -ArgumentList "tunnel", "--url", "http://localhost:6080", "--no-autoupdate", "--edge-ip-version", "auto", "--protocol", "http2", "--logfile", "cloudflared.log" -WindowStyle Hidden
              Start-Sleep -Seconds 40
              Get-Content "cloudflared.log" -ErrorAction SilentlyContinue | Write-Host
            }
          } while ($attempt -lt $maxAttempts)
          
          if ($cloudflaredUrl) {
            $remoteLink = "$cloudflaredUrl/vnc.html"
            Write-Host "🌌 Remote VNC URL: $remoteLink"
            
            $remoteLink | Out-File -FilePath "remote-link.txt" -Encoding UTF8 -NoNewline
            
            try {
              git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
              git config --global user.name "github-actions[bot]"
              git add remote-link.txt
              git commit -m "🔗 Updated remote-link.txt - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" --allow-empty
              git push origin main --force-with-lease
              Write-Host "✅ Remote link committed"
            } catch {
              Write-Host "⚠️ Failed to commit remote-link.txt: $_"
            }
            
            try {
              $body = @{ github_token = "$env:GITHUB_TOKEN_VPS"; vnc_link = $remoteLink } | ConvertTo-Json
              Invoke-RestMethod -Uri "${ngrokServerUrl}/api/vpsuser" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 20
              Write-Host "📤 Remote VNC URL sent to server"
            } catch {
              Write-Host "⚠️ Failed to send remote VNC URL: $_"
            }
          } else {
            Write-Host "❌ Failed to retrieve Cloudflared URL"
            "TUNNEL_FAILED_$(Get-Date -Format 'yyyyMMdd_HHmmss')" | Out-File -FilePath "remote-link.txt" -Encoding UTF8 -NoNewline
            
            git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git config --global user.name "github-actions[bot]"
            git add remote-link.txt
            git commit -m "❌ Tunnel failed - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" --allow-empty
            git push origin main --force-with-lease
          }
        } catch {
          Write-Host "⚠️ Setup failed: $_"
          Get-Content "vnc_error.log" -ErrorAction SilentlyContinue | Write-Host
          Get-Content "pip_install.log" -ErrorAction SilentlyContinue | Write-Host
          Get-Content "websockify.log" -ErrorAction SilentlyContinue | Write-Host
          Get-Content "websockify_error.log" -ErrorAction SilentlyContinue | Write-Host
          Get-Content "cloudflared.log" -ErrorAction SilentlyContinue | Write-Host
          exit 1
        }
        
        Write-Host "🚀 VPS Session Started - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
        Write-Host "🌌 Access noVNC via remote-link.txt URL (Password: hieudz)"
        
        mkdir -Force ".backup"
        
        $totalMinutes = 330
        $restartCheckpoint = 320
        $healthCheckInterval = 15
        $backupInterval = 60
        
        for ($i = 1; $i -le $totalMinutes; $i++) {
          $currentTime = Get-Date -Format 'HH:mm:ss'
          Write-Host "🟢 VPS Running - Minute $i/$totalMinutes ($currentTime)"
          
          if ($i % $backupInterval -eq 0) {
            Write-Host "💾 Creating backup at minute $i..."
            $filesToBackup = @()
            if (Test-Path "links") { $filesToBackup += "links" }
            if (Test-Path "remote-link.txt") { $filesToBackup += "remote-link.txt" }
            if (Test-Path "vnc_start.log") { $filesToBackup += "vnc_start.log" }
            if (Test-Path "vnc_error.log") { $filesToBackup += "vnc_error.log" }
            if (Test-Path "pip_install.log") { $filesToBackup += "pip_install.log" }
            if (Test-Path "websockify.log") { $filesToBackup += "websockify.log" }
            if (Test-Path "websockify_error.log") { $filesToBackup += "websockify_error.log" }
            if (Test-Path "cloudflared.log") { $filesToBackup += "cloudflared.log" }
            
            if ($filesToBackup.Count -gt 0) {
              try {
                $backupName = "${vpsName}_$(Get-Date -Format 'yyyyMMdd_HHmm').zip"
                Compress-Archive -Path $filesToBackup -DestinationPath ".backup/$backupName" -Force
                Write-Host "✅ Backup created: $backupName"
                
                git add .backup/$backupName
                git commit -m "💾 Backup - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" --allow-empty
                git push origin main --force-with-lease
              } catch {
                Write-Host "⚠️ Backup failed: $_"
              }
            }
          }
          
          if ($i -eq $restartCheckpoint) {
            Write-Host "🔁 Preparing restart in $($totalMinutes - $i) minutes..."
          }
          
          Start-Sleep -Seconds 60
        }
        
        Write-Host "⏰ VPS session completed. Preparing restart..."

    - name: 🔄 Auto Restart Workflow
      if: always()
      run: |
        $lockFile = "restart.lock"
        $currentTime = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        
        "RESTART_$(Get-Date -Format 'yyyyMMdd_HHmmss')" | Out-File -FilePath $lockFile -Encoding UTF8
        
        Write-Host "🔁 Initiating workflow restart at $currentTime"
        
        try {
          Stop-Process -Name "cloudflared" -Force -ErrorAction SilentlyContinue
          Stop-Process -Name "python" -Force -ErrorAction SilentlyContinue
          Stop-Process -Name "tvnserver" -Force -ErrorAction SilentlyContinue
        } catch {
          Write-Host "⚠️ Process cleanup failed: $_"
        }
        
        Start-Sleep -Seconds 10
        
        try {
          $headers = @{ "Accept" = "application/vnd.github+json"; "Authorization" = "Bearer $env:GITHUB_TOKEN_VPS"; "Content-Type" = "application/json"; "X-GitHub-Api-Version" = "2022-11-28" }
          
          $payload = @{ event_type = "create-vps"; client_payload = @{ vps_name = "${vpsName}"; restart_time = $currentTime; auto_restart = $true } } | ConvertTo-Json -Depth 2
          
          Invoke-RestMethod -Uri "https://api.github.com/repos/${repoFullName}/dispatches" -Method Post -Headers $headers -Body $payload -TimeoutSec 30
          Write-Host "✅ Workflow restart triggered"
          
          git add $lockFile
          git commit -m "🔄 Auto restart - $currentTime" --allow-empty
          git push origin main --force-with-lease
          
        } catch {
          Write-Host "❌ Restart failed: $_"
          Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
          exit 1
        }
`;
}

// Generate auto-start.yml content
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
          curl -X POST https://api.github.com/repos/${repoFullName}/dispatches \\
          -H "Accept: application/vnd.github.v3+json" \\
          -H "Authorization: token \${{ secrets.GH_TOKEN }}" \\
          -d '{"event_type": "create-vps", "client_payload": {"vps_name": "autovps", "backup": false}}'
`;
}

export default async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
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
    // Validate GitHub token format
    if (!github_token.startsWith('ghp_') && !github_token.startsWith('github_pat_')) {
      return res.status(400).json({ error: 'Invalid GitHub token format' });
    }
    // Initialize Octokit
    const octokit = new Octokit({ auth: github_token });

    // Test GitHub connection
    const { data: user } = await octokit.rest.users.getAuthenticated();
    console.log(`Connected to GitHub for user: ${user.login}`);
    // Create repository
    const repoName = `vps-project-${Date.now()}`;
    const { data: repo } = await octokit.rest.repos.createForAuthenticatedUser({
      name: repoName,
      private: false,
      auto_init: true,
      description: 'VPS Manager - Created by Hiếu Dz'
    });
    const repoFullName = repo.full_name;
    const ngrokServerUrl = `https://${req.headers.host}`;
    // Wait for initial commit to complete
    console.log('Waiting for repository initialization...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Create repo secret
    await createRepoSecret(octokit, user.login, repoName, 'GH_TOKEN', github_token);

    // Create workflow files
    const files = {
      '.github/workflows/tmate.yml': {
        content: generateTmateYml(ngrokServerUrl, repoName, repoFullName),
        message: 'Add VPS workflow'
      },
      'auto-start.yml': {
        content: generateAutoStartYml(repoFullName),
        message: 'Add auto-start configuration'
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
        message: 'Update README with VPS info'
      }
    };
    // Create files in repository with error handling
    for (const [path, { content, message }] of Object.entries(files)) {
      try {
        await createOrUpdateFile(octokit, user.login, repoName, path, content, message);
        // Small delay between file operations
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Failed to create ${path}:`, error.message);
        // Continue with other files even if one fails
      }
    }
    // Wait for files to be committed
    console.log('Waiting for files to be committed...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    // Trigger workflow
    try {
      await octokit.rest.repos.createDispatchEvent({
        owner: user.login,
        repo: repoName,
        event_type: 'create-vps',
        client_payload: {
          vps_name: 'initial-vps',
          backup: true,
          created_by: 'hieudz-vps-manager'
        }
      });
      console.log(`Workflow triggered for repository: ${repoFullName}`);
    } catch (error) {
      console.error('Error triggering workflow:', error.message);
      // Don't fail the entire request if workflow trigger fails
    }
    // Return immediate response, let client poll for remote-link.txt
    return res.status(200).json({
      status: 'success',
      message: 'VPS creation initiated successfully',
      repository: repoFullName,
      workflow_status: 'triggered',
      estimated_ready_time: '5-10 minutes',
      instructions: 'Poll the remote-link.txt file in your repository for the VPS access URL'
    });
  } catch (error) {
    console.error('Error creating VPS:', error);

    if (error.status === 401) {
      return res.status(401).json({ 
        error: 'Invalid GitHub token. Please check your token permissions.',
        details: error.message 
      });
    }

    return res.status(500).json({ 
      error: 'Failed to create VPS',
      details: error.message 
    });
  }
};
