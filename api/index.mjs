/**
 * Vercel Node adapter for the long-running http.mjs server.
 * Body parsing stays off so OAuth + MCP can read the raw stream.
 */
import { createFileStore, createHttpHandler } from "../http.mjs";

export const config = {
  api: {
    bodyParser: false,
  },
};

const store = createFileStore(process.env.ODOO_JSON2_STORE || "/tmp/odoo-json2-store.json");
const handler = createHttpHandler({ store });

export default handler;
