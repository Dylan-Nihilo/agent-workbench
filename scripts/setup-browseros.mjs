#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Pinned official release. Update the version and both upstream SHA256 values together.
const version = '0.51.2.3';
const checksums = {
  arm64: '71de41267c6a9bd991c2d560125304082aa32a45a86f572fd819ce6e521e8a56',
  x64: '8eb7626cdc291ace6e70b19dc6dc8d1999a4a0492a0d13ee580a6a06ed3a14b6',
};
const exec = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argumentsFor(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv.length === 0) return { directory: resolve(repository, '../browseros-runtime') };
  if (argv.length === 2 && argv[0] === '--dir' && argv[1] && !argv[1].startsWith('--'))
    return { directory: resolve(argv[1]) };
  throw new Error('Usage: node scripts/setup-browseros.mjs [--dir /path/to/runtime]');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyApp(app) {
  const plist = join(app, 'Contents/Info.plist');
  const { stdout: identity } = await exec('/usr/bin/plutil', [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    '-o',
    '-',
    plist,
  ]);
  const { stdout: installedVersion } = await exec('/usr/bin/plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    '-o',
    '-',
    plist,
  ]);
  const { stdout: executable } = await exec('/usr/bin/plutil', [
    '-extract',
    'CFBundleExecutable',
    'raw',
    '-o',
    '-',
    plist,
  ]);
  if (identity.trim() !== 'com.browseros.BrowserClaw' || installedVersion.trim() !== version) {
    throw new Error(
      `The destination contains a different app or version. It was not changed. Choose another --dir.`,
    );
  }
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const binary = join(app, 'Contents/MacOS', executable.trim());
  await access(binary, constants.X_OK);
  return binary;
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/bin/curl',
      [
        '--fail',
        '--location',
        '--retry',
        '2',
        '--connect-timeout',
        '30',
        '--progress-bar',
        url,
        '--output',
        destination,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Download failed (${signal || code}).`)),
    );
  });
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log(
      'Usage: node scripts/setup-browseros.mjs [--dir /path/to/runtime]\nDownloads and verifies the official BrowserOS neo macOS app.\nDefault destination: ../browseros-runtime next to this repository.\nIt does not launch the browser, import profiles, or install to /Applications.',
    );
    return;
  }
  if (process.platform !== 'darwin' || !(process.arch in checksums))
    throw new Error('This setup script supports macOS Apple Silicon and Intel only.');
  const directory = options.directory;
  await mkdir(directory, { recursive: true });
  const app = join(directory, 'BrowserOS neo.app');
  if (await exists(app)) {
    const binary = await verifyApp(app);
    console.log(
      `Existing BrowserOS neo ${version} signature verified.\n${binary}\nNothing was launched or changed.`,
    );
    return;
  }
  const filename = `BrowserOS_neo_v${version}_${process.arch}.dmg`;
  const source = `https://github.com/browseros-ai/BrowserOS/releases/download/browserclaw/v${version}/${filename}`;
  const archive = join(directory, filename);
  const expected = checksums[process.arch];
  if (!(await exists(archive))) {
    const partial = `${archive}.partial-${randomUUID()}`;
    try {
      console.log(`Downloading official BrowserOS neo ${version} (${process.arch})…`);
      await download(source, partial);
      if ((await digest(partial)) !== expected)
        throw new Error('SHA256 mismatch. The download will not be installed.');
      await rename(partial, archive);
    } finally {
      await rm(partial, { force: true });
    }
  }
  if ((await digest(archive)) !== expected)
    throw new Error(
      `Cached archive has the wrong SHA256: ${archive}. It was not changed or installed.`,
    );
  console.log(`SHA256 verified: ${expected}`);
  const mountpoint = await mkdtemp(join(directory, '.mount-'));
  const staging = await mkdtemp(join(directory, '.install-'));
  let mounted = false;
  try {
    await exec('/usr/bin/hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mountpoint,
      archive,
    ]);
    mounted = true;
    const stagedApp = join(staging, 'BrowserOS neo.app');
    // Resource forks/Finder metadata are not part of the signed app bundle.
    await exec('/usr/bin/ditto', [
      '--noextattr',
      '--norsrc',
      join(mountpoint, 'BrowserOS neo.app'),
      stagedApp,
    ]);
    await verifyApp(stagedApp);
    if (await exists(app))
      throw new Error('Destination appeared during installation; it was not overwritten.');
    await rename(stagedApp, app);
    await writeFile(
      join(directory, 'runtime-info.json'),
      JSON.stringify(
        {
          product: 'BrowserOS neo',
          version,
          arch: process.arch,
          source,
          sha256: expected,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      `Installed and verified BrowserOS neo at:\n${app}\nThe browser was not launched. No global application or profile configuration was changed.`,
    );
  } finally {
    if (mounted) {
      try {
        await exec('/usr/bin/hdiutil', ['detach', mountpoint]);
        mounted = false;
      } catch {
        console.error(
          `Could not detach ${mountpoint}; detach this image manually. Its mount directory was preserved.`,
        );
      }
    }
    if (!mounted) await rm(mountpoint, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
