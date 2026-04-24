import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    permissions: ['storage', 'tabs', 'activeTab', 'scripting'],
    host_permissions: ['https://open.bigmodel.cn/*'],
  },
});
