---
name: quarterly-summary
description: Turns a CSV of sales by region and quarter into a formatted Excel summary workbook. Use when asked for a quarterly summary, a regional sales summary, or an Excel report from sales data.
license: MIT
---

# Quarterly summary

Build the quarterly summary workbook the same way every time.

1. Read `reference/style.md` first. It says how the sheet is laid out and which number formats to use.
2. Run the build script on the attached CSV. The CSV needs the columns `region`, `quarter` and `revenue`:

   ```
   python3 /skills/quarterly-summary/scripts/build.py /work/inputs/<the csv> /work/out.xlsx
   ```

3. The script prints the totals it wrote as JSON. Report the grand total and the top region from that output, and say that `out.xlsx` is attached.

If the CSV is missing a column, say which one and stop; do not guess.
