import { useState, useEffect, useCallback, useRef } from 'react'
import sdcLogo from './assets/sdc-logo.png'
import AppGrid from './components/AppGrid'
import StatusBar from './components/StatusBar'
import LogPanel from './components/LogPanel'
import UpdateBanner from './components/UpdateBanner'
import NotificationCenter from './components/NotificationCenter'
import RecentActivity from './components/RecentActivity'
import WindowChrome from './components/WindowChrome'
import LoginScreen from './screens/LoginScreen'

// ── Version display: 2.0, not 2.0.0 (2026-08-24, by request) ───────────────
//
// The version is DISPLAYED as major.minor while package.json keeps a real
// three-part semver, and that split is not stylistic — it is required.
// electron-updater compares versions with semver, and semver rejects a
// two-part string outright: semver.valid('2.0') is null and
// semver.gt('2.0', '1.8.1') THROWS 'Invalid Version: 2.0' (checked, not
// assumed). Putting "2.0" in package.json would therefore break the OTA
// update check for every installed desktop, and electron-builder's artifact
// naming with it. So the scheme lives here, where it is only ever read by a
// human.
//
// The patch number is appended ONLY when it is non-zero: 2.0.0 shows as "2.0",
// but a hotfix 2.0.1 shows as "2.0.1" rather than also claiming to be "2.0".
// Hiding it would make "which version are you on?" unanswerable from the UI,
// which is the one job this chip has.
function formatVersion(raw) {
  if (!raw) return ''
  // 'dev' (the no-Electron fallback below) and any pre-release suffix pass
  // through untouched — better an odd-looking string than a wrong one.
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(raw).trim())
  if (!m) return raw
  const [, major, minor, patch] = m
  return patch === '0' ? `${major}.${minor}` : `${major}.${minor}.${patch}`
}

const SKELETON_APPS = ['assemblies', 'readiness', 'scheduler', 'statelogic', 'calendar', 'reports'].map(id => ({
  id,
  name: {
    assemblies: 'Assemblies Library',
    readiness:  'Build Readiness',
    scheduler:  'Project Planner',
    statelogic: 'State Logic Builder',
    calendar:   'Calendar',
    reports:    'SDC Projects Reports',
  }[id],
  description: {
    assemblies: 'SolidWorks CAD assembly search and check-out — 18,442 assemblies in the vault.',
    readiness:  'Live ETO project build status across the floor — parts, prints, sign-offs.',
    scheduler:  'Gantt views, resource load, and two-way Smartsheet sync for active projects.',
    statelogic: 'Author PLC state machines and export Allen-Bradley L5X for ControlLogix.',
    calendar:   'Company-wide calendar — events, birthdays, paydays, Scheduler sync.',
    reports:    '',
  }[id],
  status: 'starting',
  color: {
    assemblies: '#1574C4',
    readiness:  '#16a34a',
    scheduler:  '#FFDE51',
    statelogic: '#ea580c',
    calendar:   '#74C415',
    reports:    '#0f5a95',
  }[id],
  url: '',
}))

const api = window.shellAPI ?? {
  getStatus: () => Promise.resolve({}),
  getLogs: () => Promise.resolve([]),
  openApp: () => Promise.resolve({}),
  retryApp: () => Promise.resolve({}),
  stopAll: () => Promise.resolve(),
  restartAll: () => Promise.resolve(),
  stopApp: () => Promise.resolve(),
  restartApp: () => Promise.resolve(),
  onStatusChange: () => () => {},
  onAppLog: () => () => {},
  getAppVersion: () => Promise.resolve('dev'),
  updateDownload: () => Promise.resolve(),
  updateInstall: () => Promise.resolve(),
  onUpdateStatus: () => () => {},
  getLaunchOnStartup: () => Promise.resolve(false),
  setLaunchOnStartup: () => Promise.resolve(false),
  syncStatus: () => Promise.resolve(),
  authGetStatus: () => Promise.resolve({ isAuthenticated: false, configured: false, user: null }),
  authLogin: () => Promise.resolve({ success: false, error: 'No API' }),
  authLogout: () => Promise.resolve({ success: true }),
  getSdcApps: () => Promise.resolve(null),
  checkForUpdates: () => Promise.resolve(),
  triggerUpdate: () => Promise.resolve({ ok: false }),
  getServerHost: () => Promise.resolve(''),
}

