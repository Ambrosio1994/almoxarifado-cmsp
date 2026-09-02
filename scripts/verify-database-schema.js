import { safeSchemaVerificationError, verifyDatabaseSchema } from "../src/db/schema-verifier.js";

try {
  const report = await verifyDatabaseSchema();
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ event: "database_schema_verification_failed", message: safeSchemaVerificationError(error) }));
  process.exitCode = 1;
}
