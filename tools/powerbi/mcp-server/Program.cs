using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using SdcPowerBiMcp;

// ---------------------------------------------------------------------------
// CLI modes (run the exe directly). Handy for first-time login and quick tests
// without going through the MCP transport.
//   sdc-powerbi-mcp login            -> interactive sign-in, caches the token
//   sdc-powerbi-mcp query "<DAX>"    -> run a DAX query, print JSON
//   sdc-powerbi-mcp tables           -> list tables
//   sdc-powerbi-mcp measures         -> list measures
// With no args it runs as an MCP stdio server (how Claude launches it).
// ---------------------------------------------------------------------------
if (args.Length > 0)
{
    var pbi = PowerBiConnection.FromEnvironment();
    switch (args[0].ToLowerInvariant())
    {
        case "login":
            await pbi.LoginInteractiveAsync();
            return 0;
        case "query":
            if (args.Length < 2)
            {
                Console.Error.WriteLine("usage: sdc-powerbi-mcp query \"<DAX>\"");
                return 2;
            }
            Console.WriteLine(await pbi.RunDaxJsonAsync(args[1]));
            return 0;
        case "tables":
            Console.WriteLine(await pbi.ListTablesJsonAsync());
            return 0;
        case "measures":
            Console.WriteLine(await pbi.ListMeasuresJsonAsync());
            return 0;
        default:
            Console.Error.WriteLine($"unknown command: {args[0]}");
            return 2;
    }
}

// ---------------------------------------------------------------------------
// MCP stdio server. stdout is reserved for the protocol, so all logging goes
// to stderr.
// ---------------------------------------------------------------------------
var builder = Host.CreateApplicationBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace);

builder.Services.AddSingleton(PowerBiConnection.FromEnvironment());
builder.Services
    .AddMcpServer()
    .WithStdioServerTransport()
    .WithToolsFromAssembly();

await builder.Build().RunAsync();
return 0;
