import "../src/app/globals.css";
import type { Preview } from "@storybook/nextjs-vite";

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
    viewport: {
      options: {
        desktop: { name: "Desktop", styles: { width: "1280px", height: "800px" } },
        mobile: { name: "Mobile", styles: { width: "393px", height: "851px" } },
      },
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
