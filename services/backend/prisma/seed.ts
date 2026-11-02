// Seeds development users from the token file (arch §8.2). Run explicitly with
// `npm run prisma:seed`; Prisma also runs it after `prisma migrate reset`.
// It validates the token file with the same code as server start-up, and
// writes only id, email and role. It never prints a token or token hash.

import { PrismaClient } from "@prisma/client";
import { resolveDevTokensFile } from "../src/config/config.js";
import { readDevTokensFile } from "../src/config/devTokens.js";
import { seedDevUsers } from "../src/db/seedDevUsers.js";

const tokenFile = resolveDevTokensFile(process.env);
const { users, problems } = readDevTokensFile(tokenFile);
if (problems.length > 0) {
  console.error(`Seed aborted. Invalid development token file:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const count = await seedDevUsers(prisma, users);
  console.log(`Seeded ${count} development users (id, email and role only).`);
} finally {
  await prisma.$disconnect();
}
