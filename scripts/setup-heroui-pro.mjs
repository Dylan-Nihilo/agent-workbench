import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreFromCache } from 'hpsetup/src/cache.js';
import { cleanPostinstall, downloadFromProxy } from 'hpsetup/src/download.js';
import { PRODUCTS } from 'hpsetup/src/constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies[
  '@heroui-pro/react'
];
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version))
  throw new Error('Pin HeroUI Pro to an exact version.');
const target = path.join(root, 'node_modules/@heroui-pro/react');
const files = [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/css/index.css',
  ...[
    'sidebar',
    'segment',
    'prompt-input',
    'chat-message',
    'chat-conversation',
    'cell-color-picker',
    'cell-slider',
    'cell-select',
  ].map((name) => 'dist/components/' + name + '/index.js'),
];
const complete = () =>
  files.every((name) => existsSync(path.join(target, name))) &&
  JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8')).version === version;
try {
  if (!complete() && (!restoreFromCache('react', version, target) || !complete())) {
    const key = process.env.HEROUI_KEY;
    if (!key || !/^hp_[a-f0-9]+$/.test(key))
      throw new Error(
        'No complete licensed HeroUI Pro cache. Configure HEROUI_KEY privately for the existing hpsetup relay, then run npm run heroui:setup.',
      );
    await downloadFromProxy(PRODUCTS.react, version, target, key, false, Boolean(process.env.CI));
  }
  if (!complete())
    throw new Error('HeroUI Pro artifacts are incomplete or have the wrong version.');
  if (!existsSync(path.join(target, 'LICENSE')))
    copyFileSync(
      path.join(root, 'resources/licenses/heroui-pro-LICENSE.txt'),
      path.join(target, 'LICENSE'),
    );
  cleanPostinstall(target);
  console.log('HeroUI Pro ' + version + ' ready from the configured relay/cache.');
} catch (error) {
  console.error(
    String(error.message)
      .replace(/hp_[a-f0-9]+/g, '[redacted]')
      .replace(/([?&]key=)[^\s&]+/g, '$1[redacted]'),
  );
  process.exitCode = 1;
}
