import ExcelJS from "exceljs";
import fs from "fs";

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("D:\\AI Projects\\sdc-etc-planner\\scripts\\archive\\1116 Molex as of 7.31.26.xlsx");
  for (const ws of wb.worksheets) {
    const out: string[] = [];
    out.push(`=== Sheet: ${ws.name} (${ws.rowCount} rows x ${ws.columnCount} cols) ===`);
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const vals: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const cell = row.getCell(c);
        let v = cell.value;
        if (v && typeof v === "object" && "result" in (v as object)) v = (v as { result: unknown }).result as never;
        if (v && typeof v === "object" && "text" in (v as object)) v = (v as { text: unknown }).text as never;
        vals.push(v == null ? "" : String(v));
      }
      out.push(`${r}\t${vals.join("\t")}`);
    }
    fs.writeFileSync(`D:\\AI Projects\\sdc-etc-planner\\scripts\\archive\\_1116_dump_${ws.name.replace(/[^a-z0-9]/gi, "_")}.tsv`, out.join("\n"));
    console.log(`wrote ${out.length} lines for sheet ${ws.name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
