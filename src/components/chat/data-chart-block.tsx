"use client";

import React, { useState } from "react";
import { Download, Maximize2, Minimize2 } from "lucide-react";

interface DataChartBlockProps {
  chart: {
    format: "svg" | "png";
    data: string; // base64 PNG or SVG string
    title?: string;
  };
}

export function DataChartBlock({ chart }: DataChartBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const imgSrc =
    chart.format === "png"
      ? `data:image/png;base64,${chart.data}`
      : `data:image/svg+xml;utf8,${encodeURIComponent(chart.data)}`;

  const handleDownload = () => {
    const link = document.createElement("a");
    link.href = imgSrc;
    link.download = `${(chart.title || "figure").replace(/\s+/g, "_")}.${chart.format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="my-3 rounded-xl border border-neutral-200 bg-white/90 dark:border-neutral-800 dark:bg-neutral-900/90 overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/50">
        <span className="text-xs font-medium text-neutral-800 dark:text-neutral-200">
          {chart.title || "Generated Chart"}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? "Collapse" : "Expand"}
            className="p-1 rounded-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500"
          >
            {isExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={handleDownload}
            title="Download image"
            className="flex items-center gap-1 rounded-sm border border-neutral-200 bg-white px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 transition"
          >
            <Download className="h-3 w-3" />
            <span>Download</span>
          </button>
        </div>
      </div>

      {/* Chart Image */}
      <div className={`p-4 flex items-center justify-center bg-white dark:bg-neutral-950 transition-all ${isExpanded ? "max-h-[800px]" : "max-h-[420px]"}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imgSrc}
          alt={chart.title || "Data visualization"}
          className="max-h-full max-w-full object-contain rounded-sm"
        />
      </div>
    </div>
  );
}
