/**
 * The app page frame, in one import: `<AppPage measure="reading|wide|full">`
 * plus `<AppPageHeader>`. The frame itself lives in `components/ui/app-page.tsx`
 * (a primitive with no app dependencies); the header lives beside this file.
 * Pages import both from here.
 */
export { AppPage, type AppPageMeasure, type AppPageProps } from "@/components/ui/app-page";
export { AppPageHeader } from "@/components/app/app-page-header";
