# Microsoft sign-in (Entra ID) setup

"Sign in with Microsoft" on the login page, for people who open this app directly in a
browser. Opening it from the SDC Tools launcher already signs people in through the Scheduler
hand-off and does not use this.

The code is in place and **switched off**. It turns on when the three settings in step 2 exist.
Until then the login page and every sign-in route behave exactly as before.

## Before you start: the app needs an HTTPS address

Entra only accepts return addresses that start with `https`. The single exception is
`http://localhost`. This app is served today at `http://server-app1:4006`, which Entra will
refuse to register, so **Microsoft sign-in cannot be turned on in production until the app is
reachable over HTTPS** (a certificate and a reverse proxy in front of it).

It can be set up and tried on a developer PC now, using the `localhost` address.

## 1. Create the app registration (needs an Entra administrator)

1. https://portal.azure.com → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Name: `SDC Reports`.
3. Supported account types: **Accounts in this organizational directory only**. This is what
   limits sign-in to SDC accounts.
4. Redirect URI: platform **Web**. Add the address for wherever the app runs:
   - Developer PC: `http://localhost:4006/api/auth/callback/microsoft-entra-id`
   - Production, once HTTPS exists: `https://<the app's HTTPS name>/api/auth/callback/microsoft-entra-id`
5. **Certificates & secrets** → **New client secret**. Copy the secret **Value** at once; it is
   shown only once. Note the expiry date and set a reminder to replace it before then: when it
   expires, Microsoft sign-in stops working with no other warning.
6. From **Overview**, copy the **Application (client) ID** and the **Directory (tenant) ID**.

No API permissions beyond the defaults are needed. The app asks only for `openid`, `profile` and
`email`, and does not read anything from Microsoft Graph.

## 2. Configure the app

Add to `.env`:

```
AUTH_MICROSOFT_ENTRA_ID_ID=<Application (client) ID>
AUTH_MICROSOFT_ENTRA_ID_SECRET=<client secret Value>
AUTH_MICROSOFT_ENTRA_ID_TENANT_ID=<Directory (tenant) ID>
```

`AUTH_URL` must be the address people actually use, because the return address sent to
Microsoft is built from it and must match step 1 exactly.

Restart the app. The login page now shows **Sign in with Microsoft** above the password form.

If only some of the three are set, or the tenant value is not a directory ID, sign-in stays off
and the server log says why (`[auth] Microsoft sign-in is off: ...`).

## 3. How it behaves

- Only accounts in the SDC directory are accepted, and only `@sdcautomation.com` addresses.
- The Microsoft account is matched to the existing Reports account **by email**. The person
  keeps their role and everything attached to their account.
- Someone with no Reports account gets one on first sign-in, at the lowest role (`ALL`), the
  same as arriving through the Scheduler hand-off. An administrator raises it from
  `/admin/users`.
- An account created this way has a random, unusable password, so it can only sign in through
  Microsoft or the launcher.
- A deactivated account is refused, the same as on the password form.
- Roles and permissions stay in this app. Nothing about access is read from Microsoft.
- Every refusal shows the same message, so the page cannot be used to find out which addresses
  have accounts.
- Sign-ins are recorded in the audit log as "signed in (via Microsoft)".

The password form keeps working alongside it.

## 4. Later

Once everyone has signed in with Microsoft at least once, the password form and the
password-hash copying between this app and the Scheduler can be retired. That is a separate
change and needs agreeing with the Scheduler's owner.

## Where the code is

| File                          | What it does                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/entra-sign-in.ts`    | Reads the settings; decides whether a Microsoft account is acceptable. No dependencies, unit-tested.                     |
| `src/lib/auth.ts`             | Registers the provider when configured; matches or creates the account; puts this app's user id and role in the session. |
| `src/app/login/`              | Shows the button when configured, and the message when a sign-in is refused.                                             |
| `tests/entra-sign-in.test.ts` | The settings and acceptance rules.                                                                                       |
