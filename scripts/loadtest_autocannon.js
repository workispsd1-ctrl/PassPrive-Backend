const autocannon = require("autocannon");

// Parse command line arguments
function parseArgs(argv) {
  const args = {
    base: "http://127.0.0.1:8000",
    restaurantId: "",
    token: "",
    bypass: "",
    duration: 15,
    connections: 50,
    pipelining: 10,
    amount: 15000, // Total requests to try to reach (e.g. 15000 / 15s = ~1000 RPS target)
  };

  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (!next) continue;

    if (key === "--base") args.base = next;
    if (key === "--restaurant") args.restaurantId = next;
    if (key === "--token") args.token = next;
    if (key === "--bypass") args.bypass = next;
    if (key === "--duration") args.duration = Number(next);
    if (key === "--connections") args.connections = Number(next);
    if (key === "--pipelining") args.pipelining = Number(next);
    if (key === "--amount") args.amount = Number(next);
  }

  return args;
}

const config = parseArgs(process.argv);

if (!config.restaurantId) {
  console.error("Error: Please specify an active restaurant UUID using --restaurant <UUID>");
  process.exit(1);
}

// Helpers for payload randomization to bypass duplicate checks
function getRandomDate() {
  const day = Math.floor(Math.random() * 28) + 1;
  const dayStr = String(day).padStart(2, "0");
  return `2026-07-${dayStr}`;
}

function getRandomTime() {
  const hour = Math.floor(Math.random() * 4) + 18; // 18:00 to 21:00
  const minute = Math.random() < 0.5 ? "00" : "30";
  return `${hour}:${minute}`;
}

const headers = {
  "content-type": "application/json",
};

if (config.token) {
  headers["authorization"] = `Bearer ${config.token}`;
}
if (config.bypass) {
  headers["x-bypass-auth"] = config.bypass;
}

console.log(`Starting autocannon load test...`);
console.log(`Target: ${config.base}/api/restaurant-bookings/confirm`);
console.log(`Duration: ${config.duration}s | Connections: ${config.connections} | Pipelining: ${config.pipelining}`);
if (config.token) console.log("Using Authorization token header.");
if (config.bypass) console.log(`Using x-bypass-auth header: "${config.bypass}"`);

const instance = autocannon(
  {
    url: config.base,
    connections: config.connections,
    pipelining: config.pipelining,
    duration: config.duration,
    amount: config.amount,
    requests: [
      {
        method: "POST",
        path: "/api/restaurant-bookings/confirm",
        headers,
        setupRequest: (request) => {
          request.body = JSON.stringify({
            restaurant: config.restaurantId,
            guests: Math.floor(Math.random() * 4) + 1,
            selectedDate: getRandomDate(),
            selectedTime: getRandomTime(),
            option: {
              type: "regular table reservation",
            },
            notes: `Autocannon test ${Math.random()}`,
          });
          return request;
        },
      },
    ],
  },
  (err, result) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log("\n=== Load Test Results ===");
    console.log(`Requests/sec (Avg): ${result.requests.average}`);
    console.log(`Throughput/sec (Avg): ${(result.throughput.average / 1024).toFixed(2)} KB/s`);
    console.log(`Latency (p50): ${result.latency.p50} ms`);
    console.log(`Latency (p95): ${result.latency.p95} ms`);
    console.log(`Latency (p99): ${result.latency.p99} ms`);
    console.log(`Total Requests: ${result.requests.sent}`);
    console.log(`Errors: ${result.errors}`);
    console.log(`2xx Responses: ${result["2xx"]}`);
    console.log(`4xx Responses: ${result["4xx"]}`);
    console.log(`5xx Responses: ${result["5xx"]}`);
  }
);

autocannon.track(instance, { renderProgressBar: true });
