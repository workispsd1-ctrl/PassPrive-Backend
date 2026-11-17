"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, "../.env") });
const supabase_1 = __importDefault(require("../src/database/supabase"));
const embeddingService_1 = require("../src/modules/services/embeddingService");
async function main() {
    console.log("=== PassPrivé AI Dining Concierge: Vector Embedding Sync ===");
    const { count: pendingCount, error } = await supabase_1.default
        .from("embedding_jobs")
        .select("*", { count: "exact", head: true });
    if (error) {
        console.error("Error querying embedding_jobs queue:", error.message);
        process.exit(1);
    }
    console.log(`Found ${pendingCount || 0} venue(s) pending embedding update.`);
    if (!pendingCount || pendingCount === 0) {
        console.log("All restaurant vector embeddings are up to date! ✨");
        process.exit(0);
    }
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    while (true) {
        const batch = await (0, embeddingService_1.processAllPendingEmbeddingJobs)(10);
        if (batch.processed === 0)
            break;
        totalProcessed += batch.processed;
        totalUpdated += batch.updated;
        totalSkipped += batch.skipped;
        totalErrors += batch.errors;
        console.log(`Batch complete: ${batch.processed} processed (${batch.updated} updated, ${batch.skipped} skipped unchanged, ${batch.errors} errors). Total so far: ${totalProcessed}`);
    }
    console.log("\n=== Sync Finished ===");
    console.log(`Total venues processed: ${totalProcessed}`);
    console.log(`Updated vectors: ${totalUpdated}`);
    console.log(`Skipped (identical hash): ${totalSkipped}`);
    console.log(`Errors: ${totalErrors}`);
}
main().catch((err) => {
    console.error("Fatal error during embedding sync:", err);
    process.exit(1);
});
