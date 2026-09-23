import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import sql from "mssql";

// Connection comes entirely from env vars, injected by Claude Desktop from
// this extension's user_config (see manifest.json) — nothing is hardcoded
// here. sql_password is marked "sensitive" in the manifest, which is what
// makes Claude Desktop store it in the OS's own secure credential storage
// rather than a plaintext file.
for (const name of ["SQL_HOST", "SQL_PORT", "SQL_DATABASE", "SQL_USER", "SQL_PASSWORD"]) {
    if (!process.env[name]) {
        console.error(`[totaleto-sdc] Missing required env var ${name} — check the extension's configuration in Claude Desktop.`);
        process.exit(1);
    }
}

const config = {
    server: process.env.SQL_HOST,
    database: process.env.SQL_DATABASE,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: {
        // encrypt:true does not require a real certificate — SQL Server
        // generates its own self-signed one automatically, and
        // trustServerCertificate:true accepts it without validating who
        // issued it. That still encrypts the wire traffic (the password
        // above and every query result), it just doesn't defend against an
        // active man-in-the-middle presenting its own cert. For traffic
        // that stays inside the SDC network, that's the right tradeoff
        // without standing up real PKI. Do not flip this back to false.
        encrypt: true,
        trustServerCertificate: true,
        requestTimeout: 30000,
    },
    port: Number(process.env.SQL_PORT),
    pool: {
        max: 10,
        min: 1,
        idleTimeoutMillis: 30000,
    },
};

// Persistent pool — created once at startup and reused across all tool calls.
// Never close it mid-session; mssql manages individual connections internally.
const pool = await new sql.ConnectionPool(config).connect();
process.on("SIGTERM", () => pool.close());
process.on("SIGINT", () => pool.close());

const server = new McpServer({ name: "mssql-sdc", version: "1.1.0" });
const readOnly = { annotations: { readOnlyHint: true } };

// ── Read-only guard for the one ad-hoc tool (query_sdc) ─────────────────────
// The other 8 tools below only ever run fixed, application-authored SQL with
// zod-typed inputs — they don't need this. query_sdc takes an arbitrary
// string from the caller, which is exactly the surface every other
// database-access tool in this codebase (lib/agent.js, mcp/sdc-db-server.mjs,
// the sibling MySQL dxt) already guards the same way: one statement, a
// read-only leading verb, no sensitive columns.
const FORBIDDEN_IDENT = /\b(password|pwd|secret|api_key|token)\b/i;
function assertReadOnly(sqlStr) {
    const s = String(sqlStr || "").trim().replace(/;\s*$/, "");
    if (!s) throw new Error("Empty query.");
    if (s.includes(";")) throw new Error("Only one statement is allowed.");
    if (!/^(select|with)\b/i.test(s)) throw new Error("Only SELECT/WITH queries are allowed.");
    const m = s.match(FORBIDDEN_IDENT);
    if (m) throw new Error(`Query references a sensitive column ("${m[0]}") — blocked.`);
    return s;
}

const ROW_CAP = 1000;

// Every query — ad-hoc or one of the 8 fixed tools below — runs inside a
// transaction that is ALWAYS rolled back, win or lose. SQL Server has no
// exact equivalent of MySQL's "START TRANSACTION READ ONLY", so this is the
// real protection: even if a write statement somehow got past assertReadOnly
// (or one of the fixed queries below had a bug), nothing it did would
// persist. This is defense-in-depth on top of TETO_ReadOnly's own DB-level
// grants, not a replacement for them — the account itself must stay
// SELECT-only.
async function runQuery(sqlStr) {
    const transaction = new sql.Transaction(pool);
    let began = false;
    try {
        await transaction.begin();
        began = true;
        const request = new sql.Request(transaction);
        const result = await request.query(sqlStr);
        await transaction.rollback();
        const rows = result.recordset || [];
        const payload = rows.length > ROW_CAP
            ? { truncatedTo: ROW_CAP, rowCount: rows.length, rows: rows.slice(0, ROW_CAP) }
            : rows;
        // Compact JSON (no indentation) keeps payloads small and avoids Claude.ai submission timeouts
        return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
        };
    } catch (err) {
        if (began) { try { await transaction.rollback(); } catch (_) {} }
        return {
            content: [{ type: "text", text: `Database error: ${err.message}` }],
            isError: true,
        };
    }
}

