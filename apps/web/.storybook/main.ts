import react from "@vitejs/plugin-react";

const config = {
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  addons: ["@storybook/addon-docs"],
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
  viteFinal: async (viteConfig: { plugins?: unknown[] }) => ({
    ...viteConfig,
    plugins: [...(viteConfig.plugins ?? []), react()],
  }),
};

export default config;
