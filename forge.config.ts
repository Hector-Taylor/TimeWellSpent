import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';

const config: ForgeConfig = {
  packagerConfig: {
    executableName: 'TimeWellSpent',
    appBundleId: 'com.timewellspent.desktop',
    appCategoryType: 'public.app-category.productivity'
  },
  rebuildConfig: {},
  makers: [
    new MakerDMG({
      format: 'ULFO'
    }),
    new MakerZIP({})
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
