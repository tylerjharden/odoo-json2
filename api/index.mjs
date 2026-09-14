/**
 * Vercel Node adapter. Tokens, DCR clients, and instance credentials live in
 * Vercel Blob (BLOB_READ_WRITE_TOKEN) so they survive isolate recycling.
 * /tmp and in-memory stores do not.
 */
import { createHttpHandler, createRuntimeStore } from "../http.mjs";

export const config = {
  api: {
    bodyParser: false,
  },
};

const store = createRuntimeStore();
const handler = createHttpHandler({ store });

export default handler;
