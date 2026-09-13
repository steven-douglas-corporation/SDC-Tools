# Vetted DAX query library

Reusable, **tested** DAX patterns for the Job Hours Report model, runnable as-is via the
`run_dax` MCP tool. Each was validated against the live model. Adjust the `TOPN(n, …)`
count or add filters as needed.

**Before adding a query here, run it.** Store the query and its intent, **not** results —
the model refreshes and grows, so cached numbers go stale. See `MODEL-NOTES.md` for schema
and the gotchas these patterns are built to avoid.

---

## Hours

### Total actual vs quoted hours
```dax
EVALUATE ROW("Total Hours Actual", [Hours Actual], "Total Hours Quoted", [Hours Quoted])
```

### Hours by function (leaf level — REQUIRED `Is Total` filter)
Slicing by `Function Hierarchy` without `Is Total = FALSE` doubles every number
(412 leaf + 412 total members). Always include the `CALCULATETABLE` filter.
```dax
EVALUATE
TOPN(
    10,
    CALCULATETABLE(
        SUMMARIZECOLUMNS(
            'Function Hierarchy'[Section Function Name],
            "Hours Actual", [Hours Actual]
        ),
        'Function Hierarchy'[Is Total] = FALSE
    ),
    [Hours Actual], DESC
)
ORDER BY [Hours Actual] DESC
```

---

## Jobs

### Top N jobs by actual hours
```dax
EVALUATE
TOPN(10,
    SUMMARIZECOLUMNS('Job'[Job Id], 'Job'[Job Name], "Hours Actual", [Hours Actual]),
    [Hours Actual], DESC)
ORDER BY [Hours Actual] DESC
```

### Top N jobs by profit (dollars — the reliable profitability ranking)
Rank by `Job Profit/Loss` ($), **not** `Job Profitability %`: that margin measure clamps
at 100% and isn't Profit ÷ Sales, so a margin ranking is a meaningless wall of 100%.
```dax
EVALUATE
TOPN(10,
    SUMMARIZECOLUMNS('Job'[Job Id], 'Job'[Job Name], 'Job'[Job Customer],
        "Profit", [Job Profit/Loss],
        "Margin", [Job Profitability %]),
    [Job Profit/Loss], DESC)
ORDER BY [Job Profit/Loss] DESC
```

### Profitable jobs you can trust (completed jobs only)
Filter to booked-cost jobs before looking at margin.
```dax
EVALUATE
TOPN(10,
    FILTER(
        SUMMARIZECOLUMNS('Job'[Job Id], 'Job'[Job Name],
            "Profit", [Job Profit/Loss],
            "Margin", [Job Profitability %]),
        'Job'[Job Status] = "Complete" && [Job Profitability %] < 1),
    [Job Profitability %], DESC)
ORDER BY [Job Profitability %] DESC
```

---

## Parts

### Top N jobs by invoiced part cost + biggest line item per job
"Top item" = the part Description with the largest invoiced amount on that job.
Note: a **blank-Job** row will appear (~$623K) — PO lines whose `Job ID` isn't in the
`Job` dimension (see MODEL-NOTES gotcha #3).
```dax
EVALUATE
TOPN(10,
    SUMMARIZECOLUMNS('Job'[Job Id], 'Job'[Job Name],
        "Part Invoiced", SUM('Part Purchase'[Invoiced Amount]),
        "Top Item",
            VAR Items = ADDCOLUMNS(VALUES('Part Purchase'[Description]),
                "@amt", CALCULATE(SUM('Part Purchase'[Invoiced Amount])))
            RETURN CONCATENATEX(TOPN(1, Items, [@amt], DESC), 'Part Purchase'[Description], " / "),
        "Top Item Invoiced",
            MAXX(ADDCOLUMNS(VALUES('Part Purchase'[Description]),
                "@amt", CALCULATE(SUM('Part Purchase'[Invoiced Amount]))), [@amt])),
    [Part Invoiced], DESC)
ORDER BY [Part Invoiced] DESC
```

### Unassigned part purchases (referential-integrity check)
```dax
EVALUATE
TOPN(20,
    SUMMARIZECOLUMNS('Part Purchase'[Job ID], 'Part Purchase'[Description],
        "Invoiced", SUM('Part Purchase'[Invoiced Amount])),
    'Part Purchase'[Job ID], NOT('Part Purchase'[Job ID] IN VALUES('Job'[Job Id])))
```

---

## Metadata / model exploration

### List a table's columns (exact names + types)
```dax
EVALUATE SELECTCOLUMNS(FILTER(INFO.VIEW.COLUMNS(), [Table] = "Part Purchase"),
    "Column", [Name], "DataType", [DataType])
```

### All relationships
```dax
EVALUATE SELECTCOLUMNS(INFO.VIEW.RELATIONSHIPS(),
    "Relationship", [Relationship], "Active", [IsActive])
```

### Find columns by name fragment across the model
```dax
EVALUATE SELECTCOLUMNS(FILTER(INFO.VIEW.COLUMNS(), CONTAINSSTRING([Name], "Total")),
    "Table", [Table], "Column", [Name])
```

### Connectivity / refresh check
```dax
EVALUATE ROW("Refreshed Thru", [Hours Refreshed Thru], "Model Refresh", [Model Refresh Date Time])
```
