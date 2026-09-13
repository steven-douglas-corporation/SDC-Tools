import LoginForm from "./LoginForm";

// Sign-in is Microsoft Entra SSO only — no server-side flags to pass through.
export default function LoginPage() {
  return <LoginForm />;
}
