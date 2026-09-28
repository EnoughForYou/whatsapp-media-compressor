import fs from 'node:fs';
import path from 'node:path';

function findWinGetExecutable(name: string): string | null {
  const localAppData = process.env.LOCALAPPDATA || '';
  if (!localAppData) return null;
  const wingetPkg = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  if (!fs.existsSync(wingetPkg)) return null;

  function scan(dir: string, target: string, depth = 0): string | null {
    if (depth > 4) return null;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const res = scan(full, target, depth + 1);
          if (res) return res;
        } else if (entry.name.toLowerCase() === target.toLowerCase()) {
          return full;
        }
      }
    } catch {
      // Ignore permission or read errors
    }
    return null;
  }

  return scan(wingetPkg, name);
}

function resolveBinary(configured: string | undefined, defaultName: string): string {
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  const wingetMatch = findWinGetExecutable(defaultName.endsWith('.exe') ? defaultName : `${defaultName}.exe`);
  if (wingetMatch) {
    return wingetMatch;
  }
  return defaultName;
}

export const serverConfig = {
  // WhatsApp Cloud API
  waToken: process.env.WA_TOKEN || '',
  waPhoneNumberId: process.env.WA_PHONE_NUMBER_ID || '',
  waRecipient: (process.env.WA_RECIPIENT || '').replace(/[^0-9]/g, ''),
  waGroupUrl: process.env.WA_GROUP_URL || '',
  waVerifyToken: process.env.WA_VERIFY_TOKEN || 'compressor_verify_secret_token',
  waAppSecret: process.env.WA_APP_SECRET || '',
  waApiVersion: process.env.WA_API_VERSION || 'v22.0',

  // Storage
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  fileTtlHours: Number.parseInt(process.env.FILE_TTL_HOURS || '2', 10),
  maxConcurrentVideoJobs: Number.parseInt(process.env.MAX_CONCURRENT_VIDEO_JOBS || '1', 10),

  // Media Binaries
  ffmpegPath: resolveBinary(process.env.FFMPEG_PATH, 'ffmpeg'),
  ffprobePath: resolveBinary(process.env.FFPROBE_PATH, 'ffprobe'),
};

// Ensure data directories exist
export function initDirectories() {
  const dirs = [
    serverConfig.dataDir,
    path.join(serverConfig.dataDir, 'uploads'),
    path.join(serverConfig.dataDir, 'outputs'),
    path.join(serverConfig.dataDir, 'db'),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
}
