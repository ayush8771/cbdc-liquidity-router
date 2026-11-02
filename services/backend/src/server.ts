import { createApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config/config.js";
import { createDatabaseProbe } from "./db/health.js";
import { disconnectPrismaClient, getPrismaClient } from "./db/prisma.js";
import { createShutdown } from "./lifecycle.js";
import { createLogger } from "./logger.js";

const PORT = 4000;
// Development auth must stay off public interfaces (arch §8.1).
const HOST = "127.0.0.1";

// Validate configuration before opening the port; refuse to start on any problem.
let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(`Failed to start backend. ${error.message}`);
  process.exit(1);
}

const logger = createLogger();
// One PrismaClient for the whole process, only when DATABASE_URL is set.
// The server starts even if the database is unreachable; health reports it.
const prisma = config.databaseUrl === undefined ? undefined : getPrismaClient(config.databaseUrl, logger);
const database = createDatabaseProbe(prisma, logger);

// No listen() callback: Express 5 would also route startup errors into it.
const server = createApp({ logger, users: config.auth.users, database }).listen(PORT, HOST);

server.once("listening", () => {
  console.log(`Backend listening on http://${HOST}:${PORT}`);
  console.log(
    `Auth mode: ${config.auth.mode} (${config.auth.users.length} development users); ` +
      `inference mode: ${config.inference.mode}`,
  );
  // Report the initial database status in the log; the result isn't needed here.
  void database.check();
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Failed to start backend: ${HOST}:${PORT} is already in use. ` +
        "Stop the other process using this port and try again.",
    );
  } else {
    console.error(`Failed to start backend: ${error.message}`);
  }
  process.exit(1);
});

const shutdown = createShutdown({
  server,
  disconnect: disconnectPrismaClient,
  logger,
  exit: (code) => process.exit(code),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}
