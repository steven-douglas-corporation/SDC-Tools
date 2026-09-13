# SDC Power BI MCP server

A small [Model Context Protocol](https://modelcontextprotocol.io) server that lets
Claude run live DAX queries against the **Job Hours Report - Management Level**
semantic model in the **SDC Reports** workspace.

Each user signs in as themselves (interactive Entra login, token cached locally),
so queries respect row-level security. It talks to the Power BI REST
`executeQueries` endpoint — no XMLA endpoint, app registration, or admin consent
required.

## Tools exposed to Claude

| Tool | What it does |
| --- | --- |
| `run_dax` | Run any DAX query (usually starting with `EVALUATE`) and get rows back as JSON. |
| `list_tables` | List the model's tables (auto-generated date tables excluded). |
| `list_measures` | List measures with their home table and description. |

> The DAX **expression** of a measure is not available over the query API. Read the
> model's `.tmdl` files in this repo for measure definitions.

## Prerequisites

- .NET 8 SDK (only needed to build; the published exe is self-contained).
- Membership/access to the SDC Reports workspace with permission to query the dataset.
- The tenant's **"Dataset Execute Queries REST API"** setting must be enabled (it is).

## Build & publish

From this folder:

```powershell
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o publish/win-x64
```

This produces a standalone `publish/win-x64/sdc-powerbi-mcp.exe` that needs no
.NET install on the target machine.

## First-time sign-in

Run once to authenticate. A browser window opens; sign in with your work account.
The token is cached (DPAPI-encrypted) under `%LOCALAPPDATA%\SdcPowerBiMcp`.

```powershell
.\publish\win-x64\sdc-powerbi-mcp.exe login
```

Quick checks from the command line:

```powershell
.\publish\win-x64\sdc-powerbi-mcp.exe tables
.\publish\win-x64\sdc-powerbi-mcp.exe measures
.\publish\win-x64\sdc-powerbi-mcp.exe query "EVALUATE ROW(\"Hours\", [Hours Actual])"
```

## Use from Claude

The repo's [`.mcp.json`](../.mcp.json) registers this server (stdio) as `powerbi`.
With no arguments the exe runs as the MCP server; Claude launches it automatically.
Restart Claude after the first build so it picks up the server, then ask questions
like *"what were total actual vs quoted hours?"* and Claude will call `run_dax`.

## Configuration (optional env vars)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PBI_GROUP_ID` | `d57acc39-0718-434d-a17c-1261d95a4d18` | Workspace (group) GUID. |
| `PBI_DATASET_ID` | `5a47445c-a1c3-45b9-93e5-a9df3c465b29` | Semantic model GUID. |
| `PBI_CLIENT_ID` | Azure PowerShell public client | Use a company-governed app registration instead. |
| `PBI_TENANT_ID` | (multi-tenant) | Pin sign-in to a specific tenant. |

## Why REST and not XMLA?

XMLA/ADOMD was the first approach, but the XMLA endpoint rejected valid user
tokens (`Authentication failed for all authenticators`) — an endpoint/capacity-level
block we can't change from the client. The REST `executeQueries` endpoint accepts
the same token and runs any DAX, so the server uses that. The only thing lost is
the ability to read measure DAX expressions over the API, which the repo's `.tmdl`
files already provide.