// Tool 1: Run any SELECT query (escape hatch for ad-hoc queries)
server.registerTool(
    "query_sdc",
    {
        description: "Run a single read-only SQL SELECT/WITH query against the SDC database. Rejected if it isn't read-only, contains more than one statement, or references a sensitive column. Use this only when no other tool covers the need.",
        inputSchema: { sql: z.string().describe("The SQL SELECT query to run") },
        ...readOnly,
    },
    async ({ sql: sqlQuery }) => {
        let safe;
        try {
            safe = assertReadOnly(sqlQuery);
        } catch (e) {
            return { content: [{ type: "text", text: e.message }], isError: true };
        }
        return runQuery(safe);
    }
);

// Tool 2: Get unpaid/uninvoiced POs (money owed to suppliers not yet invoiced to company)
server.registerTool(
    "get_unpaid_amounts",
    {
        description: "Get purchase orders where the supplier has not yet been fully invoiced — money the company still owes or has outstanding. Returns top 100 by outstanding amount. Use project_id to filter to a specific job.",
        inputSchema: {
            project_id: z.number().optional().describe("Optional: filter by project ID"),
            limit: z.number().optional().describe("Max rows to return (default 100, max 500)"),
        },
        ...readOnly,
    },
    async ({ project_id, limit = 100 }) => {
        const top = Math.min(Math.max(1, Math.floor(limit)), 500);
        let q = `
            SELECT TOP ${top}
                P.ProjectID AS [Job ID],
                POD.SpecID AS [Section ID],
                S.SDescription AS [Section Name],
                tblEngItemMaster.ItemCompanyID AS [Part Number],
                tblEngItemMaster.ItemDescription AS [Description],
                SUPP.cname AS [Supplier],
                CAST(POH.PurchaseOrderID AS NVARCHAR(50)) AS [PO Number],
                POD.PurchaseQty AS [Quantity],
                POD.PurchasePrice AS [Unit Price $],
                POD.PurchaseQty * POD.PurchasePrice AS [Total PO Value $],
                ISNULL(INVOICED.TotalInvoicedAmount, 0) AS [Invoiced Amount $],
                (POD.PurchaseQty * POD.PurchasePrice) - ISNULL(INVOICED.TotalInvoicedAmount, 0) AS [Outstanding Amount $],
                CONVERT(date, POH.PurchaseDate) AS [Purchase Date]
            FROM tblPurchaseOrderHeader POH WITH(NOLOCK)
                INNER JOIN tblPurchaseOrderDetails POD WITH(NOLOCK) ON POH.PurchaseOrderID = POD.PurchaseOrderID
                LEFT JOIN tblSpec S WITH(NOLOCK) ON S.SpecID = POD.SpecID AND S.ProjectID = POD.ProjectID
                LEFT JOIN tblProjects P WITH(NOLOCK) ON S.ProjectID = P.ProjectID
                LEFT JOIN tblEngItemMaster WITH(NOLOCK) ON POD.ItemID = tblEngItemMaster.ItemID
                INNER JOIN udfCompanyRetrieveDisplayNames(DEFAULT) SUPP ON POH.PurchaseSupplierID = SUPP.CompanyID
                LEFT JOIN (
                    SELECT APDD.PurchaseDetailID,
                        SUM(APDocQty * APDocUnitPrice * (1 - APDocItemPctDisc) * APDocCurrRate) AS TotalInvoicedAmount
                    FROM tblAPDocumentDetails APDD WITH(NOLOCK)
                        INNER JOIN tblAPBatchDocument APBD WITH(NOLOCK) ON APBD.APDocID = APDD.APDocID
                    WHERE BatchEntryTypeID NOT IN (2, 3) AND APDD.PurchaseDetailID IS NOT NULL
                    GROUP BY APDD.PurchaseDetailID
                ) INVOICED ON POD.PurchaseDetailID = INVOICED.PurchaseDetailID
            WHERE (POD.PurchaseQty * POD.PurchasePrice) > ISNULL(INVOICED.TotalInvoicedAmount, 0)
        `;
        if (project_id) q += ` AND P.ProjectID = ${Math.floor(project_id)}`;
        q += ` ORDER BY [Outstanding Amount $] DESC`;
        return runQuery(q);
    }
);

