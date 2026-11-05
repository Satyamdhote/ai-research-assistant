import "dotenv/config";
import { getOpenRouterConfig, getPort } from "./config.js";
import { createAppServer } from "./http/server.js";

// Entry point. It only wires things together: load .env, check the configuration, listen.
getOpenRouterConfig(); // fail at startup (not on the first question) if the config is wrong

const port = getPort();
createAppServer().listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
