import LoginForm from "./LoginForm";
import { entraSettings } from "@/lib/entra-sign-in";

// Reading searchParams makes this page render per request rather than once at
// build time. That matters for `microsoftEnabled`: it comes from settings in
// the server's .env, and a page baked at build time would keep showing (or
// hiding) the Microsoft button until the next build, whatever .env said.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { error } = await searchParams;
  return (
    <LoginForm
      microsoftEnabled={entraSettings(process.env) !== null}
      // Set by auth.ts's signIn callback when a Microsoft sign-in is turned away.
      microsoftRefused={error === "microsoft"}
    />
  );
}
