import type { DevUser, Role } from "../config/devTokens.js";

// Development-user seeding (arch §8.2: "Users are seeded into PostgreSQL from
// dev-tokens.json (the hashes are not copied)"). Only id, email and role are
// written. Users missing from the token file are left in place, because
// records may reference them (contract §6.1, append-only).

export interface UserRecord {
  id: string;
  email: string;
  role: Role;
}

/** The part of PrismaClient this module needs, so tests can supply a fake. */
export interface UserUpsertClient {
  user: {
    upsert(args: {
      where: { id: string };
      create: UserRecord;
      update: { email: string; role: Role };
    }): Promise<unknown>;
  };
}

/** Maps token-file users to database records, dropping the token hash. */
export function toUserRecords(users: readonly DevUser[]): UserRecord[] {
  return users.map(({ userId, email, role }) => ({ id: userId, email, role }));
}

/** Upserts each user by id, one at a time. Returns the number of users seeded. */
export async function seedDevUsers(client: UserUpsertClient, users: readonly DevUser[]): Promise<number> {
  const records = toUserRecords(users);
  for (const { id, email, role } of records) {
    await client.user.upsert({ where: { id }, create: { id, email, role }, update: { email, role } });
  }
  return records.length;
}
