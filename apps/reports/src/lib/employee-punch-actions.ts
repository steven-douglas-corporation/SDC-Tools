"use server";

import { assertActionPermission } from "@/lib/require-permission";
import { isValidMonth } from "@/lib/etc";
import { getEmployeeMonthPunches, type EmployeeMonthPunches } from "@/lib/employee-punch-drill";

// The Department Utilization employee drill, fetched when a row is clicked.
// On-demand for the same reason every other drill in this app is: nobody opens
// 51 of them, and shipping every employee's punch list with the Dashboard would
// be thousands of rows crossing the wire for the one somebody looks at.

export async function loadEmployeeMonthPunches(employeeId: string, month: string): Promise<EmployeeMonthPunches> {
  // A server action is a public endpoint, not a private function the page calls.
  await assertActionPermission("dashboard:view");

  // Both arguments arrive from the client and are therefore untrusted, even
  // though our own UI only ever sends values it read off the table.
  if (typeof employeeId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(employeeId)) {
    throw new Error("Invalid employee id.");
  }
  if (typeof month !== "string" || !isValidMonth(month)) {
    throw new Error("Invalid month.");
  }
  return getEmployeeMonthPunches(employeeId, month);
}
