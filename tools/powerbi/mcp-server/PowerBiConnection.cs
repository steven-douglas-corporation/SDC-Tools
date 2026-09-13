using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Identity.Client;
using Microsoft.Identity.Client.Extensions.Msal;

namespace SdcPowerBiMcp;

/// <summary>
/// Handles Entra authentication (per-user, interactive with a persisted token cache)
/// and runs DAX against the published Power BI semantic model via the REST
/// executeQueries endpoint. Queries run as the signed-in user, so row-level
/// security is honored. Note: executeQueries cannot return measure DAX
/// expressions — those live in this repo's .tmdl files.
/// </summary>
public sealed class PowerBiConnection
{
    private readonly string _clientId;
    private readonly string _authority;
    private readonly string _groupId;
    private readonly string _datasetId;
    private readonly string[] _scopes = { "https://analysis.windows.net/powerbi/api/.default" };
    private static readonly HttpClient Http = new();
    private IPublicClientApplication? _app;

    public PowerBiConnection(string clientId, string? tenantId, string groupId, string datasetId)
    {
        _clientId = clientId;
        _authority = string.IsNullOrWhiteSpace(tenantId)
            ? "https://login.microsoftonline.com/organizations"
            : $"https://login.microsoftonline.com/{tenantId}";
        _groupId = groupId;
        _datasetId = datasetId;
    }

    public static PowerBiConnection FromEnvironment()
    {
        static string Get(string key, string def) =>
            Environment.GetEnvironmentVariable(key) is { Length: > 0 } v ? v : def;

        // Default: the well-known, pre-consented Azure PowerShell public client ID.
        // It can obtain tokens for the Power BI resource and has http://localhost
        // registered, so no custom app registration or admin consent is needed.
        // Override with PBI_CLIENT_ID to use a company-governed app registration instead.
        return new PowerBiConnection(
            clientId: Get("PBI_CLIENT_ID", "1950a258-227b-4e31-a9cf-717495945fc2"),
            tenantId: Environment.GetEnvironmentVariable("PBI_TENANT_ID"),
            groupId: Get("PBI_GROUP_ID", "d57acc39-0718-434d-a17c-1261d95a4d18"),
            datasetId: Get("PBI_DATASET_ID", "5a47445c-a1c3-45b9-93e5-a9df3c465b29"));
    }

    private async Task<IPublicClientApplication> GetAppAsync()
    {
        if (_app is not null) return _app;

        var app = PublicClientApplicationBuilder.Create(_clientId)
            .WithAuthority(_authority)
            .WithRedirectUri("http://localhost")
            .Build();

        var cacheDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SdcPowerBiMcp");
        Directory.CreateDirectory(cacheDir);
        var props = new StorageCreationPropertiesBuilder("msal_cache.bin", cacheDir).Build();
        var helper = await MsalCacheHelper.CreateAsync(props);
        helper.RegisterCache(app.UserTokenCache);

        _app = app;
        return app;
    }

    private async Task<string> GetTokenAsync(bool allowInteractive)
    {
        var app = await GetAppAsync();
        var accounts = await app.GetAccountsAsync();
        try
        {
            var result = await app.AcquireTokenSilent(_scopes, accounts.FirstOrDefault()).ExecuteAsync();
            return result.AccessToken;
        }
        catch (MsalUiRequiredException)
        {
            if (!allowInteractive)
                throw new InvalidOperationException(
                    "Not signed in. Run `sdc-powerbi-mcp login` once to authenticate, then retry.");
            var result = await app.AcquireTokenInteractive(_scopes).ExecuteAsync();
            return result.AccessToken;
        }
    }

    public async Task LoginInteractiveAsync()
    {
        var app = await GetAppAsync();
        var result = await app.AcquireTokenInteractive(_scopes).ExecuteAsync();
        Console.Error.WriteLine($"Signed in as {result.Account?.Username}.");
    }

