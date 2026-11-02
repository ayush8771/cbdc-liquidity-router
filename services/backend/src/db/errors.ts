// Safe descriptions of Prisma errors for logs. A Prisma error's message, and
// therefore the first lines of its stack, can contain the database host, user
// name or parts of the connection string, so only fixed fields are kept: the
// class name, a P#### code, and the stack's "at …" frame lines.

const PRISMA_ERROR_NAME = /^PrismaClient[A-Za-z]*Error$/;
const PRISMA_ERROR_CODE = /^P\d{4}$/;

/** True for Prisma's error classes, recognised by their fixed class names. */
export function isPrismaError(error: unknown): error is Error {
  return error instanceof Error && PRISMA_ERROR_NAME.test(error.name);
}

/** A Prisma error code (errorCode or code, "P" + 4 digits), if present. */
export function prismaErrorCode(error: unknown): string | undefined {
  const candidate = error as { errorCode?: unknown; code?: unknown } | null;
  for (const code of [candidate?.errorCode, candidate?.code]) {
    if (typeof code === "string" && PRISMA_ERROR_CODE.test(code)) return code;
  }
  return undefined;
}

export function describePrismaError(error: Error): { name: string; code?: string; frames: string[] } {
  // V8 stacks start with "<name>: <message>". Frames are read only after that
  // exact header, so a multi-line message can't pass a line off as a frame.
  // If the header doesn't match, no frames are logged (fail closed).
  const header = `${error.name}: ${error.message}`;
  const stack = error.stack ?? "";
  const frames = stack.startsWith(header)
    ? stack
        .slice(header.length)
        .split("\n")
        .filter((line) => /^\s+at /.test(line))
        .map((line) => line.trim())
    : [];
  const code = prismaErrorCode(error);
  return { name: error.name, ...(code === undefined ? {} : { code }), frames };
}
