import path from 'node:path';

const APP_VERSION = '1.13.7';
const INSTALLER_VERSION = '1.13.7';

const cacheDir = path.resolve(import.meta.dirname, '../../.obsidian-cache');
const pluginDir = path.resolve(import.meta.dirname, '../plugin/dist');
const vault = path.resolve(import.meta.dirname, 'vault');

const obsidianOptions = { installerVersion: INSTALLER_VERSION, plugins: [pluginDir], vault };

const desktop: WebdriverIO.Capabilities = {
  browserName: 'obsidian',
  browserVersion: APP_VERSION,
  'wdio:obsidianOptions': obsidianOptions,
  'wdio:exclude': [path.resolve(import.meta.dirname, 'specs/mobile.e2e.ts')],
};

const mobile: WebdriverIO.Capabilities = {
  browserName: 'obsidian',
  browserVersion: APP_VERSION,
  'wdio:obsidianOptions': { ...obsidianOptions, emulateMobile: true },
  'wdio:exclude': [path.resolve(import.meta.dirname, 'specs/desktop.e2e.ts')],
  'goog:chromeOptions': { mobileEmulation: { deviceMetrics: { width: 390, height: 844 } } },
};

export const config: WebdriverIO.Config = {
  runner: 'local',
  framework: 'mocha',
  specs: [path.resolve(import.meta.dirname, 'specs/*.e2e.ts')],
  maxInstances: Number(process.env.WDIO_MAX_INSTANCES || 1),

  capabilities: [desktop, mobile],
  services: ['obsidian'],
  reporters: ['obsidian'],
  cacheDir,

  mochaOpts: { ui: 'bdd', timeout: 90_000 },
  waitforInterval: 250,
  waitforTimeout: 10_000,
  logLevel: 'warn',
};
