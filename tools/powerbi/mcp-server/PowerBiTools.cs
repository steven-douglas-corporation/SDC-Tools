using System.ComponentModel;
using ModelContextProtocol.Server;

namespace SdcPowerBiMcp;

[McpServerToolType]
public static class PowerBiTools
{
    [McpServerTool(Name = "run_dax")]
    [Description("Execute a DAX query against the live Power BI semantic model and return the resulting rows as JSON. The query normally starts with EVALUATE, e.g. EVALUATE TOPN(10, VALUES('Job'[Job Id])).")]
    public static Task<string> RunDax(
        PowerBiConnection pbi,
        [Description("A DAX query, typically starting with EVALUATE.")] string dax)
        => pbi.RunDaxJsonAsync(dax);

    [McpServerTool(Name = "list_tables")]
    [Description("List the tables in the semantic model (auto-generated date tables are excluded).")]
    public static Task<string> ListTables(PowerBiConnection pbi)
        => pbi.ListTablesJsonAsync();

    [McpServerTool(Name = "list_measures")]
    [Description("List the measures in the semantic model with their home table and description. The DAX expression is not available over the query API — read the model's .tmdl files in this repo for measure definitions.")]
    public static Task<string> ListMeasures(PowerBiConnection pbi)
        => pbi.ListMeasuresJsonAsync();
}
