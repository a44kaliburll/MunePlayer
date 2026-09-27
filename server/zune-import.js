import fs from 'node:fs';
import { execFile } from 'node:child_process';

function regQuery(key) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({});
    execFile('reg', ['query', key], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve({});
      const values = {};
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^\s{2,}(\S+)\s+(REG_\w+)\s+(.*)$/.exec(line);
        if (!m) continue;
        values[m[1]] = m[2] === 'REG_MULTI_SZ' ? m[3].split('\\0').filter(Boolean) : m[3];
      }
      resolve(values);
    });
  });
}

/**
 * First-run import from an installed copy of the real Zune software:
 * its rip folder plus the extra folders it was told to monitor.
 */
export async function importZuneFolders() {
  const v = await regQuery('HKCU\\Software\\Microsoft\\Zune\\Groveler');
  const music = [v.RipDirectory, ...(v.MonitoredAudioFolders || [])].filter(Boolean);
  const video = [v.VideoMediaFolder, ...(v.MonitoredVideoFolders || [])].filter(Boolean);
  const pictures = [v.PhotoMediaFolder, ...(v.MonitoredPhotoFolders || [])].filter(Boolean);
  const keep = (list) => [...new Set(list)].filter((p) => fs.existsSync(p));
  return { music: keep(music), video: keep(video), pictures: keep(pictures), found: music.length > 0 };
}
