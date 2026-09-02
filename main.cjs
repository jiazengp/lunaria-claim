// Actions runner 以 CJS 方式加载 action main，这里动态 import 纯 ESM 产物以兼容两种加载行为
import('./dist/index.mjs').catch((error) => {
  console.error(error);
  process.exit(1);
});
