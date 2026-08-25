ALTER TABLE "files" RENAME COLUMN "office_code" TO "workspace_name";
ALTER TABLE "files" ALTER COLUMN "workspace_name" DROP DEFAULT;