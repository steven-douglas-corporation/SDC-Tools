import { PrismaClient } from "@prisma/client";

// ── One client, therefore one connection pool, per PROCESS (2026-08-24) ──────
//
// The `NODE_ENV !== "production"` guard this used to carry is the pattern from
// the Prisma docs, and its stated purpose is to stop dev hot-reload from leaking
// a new client on every recompile. In THIS app it also had an unintended
// production effect, for the reason already written up in lib/permissions.ts and
// lib/realtime-hub.ts: Next.js bundles Server Actions separately from Route
// Handlers and Server Components, so a plain module-level `const` becomes
// several distinct instances inside one Node process.
//
// For a counter that meant "writes are invisible to readers". For a PrismaClient
// it means several independent connection pools against the same MySQL, each
// sized from Prisma's default (num_cpus * 2 + 1) and none aware of the others.
// Under load they compete for the server's max_connections, and a request that
// loses gets a pool timeout — which surfaced as the intermittent blank screen of
// 2026-08-24, because the throw landed inside (app)/layout.tsx's `await auth()`
// where no error boundary could catch it (see app/global-error.tsx and
// lib/token-revocation.ts for the other two halves of that fix).
//
// Pinning to globalThis in every environment gives one pool per process, which
// is what the connection maths assumes. It keeps the dev hot-reload benefit the
// original guard was there for — that behaviour is unchanged, it is now simply
// unconditional.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

globalForPrisma.prisma = prisma;
