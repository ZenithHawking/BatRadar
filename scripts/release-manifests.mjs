// Writes the two update manifests for a release, next to the NSIS installer:
//   latest.json — read by the Tauri updater (0.4.0+)
//   latest.yml  — read by the old Electron updater (0.2.x/0.3.x) so those users
//                 are offered the Tauri installer as their next update
// Usage: node scripts/release-manifests.mjs <version> [notes]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [version, notes = `BatRadar ${version}`] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    console.error('usage: node scripts/release-manifests.mjs <x.y.z> [notes]');
    process.exit(1);
}
const dir = 'src-tauri/target/release/bundle/nsis';
const exe = `BatRadar_${version}_x64-setup.exe`;
const exePath = join(dir, exe);
const url = `https://github.com/ZenithHawking/BatRadar/releases/download/v${version}/${exe}`;
const now = new Date().toISOString();

const latestJson = {
    version,
    notes,
    pub_date: now,
    platforms: {
        'windows-x86_64': { signature: readFileSync(`${exePath}.sig`, 'utf8').trim(), url },
    },
};
writeFileSync(join(dir, 'latest.json'), JSON.stringify(latestJson, null, 2) + '\n');

const sha512 = createHash('sha512').update(readFileSync(exePath)).digest('base64');
const size = statSync(exePath).size;
const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${exe}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${exe}`,
    `sha512: ${sha512}`,
    `releaseDate: '${now}'`,
    '',
].join('\n');
writeFileSync(join(dir, 'latest.yml'), yml);
console.log(`wrote latest.json + latest.yml for ${exe} (${size} bytes)`);
