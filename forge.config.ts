import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';

const config: ForgeConfig = {
  packagerConfig: {
    // Keep Vite output + runtime dependencies (native modules like better-sqlite3)
    // in the packaged app. The Vite plugin otherwise ignores everything except ".vite".
    ignore: (file: string) => {
      if (!file) return false;
      return !(file.startsWith('/.vite') || file.startsWith('/node_modules'));
    },
    executableName: 'TimeWellSpent',
    appBundleId: 'com.timewellspent.desktop',
    appCategoryType: 'public.app-category.productivity',
    icon: './src/assets/icon', // Will use .icns on macOS, .ico on Windows
    extendInfo: {
      NSCameraUsageDescription: 'TimeWellSpent captures accountability photos during frivolity sessions when Camera Mode is enabled.'
    }
  },
  rebuildConfig: {},
  makers: [
    new MakerDMG({
      format: 'ULFO'
    }, ['darwin']),
    new MakerZIP({}, ['darwin', 'win32', 'linux']),
    new MakerSquirrel({
      name: 'TimeWellSpent'
    }, ['win32'])
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts'
        },
        {
          entry: 'src/main/preload.ts',
          config: 'vite.preload.config.ts'
        }
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts'
        }
      ]
    })
  ]
};

export default config;
