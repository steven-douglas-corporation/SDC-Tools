# SDC Centralized Calendar

Company-wide calendar for Steven Douglas Corp. — events, holidays, birthdays, pay days, and live sync with SDC Scheduler project tasks.

Runs inside the SDC Tools shell launcher. Authentication is handled by the shell (Azure SSO); the calendar itself operates in `SKIP_AUTH` mode and receives a pre-authenticated admin context automatically.

---

## Features

- **Month / Week / Day views** with drag-and-drop event rescheduling
- **8 event categories** — SDC Holidays, Pay Days, Birthdays, Team Meetings, Company Events, Deadlines, Personal, Vacation/PTO
- **SDC Scheduler sync** — pull project tasks onto the calendar as read-only `SCH`-badged events, color-coded by phase
- **Role-based access** — Admin, HR, Manager, Employee each see different categories
- **Admin Panel** — manage user roles and category permissions
- **Birthday Spotlight** — this-week birthday banner with expand/collapse
- **Payday Countdown** — days-until-next-payday pill in the header
- **Monthly Summary Bar** — event-count pills across all active categories
- **My Events filter** — toggle to show only your own events
- **Reminder Bell** — set reminders on any event
- **Pin Events** — pin important events to the top
- **Jump-to-Date** picker in the topbar
- **Keyboard Shortcuts** overlay (`?` button)
- **Week Numbers** toggle
- **Right-click Context Menu** on calendar cells
- **Search with highlight** — matching chips glow, non-matching dim
- **Dark mode** + density presets (Compact / Default / Comfy)
- **Import / Export** calendar data (JSON)
- **Employee Directory** modal
- **Undo / Redo** for event edits
- **Swipe gestures** on mobile + bottom navigation bar

---

## Project Structure

```
SDC Centralized Calendar/
├── SDC Centralized Calendar.html   # Entry point — loads React + app
├── app.jsx                         # Main React application (Babel transpiled in-browser)
├── data.js                         # Static seed data (holidays, paydays, birthdays…)
├── styles.css                      # All styles
├── assets/
│   └── sdc-logo.png
└── server/                         # Node.js / Express backend
    ├── server.js                   # Express app — serves static files + API
    ├── auth.js                     # Azure AD OAuth2 + JWT handling
    ├── db.js                       # NeDB (embedded) database helpers
    ├── middleware/
    │   └── requireAuth.js          # JWT verification middleware
    ├── routes/
    │   └── admin.js                # /api/admin/* endpoints
    ├── package.json
    ├── .env.example                # Template — copy to .env and fill in secrets
    └── start.bat                   # Windows one-click server start
```

---

## Quick Start (Local Dev)

> **No backend required** — the calendar works fully in LOCAL_MODE.

1. Clone the repo:
   ```bash
   git clone https://github.com/steven-douglas-corporation/SDC-Tools.git
   cd SDC-Tools/apps/calendar
   ```

2. Open `SDC Centralized Calendar.html` in a browser **or** serve it:
   ```bash
   # Python (any machine)
   python -m http.server 3000

   # Or start the full Node server (serves both frontend + API):
   cd server
   npm install
   node server.js
   ```

3. Navigate to `http://localhost:3000`

The app boots in **LOCAL Mode** — no login required, full admin access.

---

## Backend Setup (Microsoft SSO + user management)

1. Copy the env template:
   ```bash
   cp server/.env.example server/.env
   ```

2. Fill in your Azure AD credentials in `server/.env`:
   ```env
   TENANT_ID=<your-tenant-id>
   CLIENT_ID=<your-client-id>
   CLIENT_SECRET=<your-client-secret>
   JWT_SECRET=<random-long-string>
   SESSION_SECRET=<another-random-string>
   ```

3. In `app.jsx` line 13, set:
   ```js
   const LOCAL_MODE = false;
   ```

4. Register the redirect URI in your Azure App Registration:
   ```
   http://localhost:3001/auth/callback
   ```

5. Start the server:
   ```bash
   cd server && node server.js
   ```

   | Port | Purpose |
   |------|---------|
   | 3000 | Frontend (static files) |
   | 3001 | API + Azure AD OAuth callback |

---

## Auto-start on Windows Login

A `VBS` startup script is installed at:
```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SDC-Calendar-Server.vbs
```
This silently starts `node server.js` when the Windows session begins.

---

## Versioning

This project uses **Semantic Versioning** (`MAJOR.MINOR.PATCH`):

| Bump | When |
|------|------|
| `PATCH` | Bug fixes, style tweaks |
| `MINOR` | New features, UI improvements |
| `MAJOR` | Breaking changes, full rewrites |

See [CHANGELOG.md](CHANGELOG.md) for the full history.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18.3 + Babel Standalone (no build step) |
| Styling | Vanilla CSS with CSS custom properties |
| Backend | Node.js + Express |
| Auth | Azure AD OAuth2 + JWT |
| Database | NeDB (embedded, file-based) |
| Fonts | Inter + JetBrains Mono (Google Fonts) |

---

## License

Internal use — SDC proprietary.
