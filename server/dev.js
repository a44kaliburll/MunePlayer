// Runs the Mune Player back end in plain Node (no Electron window) for browser previews:
//   node server/dev.js --port=18751
// Uses a separate state folder so it never touches the desktop app's data.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMune } from './app.js';
import { stateDir } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.split('=')[1]) : 18751;

const backend = await startMune({
  stateDir: stateDir(true),
  uiDir: path.join(here, '..', 'ui'),
  port,
  shell: 'browser',
  // Off by default so a preview never fights the desktop app for the Zune.
  devices: process.env.MUNE_DEVICES === '1' || process.argv.includes('--devices'),
  // --phone serves the phone sync API too; --phone-host=127.0.0.1 keeps it off the LAN (emulator tests use 10.0.2.2).
  phoneSync: process.argv.includes('--phone'),
  phoneHost: process.argv.find((a) => a.startsWith('--phone-host='))?.split('=')[1] || '0.0.0.0',
});
console.log(`Mune Player dev server: ${backend.url}`);

const stop = async () => {
  await backend.shutdown();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
