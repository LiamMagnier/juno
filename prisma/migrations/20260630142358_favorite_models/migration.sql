-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "favoriteModels" TEXT[] DEFAULT ARRAY[]::TEXT[];
