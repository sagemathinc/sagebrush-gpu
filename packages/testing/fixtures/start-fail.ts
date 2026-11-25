// (worker.test.ts runs this in a child process: a start that fails on a bad migration must leave nothing running)
import { startWorker } from "../src/worker.ts";

try {
  await startWorker({ entry: "packages/testing/fixtures/entry.ts", durableObjects: { COUNTER: "Counter" }, d1Databases: ["DB"], migrations: { DB: ["packages/testing/fixtures/bad-migrations"] } });
  console.log("started");
} catch {
  console.log("rejected");
}
