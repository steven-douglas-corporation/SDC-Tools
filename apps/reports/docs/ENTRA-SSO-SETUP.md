# Microsoft Entra (Azure AD) SSO Setup

The app is already wired for "Sign in with Microsoft" using @sdcautomation.com
accounts. It activates automatically once the three environment variables below
exist — until then, only the email/password form is shown.

## 1. Create the App Registration (needs an Entra admin, ~5 minutes)

1. Go to https://portal.azure.com → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Name: `SDC ETC Planner`.
3. Supported account types: **Accounts in this organizational directory only** (single tenant — this is what restricts sign-in to the SDC tenant).
4. Redirect URI: platform **Web**, value:
   - `http://localhost:4006/api/auth/callback/microsoft-entra-id`
   - After adding, open **Authentication** and add the server name too:
     `http://server-app1:4006/api/auth/callback/microsoft-entra-id`
   - (Add an `https://…` one later if the app gets a proper hostname/TLS.)
5. **Certificates & secrets** → **New client secret** → copy the secret **Value**
   immediately (it is shown only once). Pick a 12–24 month expiry and put a
   calendar reminder to rotate it.
6. From the **Overview** page copy:
   - **Application (client) ID**
   - **Directory (tenant) ID**

No API permissions beyond the defaults (`openid`, `profile`, `email` under
Microsoft Graph delegated) are needed, and no admin consent prompt should
appear for them.

## 2. Configure the app

Add to `.env` (same file that holds `DATABASE_URL`):

```
AUTH_MICROSOFT_ENTRA_ID_ID=<Application (client) ID>
AUTH_MICROSOFT_ENTRA_ID_SECRET=<client secret Value>
AUTH_MICROSOFT_ENTRA_ID_TENANT_ID=<Directory (tenant) ID>
```

Restart the app. The login page now shows **Sign in with Microsoft** above the
password form.

## 3. How it behaves

- Only accounts in the SDC tenant can authenticate (single-tenant issuer), and
  the app additionally rejects any email that isn't `@sdcautomation.com`.
- First sign-in auto-creates the app account (role MANAGER) matched by email.
  Existing accounts (e.g. an ADMIN) keep their role — matching is by email, so
  the Entra sign-in just attaches to the existing row.
- SSO-provisioned accounts get an unusable random password hash — they can
  never sign in through the password form.
- Roles are still managed in the app's User table (`role` column:
  MANAGER/ADMIN).

## 4. After it works

- Reset or remove any leftover test/password accounts.
- Optionally remove the password form entirely (delete the Credentials
  provider in `src/lib/auth.ts`) once everyone has signed in via Microsoft at
  least once.
- The same App Registration can later be reused for sending submit-notification
  email via Microsoft Graph (add the `Mail.Send` application permission when
  that feature is wanted).
