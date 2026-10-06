const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const moment = require('moment-timezone');
const axios = require('axios');
const AdmZip = require('adm-zip');
const mega = require('megajs');
require('dotenv/config');

const zipPath = 'bot.zip';
const extractPath = './';
const botFileName = 'cypher.js';
const RESTART_DELAY = 3000;
const TIMEZONE = 'Africa/Nairobi';
const MAX_RETRIES = 3;
const AXIOS_TIMEOUT = 5000;
let retryCount = 0;

const API_SERVERS = [
  { name: 'one', baseUrl: 'https://host.cypherxbot.space' },
  { name: 'two', baseUrl: 'https://live.cypherxbot.space' },
];

const API_PASSWORD = '********';
const BACKUP_ZIP_URL = 'https://qu.ax/SjOeY.zip';

let coreProcess = null;

const TELEGRAM_TOKEN = '7801027257:AAEjDgfhMVHs-QWdkFibAgBS4OgTRWOG5Jg';
const TELEGRAM_CHAT_ID = '7141254329';

const sendTelegramAlert = async (message) => {
 const text = `[CypherX Update Error]\n\n${message}`;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'Markdown'
      })
    });
  } catch (e) {
    logMessage(`Telegram alert failed: ${e.message}`);
  }
};

function detectPlatform() {
  // Host-provided provider label, e.g. "Brevo Host" (APP_PROVIDER).
  if (process.env.APP_PROVIDER) return process.env.APP_PROVIDER;
  if (process.env.DYNO) return "Heroku";
  if (process.env.RENDER) return "Render";
  if (process.env.PREFIX && process.env.PREFIX.includes("termux")) return "Termux";
  if (process.env.PORTS && process.env.CYPHERX_HOST_ID) return "CypherX Platform";
  if (process.env.P_SERVER_UUID) return "Panel";
  if (process.env.LXC) return "Linux Container (LXC)";
  
  switch (os.platform()) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return "Unknown";
  }
}

const allowedPlatforms = ["Heroku", "Render", "Termux", "Panel", "Windows", "CypherX Platform", "macOS", "Brevo Host"];
const currentPlatform = detectPlatform();

// Also accept any host that advertises itself via APP_PROVIDER.
const platformAllowed = allowedPlatforms.includes(currentPlatform) || !!process.env.APP_PROVIDER;

if (!platformAllowed) {
  console.error(`🚫 Platform "${currentPlatform}" is not allowed! Crashing infinitely...`);
  
  const crashInfinitely = () => {
    setTimeout(() => {
      console.log("💥 Crashing again...");
      process.exit(1);
    }, 1000);
  };
  
  crashInfinitely();
  
  process.on('uncaughtException', crashInfinitely);
  process.on('unhandledRejection', crashInfinitely);

}

const envPath = path.join(__dirname, '.env');

if (!fs.existsSync(envPath)) {
  const platform = detectPlatform();
  
  if (platform === "Panel" || platform === "Termux" || process.env.APP_PROVIDER) {
    const defaultSessionId = '';
    const envContent = `SESSION_ID=${defaultSessionId}\n`;
    
    fs.writeFileSync(envPath, envContent);
   // console.log('.env file created with default SESSION_ID');
  }
}

function getLogFileName() {
    return `${moment().tz(TIMEZONE).format('YYYY-MM-DD')}.log`;
}

function createTmpFolder() {
    const folderPath = path.join(__dirname, 'tmp');
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath);
}

createTmpFolder();

function logMessage(message) {
    const timestamp = moment().tz(TIMEZONE).format('HH:mm z');
    console.log(`[CYPHER-X] ${message}`);
    fs.appendFileSync(path.join(__dirname, 'tmp', getLogFileName()), `[${timestamp}] ${message}\n`);
}

const DOWNLOAD_METHODS = [
  { name: '2', path: '/local-zip' },    
  { name: '1', path: '/latest-update' },
  { name: '3', path: '/latest-mega' }  
];

