import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  // Actions runner 只拿仓库内容、不安装依赖：直接依赖必须捆绑进产物
  // （tsdown 默认仅 external 本 package.json 的 dependencies，转依赖已捆绑；
  //  注意 noExternal: true 在 tsdown 0.22 有 picomatch 空模式 bug，勿用）
  noExternal: ['@actions/core', 'yaml', 'zod', '@octokit/action'],
  dts: false,
  sourcemap: true,
  outDir: 'dist',
});