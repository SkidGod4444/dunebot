// Dev: Vite with hot reload, then the app pointed at it.
import { createServer } from "vite";
import { launch } from "./launch.mjs";

const server = await createServer({ configFile: new URL("../vite.config.ts", import.meta.url).pathname });
await server.listen();
const code = await launch({ DUNEBOT_DEV_URL: server.resolvedUrls.local[0] });
await server.close();
process.exit(code);