async function downloadFromMega(url) {
  return new Promise((resolve, reject) => {
    const file = mega.File.fromURL(url);
    file.loadAttributes((err) => {
      if (err) return reject(err);
      
      file.download((err, data) => {
        if (err) return reject(err);

        if (!Buffer.isBuffer(data)) {
          if (data && typeof data.pipe === "function") {
            const chunks = [];
            data.on("data", (c) => chunks.push(c));
            data.on("end", () =>
              fs.writeFile(zipPath, Buffer.concat(chunks), (e) =>
                e ? reject(e) : resolve(),
              ),
            );
            data.on("error", reject);
            return;
          }
          if (typeof data === "string") data = Buffer.from(data);
          else return reject(new Error("Mega returned invalid data"));
        }

        fs.writeFile(zipPath, data, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });
  });
}

async function tryDownloadFromServer(server, method) {
  try {
    const url = `${server.baseUrl}${method.path}?password=${API_PASSWORD}`;
    logMessage(`Trying method ${method.name} from server ${server.name}...`);

    if (method.name === '3' || method.name === '2') {
      if (method.name === '3') {
        const response = await axios.get(url, { timeout: AXIOS_TIMEOUT });
        if (response.data.status === 'success') {
          await downloadFromMega(response.data.latest);
          return { success: true, server: server.name, method: method.name };
        }
      } else { 
        const response = await axios({
          url,
          method: 'GET',
          responseType: 'stream',
          timeout: AXIOS_TIMEOUT
        });

        const writer = fs.createWriteStream(zipPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        return { success: true, server: server.name, method: method.name };
      }
    } else { 
      const response = await axios.get(url, { timeout: AXIOS_TIMEOUT });
      if (response.data.status === 'success') {
        await downloadFile(response.data.latest, zipPath);
        return { success: true, server: server.name, method: method.name };
      }
    }
  } catch (err) {
    logMessage(`Failed method ${method.name} from server  ${server.name}: ${err.message}`);
   await sendTelegramAlert(`❌ Failed method ${method.name} from server ${server.name}\nReason: ${err.message}`);
    return { success: false };
  }
  return { success: false };
}

async function downloadWithFallback() {
  for (const method of DOWNLOAD_METHODS) {
    for (const server of API_SERVERS) {
      const result = await tryDownloadFromServer(server, method);
      if (result.success) {
        logMessage(`Successfully connected via method ${method.name} from server ${server.name}`);
        return;
      }
    }

    logMessage(`All servers failed for method ${method.name}`);
   await sendTelegramAlert(`🚨 All download methods for method ${method.name} failed on ${detectPlatform()}!`);
  }

  try {
    logMessage('Falling back to hardcoded backup');
    await downloadFile(BACKUP_ZIP_URL, zipPath);
  } catch (err) {
    throw new Error('All download methods including hardcoded fallback failed');
  }
}

async function downloadFile(url, dest) {
  try {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: AXIOS_TIMEOUT
    });

    const writer = fs.createWriteStream(dest);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    throw new Error(`Download failed: ${error.message}`);
  }
}

const PRESERVE_PATHS = [
    './src/Database',
    './node_modules',
    './src/Session',
    './index.js',
    './tmp',
    './.env',
    './app.json',
    './.heroku',       
    './vendor',
    './package.json',
];


async function extractZip(zipFile, outputPath) {
    try {
    
    const EXISTING_PRESERVE_PATHS = PRESERVE_PATHS.filter(p => fs.existsSync(p)).map(p => path.resolve(p));

const shouldPreserve = (filePath) => {
    const resolvedPath = path.resolve(filePath);
    return EXISTING_PRESERVE_PATHS.some(preservePath => resolvedPath.startsWith(preservePath));
}; 
        logMessage('Processing...');
        const zip = new AdmZip(zipFile);
        const zipEntries = zip.getEntries();
        const getAllFiles = (dir, fileList = []) => {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);

                if (shouldPreserve(filePath)) return;

                if (stat.isDirectory()) {
                    getAllFiles(filePath, fileList);
                } else {
                    fileList.push(filePath);
                }
            });
            return fileList;
        };

        const allFiles = getAllFiles(outputPath);
        allFiles.forEach(filePath => {
            if (!shouldPreserve(filePath)) {
                fs.unlinkSync(filePath);
            }
        });

        const getAllDirs = (dir, dirList = []) => {
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const filePath = path.join(dir, file);
                if (fs.statSync(filePath).isDirectory()) {
                    if (!shouldPreserve(filePath)) {
                        getAllDirs(filePath, dirList);
                        dirList.push(filePath);
                    }
                }
            });
            return dirList;
        };

        const allDirs = getAllDirs(outputPath);
        allDirs.sort((a, b) => b.length - a.length);
        allDirs.forEach(dirPath => {
            try {
                if (!shouldPreserve(dirPath)) {
                    fs.rmdirSync(dirPath);
                }
            } catch (e) {
            }
        });

        zipEntries.forEach((entry) => {
            const entryPath = path.join(outputPath, entry.entryName);

            if (shouldPreserve(entryPath)) return;

            const entryDir = path.dirname(entryPath);
            if (!fs.existsSync(entryDir)) {
                fs.mkdirSync(entryDir, { recursive: true });
            }

            if (!entry.isDirectory) {
                fs.writeFileSync(entryPath, zip.readFile(entry));
            } else {
                if (!fs.existsSync(entryPath)) {
                    fs.mkdirSync(entryPath, { recursive: true });
                }
            }
        });

        logMessage('Processed successfully.');
    } catch (error) {
        throw new Error(`Extraction failed: ${error.message}`);
    }
}


