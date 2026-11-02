import { createApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config/config.js";
import { createDatabaseProbe } from "./db/health.js";
import { disconnectPrismaClient, getPrismaClient } from "./db/prisma.js";
import { createPrismaTransactionRepository } from "./db/transactions.js";
import { createInferenceClient } from "./inferenceClient/client.js";
import { createInferenceHealthProbe } from "./inferenceClient/health.js";
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
const transactions = prisma === undefined ? undefined : createPrismaTransactionRepository(prisma);
// One inference client for health and the routes. Mock mode never calls the
// inference service; health reports "mock".
const inferenceClient = createInferenceClient(config.inference, { logger });
const inference = createInferenceHealthProbe(inferenceClient, logger);

// No listen() callback: Express 5 would also route startup errors into it.
const server = createApp({ logger, users: config.auth.users, database, inference, inferenceClient, transactions }).listen(PORT, HOST);

server.once("listening", () => {
  console.log(`Backend listening on http://${HOST}:${PORT}`);
  console.log(
    `Auth mode: ${config.auth.mode} (${config.auth.users.length} development users); ` +
      `inference mode: ${config.inference.mode}`,
  );
  // Report the initial database and inference status in the log; the results
  // aren't needed here.
  void database.check();
  void inference.check();
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
