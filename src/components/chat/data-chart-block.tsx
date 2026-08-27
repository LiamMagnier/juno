"use client";

import * as React from "react";
import { Download, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DataChartBlockProps {
  chart: {
    format: "svg" | "png";
    data: string;
    title?: string;
  };
}

/** A generated visualization, kept visually inside the conversation instead of
 * switching to a private white/neutral chart chrome. */
export function DataChartBlock({ chart }: DataChartBlockProps) {
  const [isExpanded, setIsExpanded] = React.useState(false);

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
    link.remove();
  };

  return (
    <figure className="my-3 overflow-hidden rounded-card border border-border/60 bg-card shadow-soft">
      <figcaption className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/35 px-4 py-2.5">
        <span className="min-w-0 truncate text-xs font-medium text-foreground">
          {chart.title || "Generated chart"}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setIsExpanded((expanded) => !expanded)}
            aria-label={isExpanded ? "Collapse chart" : "Expand chart"}
          >
            {isExpanded ? (
              <Minimize2 className="size-3.5" aria-hidden="true" />
            ) : (
              <Maximize2 className="size-3.5" aria-hidden="true" />
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDownload}
            className="h-8 gap-1.5 px-2.5"
          >
            <Download className="size-3.5" aria-hidden="true" />
            Download
          </Button>
        </div>
      </figcaption>

      <div
        className={cn(
          "flex items-center justify-center overflow-auto bg-background/70 p-4 transition-[max-height] duration-base ease-out-soft motion-reduce:transition-none",
          isExpanded ? "max-h-[800px]" : "max-h-[420px]"
        )}
      >
        {/* Generated data URIs are not compatible with next/image optimization. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imgSrc}
          alt={chart.title || "Data visualization"}
          className="max-h-full max-w-full rounded-control object-contain"
        />
      </div>
    </figure>
  );
}