async function installDependencies() {
    return new Promise((resolve, reject) => {
        logMessage('Installing dependencies...');
        const npmPath = path.join(path.dirname(process.execPath), 'npm');

const installProcess = spawn(npmPath, ['install'], {
    stdio: 'inherit',
    shell: false,
    windowsHide: true
});
        installProcess.on('close', (code) => {
            if (code === 0) {
                logMessage('Dependencies installed successfully');
                resolve();
            } else {
                reject(new Error(`npm install failed with code ${code}`));
            }
        });

        installProcess.on('error', (err) => {
            reject(new Error(`npm install error: ${err.message}`));
        });
    });
}

const _attemptedDeps = new Set();

function extractMissingModule(message) {
    const m = String(message || '').match(/Cannot find module ['"]([^'"]+)['"]/);
    return m ? m[1] : null;
}

function installMissingDeps(moduleName) {
    return new Promise((resolve, reject) => {
        logMessage(`Missing dependency detected: ${moduleName}. Installing...`);
        const env = {
            ...process.env,
            npm_config_loglevel: 'error',
            CI: 'true'
        };
        const install = spawn('npm', ['install', moduleName, '--no-audit', '--no-fund'], {
            stdio: 'pipe',
            shell: true,
            env
        });
        install.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`Failed to install ${moduleName} (exit code ${code})`));
            }
            logMessage(`Installed ${moduleName}.`);
            resolve(true);
        });
        install.on('error', (err) => {
            reject(new Error(`Process error: ${err.message}`));
        });
    });
}

async function startBot(botFile) {
    return new Promise((resolve, reject) => {
        logMessage(`Starting ${retryCount + 1}/${MAX_RETRIES}...`);
        const logFilePath = path.join(__dirname, 'tmp', getLogFileName());
        const errorLogStream = fs.createWriteStream(logFilePath, { flags: 'a' });
        let stderrTail = '';

        coreProcess = spawn(process.execPath, [botFile], {
    stdio: ['inherit', 'inherit', 'pipe'],
    shell: false,          
    windowsHide: true,
    env: {
        ...process.env,
        FORCE_COLOR: '3',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
    }
});

        coreProcess.stderr.on('data', (data) => {
            process.stderr.write(data);
            const cleanData = data.toString().replace(/\x1B\[[0-9;]*[mGK]/g, '');
            const timestamp = `[${moment().tz(TIMEZONE).format('HH:mm z')}] `;
            errorLogStream.write(timestamp + cleanData);
            stderrTail += cleanData;
            if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);
        });

        const handleProcessExit = (code) => {
            errorLogStream.end();
            logMessage(`Bot process exited with code: ${code}`);
            const missing = stderrTail ? extractMissingModule(stderrTail) : null;
            const error = missing
                ? new Error(`Cannot find module '${missing}'`)
                : (code !== 0 ? new Error(`Bot process exited with code: ${code}`) : null);
            handleRetry(error);
        };

        const handleProcessError = (err) => {
            errorLogStream.end();
            logMessage(`Bot process error: ${err.message}`);
            handleRetry(err);
        };

        coreProcess.on('close', handleProcessExit);
        coreProcess.on('error', handleProcessError);

        const handleShutdown = (signal) => {
            logMessage(`Shutting down CypherX due to ${signal}...`);
            coreProcess.kill();
            errorLogStream.end();
            process.exit(0);
        };

        process.on('SIGINT', handleShutdown);
        process.on('SIGTERM', handleShutdown);

        resolve(); 
    });
}

