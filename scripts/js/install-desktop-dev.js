const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP_NAME = 'Caro Anki Dev';
const root = path.resolve(__dirname, '../..');
const runtimeSource = path.join(root, 'tmp/anki-runtime/anki-helper');
const requested = process.argv[2];
const target = path.resolve(requested ?? path.join(root, `tmp/${APP_NAME}.app`));
if (requested && fs.existsSync(target)) throw new Error(`Already exists: ${target}. Remove the old development app first.`);
fs.rmSync(target, { recursive: true, force: true });
const source = path.join(root, 'node_modules/electron/dist/Electron.app');
fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
const contents = path.join(target, 'Contents');
const plist = path.join(contents, 'Info.plist');
for (const [key, value] of Object.entries({
  CFBundleIdentifier: process.env.CF_BUNDLE_ID || 'com.caro.anki.dev',
  CFBundleName: APP_NAME, CFBundleDisplayName: APP_NAME,
})) execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
const resources = path.join(contents, 'Resources/app');
fs.mkdirSync(resources, { recursive: true });
fs.writeFileSync(path.join(resources, 'package.json'),
  JSON.stringify({ name: 'caro-anki-dev', productName: APP_NAME, main: 'main.js' }));
fs.writeFileSync(path.join(resources, 'main.js'),
  `process.env.CARO_APP_VARIANT = 'dev';\nprocess.env.CARO_NODE_PATH = ${JSON.stringify(process.execPath)};\n`
  + `require(${JSON.stringify(root + '/desktop/main.js')});\n`);
// The bundled Anki runtime is what removes the Anki Desktop and system Python requirement, so the
// installed app must carry it. Signing happens after this copy.
if (fs.existsSync(runtimeSource)) {
  fs.cpSync(runtimeSource, path.join(contents, 'Resources/anki-runtime/anki-helper'), { recursive: true });
} else {
  console.warn(`Warning: ${runtimeSource} is missing. Run "npm run anki:runtime" first;`
    + ' without it the app falls back to an external Python and the anki package.');
}
execFileSync('codesign', ['--force', '--deep', '--sign', '-', target], { stdio: 'inherit' });
console.log(`Created ${target}`);
