"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, Download, Search } from "lucide-react";
import type { StructuredDataFrame } from "@/lib/sandbox/python";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface DataTableBlockProps {
  table: StructuredDataFrame;
  title?: string;
}

/**
 * A dataframe returned by the Python sandbox.
 *
 * Generated output belongs to the conversation, so it now uses the same card,
 * field, button and semantic-colour vocabulary as the rest of Chat instead of a
 * private white/neutral/coral micro-theme. The table itself stays dense and
 * monospaced where the content is data; the surrounding controls remain normal
 * UI typography.
 */
export function DataTableBlock({ table, title }: DataTableBlockProps) {
  const [searchQuery, setSearchQuery] = React.useState("");
  const [currentPage, setCurrentPage] = React.useState(1);
  const pageSize = 10;

  const filteredData = React.useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return table.data;
    return table.data.filter((row) =>
      Object.values(row).some((value) => String(value).toLowerCase().includes(query))
    );
  }, [table.data, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredData.length / pageSize));
  const paginatedData = React.useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredData.slice(start, start + pageSize);
  }, [filteredData, currentPage]);

  React.useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const handleExportCsv = () => {
    if (!table.columns.length || !table.data.length) return;
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const lines = [
      table.columns.map(escape).join(","),
      ...table.data.map((row) => table.columns.map((column) => escape(row[column])).join(",")),
    ];
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(title || "data_table").replace(/\s+/g, "_")}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="my-3 overflow-hidden rounded-card border border-border/60 bg-card shadow-soft">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/35 px-4 py-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h4 className="truncate text-xs font-medium text-foreground">{title || "Data table"}</h4>
          <span className="shrink-0 font-mono text-micro text-muted-foreground">
            {table.rowCount.toLocaleString()} × {table.columnCount}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              placeholder="Filter rows"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-8 w-32 pl-8 text-xs sm:w-40"
              aria-label="Filter data table rows"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={!table.columns.length || !table.data.length}
            className="h-8 gap-1.5 px-2.5"
          >
            <Download className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">CSV</span>
          </Button>
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="border-b border-border/60 bg-muted/45 text-muted-foreground">
            <tr>
              {table.columns.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="whitespace-nowrap px-3 py-2 font-medium text-foreground/80"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/45 font-mono text-caption text-foreground">
            {paginatedData.map((row, index) => (
              <tr key={index} className="transition-colors hover:bg-accent/35 motion-reduce:transition-none">
                {table.columns.map((column) => (
                  <td
                    key={column}
                    className="max-w-xs truncate whitespace-nowrap px-3 py-2"
                    title={String(row[column] ?? "")}
                  >
                    {String(row[column] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
            {paginatedData.length === 0 && (
              <tr>
                <td
                  colSpan={Math.max(1, table.columns.length)}
                  className="px-3 py-8 text-center font-sans text-xs text-muted-foreground"
                >
                  No matching rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <footer className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/25 px-4 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            Page {currentPage} of {totalPages} · {filteredData.length.toLocaleString()} rows
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
              aria-label="Previous table page"
            >
              <ChevronLeft className="size-3.5" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
              aria-label="Next table page"
            >
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </footer>
      )}
    </section>
  );
}