const GITHUB_REPO = 'TristanCage/CypherX';
const GITHUB_ZIP_URL = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
const AUTO_UPDATE_PRESERVE_PATHS = [
    './node_modules',
    './tmp',
    './.env',
    './session',
    './src/Session',
    './src/Database',
    './all/database',
    './bot.zip',
    './.heroku',
    './vendor'
];

function getIndexHash(filePath) {
    try {
        return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
        return '';
    }
}

async function checkLauncherRefresh() {
    try {
        const before = getIndexHash(path.join(__dirname, 'index.js'));

        const tempZip = path.join(os.tmpdir(), 'cypherx-auto-update.zip');
        const tempDir = path.join(os.tmpdir(), 'cypherx-auto-update-extract');
        fs.rmSync(tempZip, { force: true });
        fs.rmSync(tempDir, { recursive: true, force: true });
        const response = await axios({ url: GITHUB_ZIP_URL, method: 'GET', responseType: 'stream', timeout: 60000 });
        const writer = fs.createWriteStream(tempZip);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        const zip = new AdmZip(tempZip);
        zip.extractAllTo(tempDir, true);
        const entries = fs.readdirSync(tempDir, { withFileTypes: true }).filter(d => d.isDirectory());
        const extractedFolder = entries.find(d => fs.existsSync(path.join(tempDir, d.name, 'package.json'))) || entries[0];
        if (!extractedFolder) throw new Error('Could not locate extracted repository folder');
        const sourcePath = path.join(tempDir, extractedFolder.name);

        const copyFiles = (src, dest) => {
            const items = fs.readdirSync(src);
            items.forEach(item => {
                const srcPath = path.join(src, item);
                const destPath = path.join(dest, item);
                const relativePath = './' + path.relative(__dirname, destPath);
                if (AUTO_UPDATE_PRESERVE_PATHS.some(p => relativePath.startsWith(p))) return;
                if (fs.statSync(srcPath).isDirectory()) {
                    if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
                    copyFiles(srcPath, destPath);
                } else {
                    fs.copyFileSync(srcPath, destPath);
                }
            });
        };
        copyFiles(sourcePath, __dirname);
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.unlinkSync(tempZip);

        const after = getIndexHash(path.join(__dirname, 'index.js'));
        if (before !== after) {
            logMessage('Running Update ...');
            return true;
        }
        logMessage('Bot is Up to Date ...');
        return false;
    } catch (error) {
        logMessage('Skipping Update ...');
        return false;
    }
}

async function main() {
    try {
        const refreshed = await checkLauncherRefresh();
        if (refreshed) {
            stopParent();
            reloadLauncher();
            return;
        }
        await downloadWithFallback();
        await extractZip(zipPath, extractPath);
        // await installDependencies();
        await startBot(botFileName);
        resetRetryCount(); 
    } catch (error) {
        logMessage(`Fatal error during initialization: ${error.message}`);
        handleRetry(error);
    }
}

function stopParent() {
    if (coreProcess && !coreProcess.killed) {
        try { coreProcess.kill('SIGKILL'); } catch (e) { logMessage(`Failed to stop old bot process: ${e.message}`); }
    }
    coreProcess = null;
}

function reloadLauncher() {
    try {
        const entry = require.resolve(__filename);
        delete require.cache[entry];
        delete require.cache[require.resolve('./package.json')];
        require(entry);
        logMessage('Done ...');
    } catch (error) {
        logMessage(`Failed to reload launcher: ${error?.message || error}. Exiting to let platform restart.`);
        process.exit(1);
    }
}

async function handleRetry(error) {
    const missing = error ? extractMissingModule(error.message) : null;

    if (missing && !_attemptedDeps.has(missing)) {
        _attemptedDeps.add(missing);
        retryCount = 0;
        try {
            await installMissingDeps(missing);
            logMessage(`Missing dependency installed. Restarting bot...`);
            main();
            return;
        } catch (e) {
            logMessage(`Failed to install ${missing}: ${e.message}`);
        }
    }

    if (error && retryCount < MAX_RETRIES - 1) {
        retryCount++;
        logMessage(`Retrying (Attempt ${retryCount}/${MAX_RETRIES})...`);
        setTimeout(main, RESTART_DELAY);
    } else {
        if (error) {
            logMessage(`Max retries (${MAX_RETRIES}) reached. Exiting due to error: ${error.message}`);
        } else {
            logMessage(`Max retries (${MAX_RETRIES}) reached. Exiting.`);
        }
        process.exit(1);
    }
}

function resetRetryCount() {
    retryCount = 0;
}

main();
