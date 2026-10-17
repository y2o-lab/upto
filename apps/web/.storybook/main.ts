import type { StorybookConfig } from "@storybook/nextjs-vite";

const config: StorybookConfig = {
  framework: { name: "@storybook/nextjs-vite", options: {} },
  addons: ["@storybook/addon-docs", "@storybook/addon-vitest"],
  stories: ["../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"],
};

export default config;