function timeAgo(ts) {
  if (!ts) return null
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (h < 24) return `${h}h ago`
  if (d === 1) return 'Yesterday'
  return `${d}d ago`
}

function formatHeaderDate(date) {
  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const h = date.getHours(), m = date.getMinutes()
  const period = h >= 12 ? 'PM' : 'AM'
  const hour12 = h % 12 || 12
  const min = String(m).padStart(2, '0')
  return `${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()} · ${hour12}:${min} ${period}`
}

function getGreeting(date) {
  const h = date.getHours()
  if (h < 5)  return 'Working late'
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  if (h < 21) return 'Good evening'
  return 'Working late'
}

function stringToColor(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff
  return `oklch(0.55 0.12 ${Math.abs(h) % 360})`
}

// Apps that have dedicated upstream updaters with a manual trigger
const UPDATABLE_APPS = { readiness: true, scheduler: true, statelogic: true }

export default function App() {
  const [authUser, setAuthUser]   = useState(null)
  const [authReady, setAuthReady] = useState(false)

  const [apps, setApps]           = useState(SKELETON_APPS)
  const [logPanelApp, setLogPanelApp] = useState(null)
  const [logs, setLogs]           = useState({})
  const [busy, setBusy]           = useState(false)
  const [updateStatus, setUpdateStatus] = useState(null)
  const [appVersion, setAppVersion]     = useState('')
  const [serverHost, setServerHost]     = useState('')
  const [launchOnStartup, setLaunchOnStartup] = useState(false)
  const [theme, setTheme]         = useState(() => localStorage.getItem('sdc-theme') || 'light')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [viewMode, setViewMode]   = useState('grid')
  const searchRef = useRef(null)

  // Live clock (updates every 30 seconds)
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  // Last-opened timestamps (persisted in localStorage)
  const [lastOpened, setLastOpened] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sdc-last-opened') || '{}') }
    catch { return {} }
  })

  // Last time all services were running
  const [lastSync, setLastSync] = useState(null)
  const prevRunning = useRef(0)
  useEffect(() => {
    const running = apps.filter(a => a.status === 'running').length
    if (running === apps.length && apps.length > 0 && running !== prevRunning.current) {
      setLastSync(Date.now())
    }
    prevRunning.current = running
  }, [apps])

  // Recent activity log (persisted)
  const [activity, setActivity] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sdc-activity') || '[]') }
    catch { return [] }
  })

  // ── Auth check ────────────────────────────────────────────────────────────
  useEffect(() => {
    api.authGetStatus().then(status => {
      if (status.isAuthenticated) {
        setAuthUser(status.user)
      } else if (!status.configured) {
        setAuthUser({ name: 'Dev Mode', email: 'dev@sdcautomation.com' })
      } else {
        setAuthUser(false)
      }
      setAuthReady(true)
    }).catch(() => {
      setAuthUser({ name: 'Dev Mode', email: 'dev@sdcautomation.com' })
      setAuthReady(true)
    })
  }, [])

  // Per-app roles/flags from the central SSO exchange (fresh login or the
  // silent startup restore both land here — same source either way). Used
  // only to filter which tiles show; the real enforcement is server-side in
  // each app's own sdcSessionAuth.js gate, not this. Stays null if the
  // exchange hasn't run or failed — in that case every tile stays visible
  // (unchanged behavior), since hiding everything on a fetch hiccup would be
  // worse than a tile that shows but the server still correctly blocks.
  const [sdcApps, setSdcApps] = useState(null)
  useEffect(() => {
    if (!authUser) return
    api.getSdcApps().then(setSdcApps).catch(() => {})
  }, [authUser])

  const handleSignOut = useCallback(async () => {
    await api.authLogout()
    setAuthUser(false)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('sdc-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!authUser) return
    api.getStatus().then(status => {
      if (Object.keys(status).length) setApps(Object.values(status))
    })
    api.getAppVersion().then(v => setAppVersion(v))
    api.getServerHost().then(h => setServerHost(h))
    api.getLaunchOnStartup().then(v => setLaunchOnStartup(v))

    const unsubStatus = api.onStatusChange(status => setApps(Object.values(status)))
    const unsubLog = api.onAppLog(({ id, line }) => {
      setLogs(prev => {
        const cur = prev[id] || []
        const next = [...cur, line]
        return { ...prev, [id]: next.length > 200 ? next.slice(-200) : next }
      })
    })
    const syncInterval = setInterval(() => api.syncStatus(), 8000)
    const unsubUpdate = api.onUpdateStatus(setUpdateStatus)

    return () => { unsubStatus(); unsubLog(); unsubUpdate(); clearInterval(syncInterval) }
  }, [authUser])

  // ── Keyboard shortcut: Ctrl+K focuses search ─────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      // Electron still routes keydown to this window's listeners in some
      // cases even when it isn't the OS-focused window (main.js separately
      // registers real global shortcuts for Ctrl+1–6 that are meant to work
      // from anywhere) — without this, these shortcuts double-fire.
      if (!document.hasFocus()) return

      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
      }
      // Ctrl+1–6 opens apps
      if (e.ctrlKey && e.key >= '1' && e.key <= '6') {
        const idx = Number(e.key) - 1
        const app = apps[idx]
        if (app?.status === 'running') handleOpen(app.id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [apps])

  const handleCheckForUpdates = useCallback(async () => {
    setCheckingUpdate(true)
    await api.checkForUpdates()
    setTimeout(() => setCheckingUpdate(false), 3000)
  }, [])

  const handleToggleStartup = useCallback(async () => {
    const next = await api.setLaunchOnStartup(!launchOnStartup)
    setLaunchOnStartup(next)
  }, [launchOnStartup])

  const handleOpen = useCallback(async (appId) => {
    await api.openApp(appId)
    const ts = Date.now()
    setLastOpened(prev => {
      const next = { ...prev, [appId]: ts }
      localStorage.setItem('sdc-last-opened', JSON.stringify(next))
      return next
    })
    setActivity(prev => {
      const appName = apps.find(a => a.id === appId)?.name || appId
      const entry = { id: ts, type: 'open', appId, appName, label: `Opened ${appName}`, ts }
      const next = [entry, ...prev].slice(0, 20)
      localStorage.setItem('sdc-activity', JSON.stringify(next))
      return next
    })
  }, [apps])

  const handleRetry        = useCallback((appId) => api.retryApp(appId), [])
  const handleTriggerUpdate = useCallback((appId) => api.triggerUpdate?.(appId), [])
  const handleStopAll    = useCallback(async () => { setBusy(true); await api.stopAll();    setBusy(false) }, [])
  const handleRestartAll = useCallback(async () => { setBusy(true); await api.restartAll(); setBusy(false) }, [])
  const handleShowLogs   = useCallback(async (appId) => {
    const existing = await api.getLogs(appId)
    setLogs(prev => ({ ...prev, [appId]: existing }))
    setLogPanelApp(appId)
  }, [])

  const runningCount = apps.filter(a => a.status === 'running').length
  const allOnline    = runningCount === apps.length && apps.length > 0
  const updatableCount = apps.filter(a => UPDATABLE_APPS[a.id]).length

  if (!authReady) return <div className="auth-loading">Checking credentials…</div>
  if (!authUser)  return <LoginScreen onLogin={user => setAuthUser(user)} />

  const initials  = authUser.name
    ? authUser.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : authUser.email[0].toUpperCase()
  const firstName = authUser.name?.split(' ')[0] || authUser.email?.split('@')[0] || 'there'

  // Only hide a tile if sdcApps actually covers that app AND says no —
  // an app sdcApps doesn't mention yet (e.g. 'reports', not part of the SSO
  // rollout) or a roles fetch that hasn't resolved stays visible as before.
  const visibleApps = sdcApps
    ? apps.filter(a => !(a.id in sdcApps) || Boolean(sdcApps[a.id]))
    : apps

  // Filter apps by search
  const filteredApps = searchQuery.trim()
    ? visibleApps.filter(a =>
        a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        a.description?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : visibleApps

  return (
    <div className="app">
      <WindowChrome />

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="app-header">
        {/* Brand (left) */}
        <div className="header-brand">
          <img src={sdcLogo} alt="Steven Douglas Corp." className="brand-mark-img" />
          <div className="header-wordmark">
            <div className="header-title">Steven Douglas Corp.</div>
            <div className="header-subtitle">Engineering Excellence · Trusted Partnerships</div>
          </div>
          {/* The product name (2026-08-24). The header identified the COMPANY but
              never the application — "SDC Tools" appeared only in the OS title bar,
              so the launcher never said what it was. Set as its own wordmark rather
              than folded into the line above, because the two are different things:
              one is who we are, one is which app this is. Same Montserrat treatment
              as the corporate wordmark it sits beside, so it reads as part of the
              same lockup and not as a heading. */}
          <div className="header-product">SDC Tools</div>
        </div>


        {/* Controls (right) */}
        <div className="header-controls">
          <button
            className="btn btn-header"
            onClick={handleCheckForUpdates}
            disabled={checkingUpdate}
            title="Check for SDC Tools app updates now"
          >
            ↑ {checkingUpdate ? 'Checking…' : 'Check updates'}
          </button>

          <NotificationCenter />

          <button
            className="btn-header-icon"
            onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
            title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
            aria-label="Toggle theme"
          >
            {theme === 'light'
              ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
              : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            }
          </button>

          <div className="header-user" title={authUser.email}>
            <span
              className="header-user-avatar"
              style={{ background: authUser.name ? stringToColor(authUser.name) : undefined }}
            >
              {initials}
            </span>
            <div className="header-user-info">
              <span className="header-user-name">{authUser.name || authUser.email}</span>
              <span className="header-user-email">{authUser.email}</span>
            </div>
            {appVersion && <span className="version-tag" title={`Version ${appVersion}`}>v{formatVersion(appVersion)}</span>}
          </div>

          <button
            className="btn btn-header btn-signout-labeled"
            onClick={handleSignOut}
            title={`Sign out ${authUser.email}`}
          >
            ⏻ Sign out
          </button>
        </div>
      </header>

      {/* ── Update banner ─────────────────────────────────────────── */}
      <UpdateBanner
        status={updateStatus}
        onDownload={() => api.updateDownload()}
        onInstall={() => api.updateInstall()}
        onDismiss={() => setUpdateStatus(null)}
      />

      {/* ── Hero section ──────────────────────────────────────────── */}
      <section className="app-hero">
        <div className="hero-inner">
          {/* Left: greeting */}
          <div className="greeting">
            <h1 className="greeting-h1">
              {getGreeting(now)}, <span className="greeting-accent">{firstName}.</span>
            </h1>
            <div className="greeting-meta">
              <span className="date-pill">
                <span className="date-dot" />
                {formatHeaderDate(now)}
              </span>
            </div>
          </div>

        </div>
      </section>

      {/* ── Main ──────────────────────────────────────────────────── */}
      <main className="app-main">
        <div className="main-content">

          {/* Two-column content grid: apps + right rail */}
          <div className="content-grid">
            <section className="apps-section">
              {/* Section eyebrow */}
              <div className="section-eyebrow">
                <span className="section-eyebrow-title">Applications</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, color: 'var(--text-3)' }}>
                  <span>{runningCount} of {apps.length} running</span>
                  <div className="view-toggle">
                    <button
                      className={viewMode === 'grid' ? 'active' : ''}
                      onClick={() => setViewMode('grid')}
                    >
                      Grid
                    </button>
                    <button
                      className={viewMode === 'list' ? 'active' : ''}
                      onClick={() => setViewMode('list')}
                    >
                      List
                    </button>
                  </div>
                </div>
              </div>

              <AppGrid
                apps={filteredApps}
                lastOpened={lastOpened}
                onOpen={handleOpen}
                onRetry={handleRetry}
                onShowLogs={handleShowLogs}
                onTriggerUpdate={handleTriggerUpdate}
                viewMode={viewMode}
              />
            </section>

          </div>
        </div>
      </main>

      {logPanelApp && (
        <LogPanel
          appId={logPanelApp}
          appName={apps.find(a => a.id === logPanelApp)?.name ?? logPanelApp}
          lines={logs[logPanelApp] || []}
          onClose={() => setLogPanelApp(null)}
        />
      )}

    </div>
  )
}
