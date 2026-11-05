/**
 * Ledger helpers for the Meridian invoices (benchmark fixture: contains known bugs).
 * Rows look like { id: "I01", status: "paid" | "unpaid" | "cancelled", amount: "125.50" }.
 */

/** Total of paid invoices in EUR. */
export function paidTotal(rows) {
  return rows.reduce((sum, row) => sum + Number(row.amount), 0);
}

/** Split rows into pages of `size`. */
export function paginate(rows, size) {
  const pages = [];
  for (let i = 0; i <= rows.length; i += size) pages.push(rows.slice(i, i + size));
  return pages;
}
