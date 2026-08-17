"use client";

import React, { useState, useMemo } from "react";
import { Download, Search, ChevronLeft, ChevronRight } from "lucide-react";
import type { StructuredDataFrame } from "@/lib/sandbox/python";

interface DataTableBlockProps {
  table: StructuredDataFrame;
  title?: string;
}

export function DataTableBlock({ table, title }: DataTableBlockProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  const filteredData = useMemo(() => {
    if (!searchQuery.trim()) return table.data;
    const q = searchQuery.toLowerCase();
    return table.data.filter((row) =>
      Object.values(row).some((val) => String(val).toLowerCase().includes(q))
    );
  }, [table.data, searchQuery]);

  const totalPages = Math.ceil(filteredData.length / pageSize) || 1;
  const paginatedData = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredData.slice(start, start + pageSize);
  }, [filteredData, currentPage, pageSize]);

  const handleExportCsv = () => {
    if (!table.columns.length || !table.data.length) return;
    const header = table.columns.join(",");
    const rows = table.data.map((row) =>
      table.columns
        .map((col) => {
          const cell = String(row[col] ?? "").replace(/"/g, '""');
          return `"${cell}"`;
        })
        .join(",")
    );
    const csvContent = "data:text/csv;charset=utf-8," + [header, ...rows].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `${(title || "data_table").replace(/\s+/g, "_")}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="my-3 rounded-xl border border-neutral-200 bg-white/80 backdrop-blur-sm dark:border-neutral-800 dark:bg-neutral-900/80 overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/50">
        <div className="flex items-center gap-2">
          <span className="font-medium text-xs text-neutral-800 dark:text-neutral-200">
            {title || "DataFrame"}
          </span>
          <span className="text-caption text-neutral-400">
            ({table.rowCount} rows × {table.columnCount} cols)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-neutral-400" />
            <input
              type="text"
              placeholder="Filter..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="h-7 w-28 sm:w-36 rounded-md border border-neutral-200 bg-white pl-7 pr-2 text-xs text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-coral-500"
            />
          </div>
          <button
            onClick={handleExportCsv}
            title="Download CSV"
            className="flex h-7 items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700 transition"
          >
            <Download className="h-3 w-3" />
            <span className="hidden sm:inline">CSV</span>
          </button>
        </div>
      </div>

      {/* Table Content */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-100/50 dark:bg-neutral-900/50 font-medium text-neutral-600 dark:text-neutral-400">
            <tr>
              {table.columns.map((col) => (
                <th key={col} className="px-3 py-2 whitespace-nowrap">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/60 font-mono text-caption text-neutral-800 dark:text-neutral-200">
            {paginatedData.map((row, idx) => (
              <tr key={idx} className="hover:bg-neutral-50/50 dark:hover:bg-neutral-800/30">
                {table.columns.map((col) => (
                  <td key={col} className="px-3 py-1.5 whitespace-nowrap max-w-xs truncate">
                    {String(row[col] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
            {paginatedData.length === 0 && (
              <tr>
                <td colSpan={table.columns.length} className="px-3 py-4 text-center text-neutral-400">
                  No matching rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-neutral-200 dark:border-neutral-800 text-xs text-neutral-500">
          <span>
            Page {currentPage} of {totalPages} ({filteredData.length} records)
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              className="p-1 rounded-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              className="p-1 rounded-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
