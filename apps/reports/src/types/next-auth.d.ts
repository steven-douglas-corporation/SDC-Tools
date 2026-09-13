import type { AppRole } from "@/lib/permissions";

// next-auth ships `role` nowhere in its own types — every call site used to
// carry its own ad hoc `(x as { role?: string })` cast instead of a shared
// type. This is the one place that's declared now.
//
// Both "next-auth" and "next-auth/jwt" only RE-EXPORT these interfaces
// (`export type {...} from` / `export * from`) — the real declarations live
// in "@auth/core/types" and "@auth/core/jwt". Augmenting the re-exporting
// module doesn't merge with the genuine interface, so this targets the
// origin packages directly.
declare module "@auth/core/types" {
  interface Session {
    user: {
      id?: string;
      role: AppRole;
    } & DefaultSession["user"];
  }

  interface User {
    role: AppRole;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    role?: AppRole;
  }
}
