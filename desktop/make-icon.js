// Writes build/icon.png and build/icon.ico (used by shortcuts and the installer).
// Run with:  npx electron desktop/make-icon.js
import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appIconBitmap, pngToIco } from './icons.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

app.whenReady().then(() => {
  const img = nativeImage.createFromBitmap(appIconBitmap(256), { width: 256, height: 256 });
  const png = img.toPNG();
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), png);
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), pngToIco(png, 256));
  console.log('wrote build/icon.png and build/icon.ico');
  app.quit();
});