// Tool 3: List active (Sold) projects
server.registerTool(
    "list_active_projects",
    {
        description: "List active in-progress projects (status = Sold) with customer, delivery date, sales person, and manager. Returns up to 100 by default ordered by delivery date. Use limit to get more.",
        inputSchema: {
            status: z.enum(["Sold", "Proposal", "Quoted", "Dead", "Lost"]).optional()
                .describe("Filter by project status (default: Sold = active/in-progress jobs)"),
            limit: z.number().optional().describe("Max rows to return (default 100, max 277)"),
        },
        ...readOnly,
    },
    async ({ status = "Sold", limit = 100 }) => {
        const top = Math.min(Math.max(1, Math.floor(limit)), 500);
        const safeStatus = status.replace(/'/g, "''");
        const q = `
            SELECT TOP ${top}
                P.ProjectID AS [Job ID],
                P.PDescription AS [Description],
                P.CName AS [Customer],
                P.CompanyCity AS [City],
                P.PStatus AS [Status],
                P.SalesPerson AS [Sales Person],
                P.Manager AS [Manager],
                CONVERT(date, P.PDelivery) AS [Delivery Date],
                P.PercentComplete AS [% Complete],
                P.PSaleCurr AS [Currency]
            FROM vwProjects P WITH(NOLOCK)
            WHERE P.PStatus = '${safeStatus}'
            ORDER BY P.PDelivery ASC
        `;
        return runQuery(q);
    }
);

// Tool 4: Get project costing — actuals vs estimates
server.registerTool(
    "get_project_costing",
    {
        description: "Get labour hours, labour cost, materials, total cost, sales price and margin — actuals versus estimates. Always pass project_id for a single job. Omit project_id only to compare all jobs (returns up to 50, worst margin first).",
        inputSchema: {
            project_id: z.number().optional().describe("Filter to a single project ID (recommended). Omit to see worst-performing jobs across all active projects."),
            limit: z.number().optional().describe("Max rows when no project_id given (default 50, max 277)"),
        },
        ...readOnly,
    },
    async ({ project_id, limit = 50 }) => {
        const top = project_id ? 1 : Math.min(Math.max(1, Math.floor(limit)), 277);
        let q = `
            SELECT TOP ${top}
                C.ProjectID AS [Job ID],
                C.PDescription AS [Description],
                C.CompanyCity AS [Customer City],
                C.EstEngHours AS [Est Eng Hrs],
                C.ActEngHours AS [Act Eng Hrs],
                C.EstMfgHours AS [Est Mfg Hrs],
                C.ActMfgHours AS [Act Mfg Hrs],
                C.EstAdminHours AS [Est Admin Hrs],
                C.ActAdminHours AS [Act Admin Hrs],
                C.EngEstimateExtended AS [Est Eng Labor $],
                C.ActEngLabor AS [Act Eng Labor $],
                C.MfgEstimateExtended AS [Est Mfg Labor $],
                C.ActMfgLabor AS [Act Mfg Labor $],
                C.EstTotalMaterials AS [Est Materials $],
                C.ActTotalMaterials AS [Act Materials $],
                C.ExtendedEstimate AS [Total Estimate $],
                C.ActTotalCost AS [Total Actual Cost $],
                C.SalesPrice AS [Sales Price $],
                C.BudgetMargin AS [Budget Margin %],
                C.ActualMargin AS [Actual Margin %]
            FROM vwProjectActualsVSEstimates C WITH(NOLOCK)
            WHERE C.ProjectID IN (SELECT ProjectID FROM tblProjects WITH(NOLOCK) WHERE PStatus = 'Sold')
        `;
        if (project_id) q += ` AND C.ProjectID = ${Math.floor(project_id)}`;
        q += ` ORDER BY C.ActualMargin ASC`;
        return runQuery(q);
    }
);

// Tool 5: Get specs/sections for a project
server.registerTool(
    "get_project_specs",
    {
        description: "Get all sections (specs/machines) for a project — description, engineer, build location, scheduled dates, % complete, and invoiced amount. Use this when asked about sections or machines on a job.",
        inputSchema: {
            project_id: z.number().describe("The project/job ID"),
            active_only: z.boolean().optional().describe("Only return active non-archived specs (default: true)"),
        },
        ...readOnly,
    },
    async ({ project_id, active_only = true }) => {
        let q = `
            SELECT
                S.ProjectID AS [Job ID],
                S.SpecID AS [Section ID],
                S.SDescription AS [Description],
                S.SQuantity AS [Qty],
                S.MachineTypeName AS [Machine Type],
                S.EngineerFullName AS [Engineer],
                S.BuildLocationDescription AS [Build Location],
                CONVERT(date, S.BudgetEngRelease) AS [Eng Release Date],
                CONVERT(date, S.BudgetMfgRelease) AS [Mfg Release Date],
                CONVERT(date, S.BudgetShipRelease) AS [Ship Date],
                S.PercentComplete AS [% Complete],
                S.SalesPrice AS [Sales Price $],
                S.SAmountInvoicedtoDate AS [Invoiced to Date $],
                S.SFinalBillingComplete AS [Billing Complete]
            FROM vwSpec S WITH(NOLOCK)
            WHERE S.ProjectID = ${Math.floor(project_id)}
        `;
        if (active_only) q += ` AND S.SActive = 1 AND S.Archived = 0`;
        q += ` ORDER BY S.SpecID ASC`;
        return runQuery(q);
    }
);

// Tool 6: Get payment / invoicing schedule for a project
server.registerTool(
    "get_payment_schedule",
    {
        description: "Get the invoicing and payment schedule — sales price, total invoiced, outstanding amount, and terms breakdown. Always pass project_id for a single job. Omit to see most outstanding across all jobs (returns up to 50).",
        inputSchema: {
            project_id: z.number().optional().describe("Filter to a single project ID (recommended). Omit to see jobs with most outstanding billing."),
            limit: z.number().optional().describe("Max rows when no project_id given (default 50, max 277)"),
        },
        ...readOnly,
    },
    async ({ project_id, limit = 50 }) => {
        const top = project_id ? 1 : Math.min(Math.max(1, Math.floor(limit)), 277);
        let q = `
            SELECT TOP ${top}
                PS.ProjectID AS [Job ID],
                P.PDescription AS [Description],
                P.CName AS [Customer],
                PS.PSaleCurr AS [Currency],
                PS.SalesPrice AS [Sales Price $],
                PS.ProjectEstimate AS [Total Estimate $],
                PS.Invoiced AS [Total Invoiced $],
                PS.ToBeInvoiced AS [To Be Invoiced $],
                PS.TermsTotal AS [Terms Total $],
                PS.OutstandingTermsAmount AS [Outstanding Terms $],
                PS.CreditNotesTotal AS [Credit Notes $]
            FROM vwPaymentSchedule PS WITH(NOLOCK)
            INNER JOIN vwProjects P WITH(NOLOCK) ON P.ProjectID = PS.ProjectID
            WHERE PS.ProjectID IN (SELECT ProjectID FROM tblProjects WITH(NOLOCK) WHERE PStatus = 'Sold')
        `;
        if (project_id) q += ` AND PS.ProjectID = ${Math.floor(project_id)}`;
        q += ` ORDER BY PS.OutstandingTermsAmount DESC`;
        return runQuery(q);
    }
);

// Tool 7: Get open purchase orders
server.registerTool(
    "get_open_purchase_orders",
    {
        description: "Get open purchase orders — supplier, part, quantity ordered vs received, date required, and outstanding value. Returns up to 200 rows by default (soonest due first). Filter by project or set overdue_only for targeted results.",
        inputSchema: {
            project_id: z.number().optional().describe("Filter by project ID"),
            overdue_only: z.boolean().optional().describe("Only show POs where date required is past today"),
            limit: z.number().optional().describe("Max rows to return (default 200)"),
        },
        ...readOnly,
    },
    async ({ project_id, overdue_only, limit = 200 }) => {
        const top = Math.min(Math.max(1, Math.floor(limit)), 1000);
        let q = `
            SELECT TOP ${top}
                POD.PurchaseOrderID AS [PO Number],
                POH.CName AS [Supplier],
                POD.ProjectID AS [Job ID],
                POD.SpecID AS [Section ID],
                POD.ItemCompanyID AS [Part Number],
                POD.PurchaseSupplierDescription AS [Supplier Description],
                POD.ItemDescription AS [Internal Description],
                POD.PurchaseQty AS [Qty Ordered],
                ISNULL(POD.Received, 0) AS [Qty Received],
                POD.PurchaseQty - ISNULL(POD.Received, 0) AS [Qty Outstanding],
                POD.PurchasePrice AS [Unit Price $],
                (POD.PurchaseQty - ISNULL(POD.Received, 0)) * POD.PurchasePrice AS [Outstanding Value $],
                CONVERT(date, POH.PurchaseDate) AS [PO Date],
                CONVERT(date, POD.DateRequired) AS [Date Required]
            FROM vwPurchaseOrderDetails POD WITH(NOLOCK)
            INNER JOIN vwPurchaseOrderHeader POH WITH(NOLOCK) ON POH.PurchaseOrderID = POD.PurchaseOrderID
            WHERE POH.PurchaseActive = 1
              AND POD.Archived = 0
              AND POD.PurchaseQty > ISNULL(POD.Received, 0)
        `;
        if (project_id) q += ` AND POD.ProjectID = ${Math.floor(project_id)}`;
        if (overdue_only) q += ` AND POD.DateRequired < GETDATE()`;
        q += ` ORDER BY POD.DateRequired ASC`;
        return runQuery(q);
    }
);

// Tool 8: Get recent PO receipts (receiver log)
server.registerTool(
    "get_receiver_log",
    {
        description: "Get recent purchase order receipts — what materials arrived, when, from which supplier, and against which job/section. Returns up to 200 rows by default for the last 14 days.",
        inputSchema: {
            days: z.number().optional().describe("How many days back to look (default: 14)"),
            project_id: z.number().optional().describe("Filter by project ID"),
            limit: z.number().optional().describe("Max rows to return (default 200)"),
        },
        ...readOnly,
    },
    async ({ days = 14, project_id, limit = 200 }) => {
        const safeDays = Math.min(Math.max(1, Math.floor(days)), 365);
        const top = Math.min(Math.max(1, Math.floor(limit)), 1000);
        let q = `
            SELECT TOP ${top}
                RL.PurchaseOrderID AS [PO Number],
                RL.Supplier AS [Supplier],
                RL.ProjectID AS [Job ID],
                RL.SpecID AS [Section ID],
                RL.ItemCompanyID AS [Part Number],
                RL.ItemDescription AS [Description],
                RL.QtyReceived AS [Qty Received],
                RL.PurchasePrice AS [Unit Price $],
                RL.QtyReceived * RL.PurchasePrice AS [Received Value $],
                CONVERT(date, RL.Date) AS [Received Date],
                RL.PackingSlipNumber AS [Packing Slip]
            FROM vwReceiverLog RL WITH(NOLOCK)
            WHERE RL.Date >= DATEADD(day, -${safeDays}, GETDATE())
        `;
        if (project_id) q += ` AND RL.ProjectID = ${Math.floor(project_id)}`;
        q += ` ORDER BY RL.Date DESC`;
        return runQuery(q);
    }
);

// Tool 9: Get spec-level costing breakdown for a project
server.registerTool(
    "get_spec_costing",
    {
        description: "Get actual costs broken down by spec/section — labour hours by type, labour dollars, purchased materials, inventory pulls, and total cost with margin. Use this when asked about cost per section or machine within a job.",
        inputSchema: {
            project_id: z.number().describe("The project/job ID"),
        },
        ...readOnly,
    },
    async ({ project_id }) => {
        const q = `
            SELECT
                C.ProjectID AS [Job ID],
                C.SpecID AS [Section ID],
                S.SDescription AS [Section Name],
                C.EngHours AS [Eng Hours],
                C.MFGHours AS [Mfg Hours],
                C.AdminHours AS [Admin Hours],
                C.TotalHours AS [Total Hours],
                C.EngLabor AS [Eng Labor $],
                C.MFGLabor AS [Mfg Labor $],
                C.AdminLabor AS [Admin Labor $],
                C.TotalLabor AS [Total Labor $],
                C.TotalPurchasedMaterials AS [Purchased Materials $],
                C.TotalInventoryPulls AS [Inventory Pulls $],
                C.TotalExtraCosts AS [Extra Costs $],
                C.TotalMaterials AS [Total Materials $],
                C.TotalCost AS [Total Cost $],
                C.Margin AS [Margin %]
            FROM vwCostingSummed_BySpecID C WITH(NOLOCK)
            LEFT JOIN vwSpec S WITH(NOLOCK) ON S.ProjectID = C.ProjectID AND S.SpecID = C.SpecID
            WHERE C.ProjectID = ${Math.floor(project_id)}
            ORDER BY C.TotalCost DESC
        `;
        return runQuery(q);
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
