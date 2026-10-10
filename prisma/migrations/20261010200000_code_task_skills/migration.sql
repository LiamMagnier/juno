-- Skills on cloud Code runs (skills lane): the skills a task was dispatched
-- with, `[{source: "account", id, name} | {source: "project", name}]`.
-- Additive; null = none chosen (every task created before this column).

-- AlterTable
ALTER TABLE "CodeTask" ADD COLUMN "skills" JSONB;