    // Runs a DAX query through the Power BI REST executeQueries endpoint and
    // returns the result rows as a clean JSON array (column names de-bracketed).
    public async Task<string> RunDaxJsonAsync(string dax)
    {
        var rows = await ExecuteQueryAsync(dax);
        return JsonSerializer.Serialize(rows, JsonOpts);
    }

    public async Task<string> ListTablesJsonAsync()
    {
        var rows = await ExecuteQueryAsync("EVALUATE INFO.VIEW.TABLES()");
        var filtered = rows
            .Where(r => r.TryGetValue("Name", out var n) && n is string name
                        && !name.StartsWith("LocalDateTable_", StringComparison.OrdinalIgnoreCase)
                        && !name.StartsWith("DateTableTemplate_", StringComparison.OrdinalIgnoreCase))
            .Select(r => new Dictionary<string, object?>
            {
                ["Name"] = r.GetValueOrDefault("Name"),
                ["Description"] = r.GetValueOrDefault("Description"),
                ["IsHidden"] = r.GetValueOrDefault("IsHidden"),
            })
            .OrderBy(r => r["Name"] as string, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return JsonSerializer.Serialize(filtered, JsonOpts);
    }

    // executeQueries cannot return measure DAX expressions (INFO.MEASURES is
    // blocked and INFO.VIEW.MEASURES returns a null Expression). We return the
    // name, home table, and description; read the .tmdl files in this repo for
    // the actual DAX of each measure.
    public async Task<string> ListMeasuresJsonAsync()
    {
        var rows = await ExecuteQueryAsync("EVALUATE INFO.VIEW.MEASURES()");
        var projected = rows
            .Select(r => new Dictionary<string, object?>
            {
                ["Name"] = r.GetValueOrDefault("Name"),
                ["Table"] = r.GetValueOrDefault("Table"),
                ["Description"] = r.GetValueOrDefault("Description"),
                ["IsHidden"] = r.GetValueOrDefault("IsHidden"),
            })
            .OrderBy(r => r["Table"] as string, StringComparer.OrdinalIgnoreCase)
            .ThenBy(r => r["Name"] as string, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return JsonSerializer.Serialize(projected, JsonOpts);
    }

    private async Task<List<Dictionary<string, object?>>> ExecuteQueryAsync(string dax)
    {
        var token = await GetTokenAsync(allowInteractive: true);
        var url = $"https://api.powerbi.com/v1.0/myorg/groups/{_groupId}/datasets/{_datasetId}/executeQueries";
        var body = JsonSerializer.Serialize(new
        {
            queries = new[] { new { query = dax } },
            serializerSettings = new { includeNulls = true }
        });

        using var req = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);

        using var resp = await Http.SendAsync(req);
        var text = await resp.Content.ReadAsStringAsync();
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"Power BI executeQueries failed (HTTP {(int)resp.StatusCode}): {text}");

        return ParseRows(text);
    }

    // executeQueries returns { results: [ { tables: [ { rows: [ {col:val} ] } ] } ] }.
    // Flatten to the first result's first table's rows and strip the surrounding
    // [Brackets] Power BI puts around column names for readability.
    private static List<Dictionary<string, object?>> ParseRows(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var rows = new List<Dictionary<string, object?>>();

        var tableRows = doc.RootElement
            .GetProperty("results")[0]
            .GetProperty("tables")[0]
            .GetProperty("rows");

        foreach (var rowEl in tableRows.EnumerateArray())
        {
            var row = new Dictionary<string, object?>();
            foreach (var prop in rowEl.EnumerateObject())
                row[CleanColumn(prop.Name)] = JsonValue(prop.Value);
            rows.Add(row);
        }
        return rows;
    }

    private static string CleanColumn(string name) =>
        name.Length > 1 && name[0] == '[' && name[^1] == ']' && name.IndexOf('[', 1) < 0
            ? name[1..^1]
            : name;

    private static object? JsonValue(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.Null => null,
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Number => el.TryGetInt64(out var l) ? l : el.GetDouble(),
        JsonValueKind.String => el.GetString(),
        _ => el.ToString()
    };

    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };
}
