/**
 * Simple HTTP test workflow
 */

import {
  CronCapability,
  HTTPClient,
  handler,
  Runner,
  type Runtime,
} from "@chainlink/cre-sdk";

type Config = {
  schedule: string;
  testUrl: string;
};

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const config = runtime.config();
  runtime.log("Starting HTTP test...");
  runtime.log(`URL: ${config.testUrl}`);

  const http = new HTTPClient();

  runtime.log("Creating request...");

  const response = http.sendRequest(runtime, {
    url: config.testUrl,
    method: "GET",
  }).result();

  runtime.log(`Status: ${response.statusCode}`);

  return `Done: ${response.statusCode}`;
};

const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
