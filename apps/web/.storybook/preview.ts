import "../src/app/globals.css";
import type { Preview } from "@storybook/react-vite";

import { getUserStateDb } from "../src/lib/user-state-db";

const preview: Preview = {
  beforeEach: async () => {
    const db = getUserStateDb();
    if (db) {
      await db.transaction("rw", db.tables, async () => {
        await Promise.all(db.tables.map((table) => table.clear()));
      });
    }
    document.documentElement.dataset.theme = "light";
    window.localStorage.removeItem("upto-theme");
  },
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
