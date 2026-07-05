// Client construction + the ownership guard live in db.ts; this module keeps
// the historical `@/lib/prisma` import path working for every call site.
export { prisma, prismaUnguarded } from "@/lib/db";
