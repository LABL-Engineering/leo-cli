'use strict';

import { LambdaClient, GetFunctionCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient, ScanCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { Agent } from "https";
import { spawnSync } from 'child_process';
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';

process.env.AWS_DEFAULT_REGION = process.env.AWS_REGION = process.env.AWS_REGION || "us-west-2";

handler();

async function handler() {
  const event = await buildEvent();
  process.env.AWS_LAMBDA_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME || event.__cron.name;
  const FunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  const tmpDir = process.env.DIR || "/tmp";

  const lambda = new LambdaClient({
    region: process.env.AWS_REGION
  });

  try {
    const functionData = await lambda.send(new GetFunctionCommand({ FunctionName }));

    if (process.env.TIMEOUT || process.env.AWS_LAMBDA_FUNCTION_TIMEOUT) {
      functionData.Configuration.Timeout = parseInt(process.env.AWS_LAMBDA_FUNCTION_TIMEOUT || process.env.TIMEOUT);
    } else {
      functionData.Configuration.Timeout *= 10;
    }

    console.log(JSON.stringify(functionData, null, 2));

    // Set all Environment for the lambda. Should this be done on container invoke?
    Object.keys(functionData.Configuration.Environment.Variables).forEach(key => {
      process.env[key] = functionData.Configuration.Environment.Variables[key];
    });

    importModule(functionData.Code.Location, {
      main: `${functionData.Configuration.Handler.split(".")[0]}.js`,
      handler: functionData.Configuration.Handler.split(".")[1],
      lastModified: functionData.Configuration.LastModified,
      Configuration: functionData.Configuration
    }, (err, data) => {
      if (err) {
        console.log(err);
        process.exit();
      }
      const context = createContext(data.Configuration || {});
      const handler = data.module[data.handler || "handler"];

      // Assume the lambda's role
      const role = functionData.Configuration.Role;
      console.error("new role", role);

      // Calling handler with event and context
      console.error("calling handler", event, context);
      handler(event, context, (err, data) => {
        console.error("All Done", err, data);
        process.exit();
      });
    });
  } catch (err) {
    console.log(`Cannot find function: ${FunctionName}`, err);
    process.exit();
  }
}

async function importModule(url, data, callback) {
  data = Object.assign({
    main: "index.js",
    handler: "handler"
  }, data);
  const zipPath = path.resolve("", `${tmpDir}/run_${FunctionName}.zip`);
  const indexPath = path.resolve("", `${tmpDir}/run_${FunctionName}/${data.main}`);
  const folder = path.resolve("", `${tmpDir}/run_${FunctionName}`);
  let stats;

  if (fs.existsSync(zipPath) && fs.existsSync(indexPath)) {
    stats = fs.statSync(zipPath);
  }
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder);
  }
  console.log("Downloading", url);
  https.get(url, (res) => {
    res.pipe(fs.createWriteStream(zipPath)).on("finish", () => {
      console.log("Done Downloading");
      const o = spawnSync("unzip", ["-o", zipPath, "-d", folder]);
      console.log(o.stdout.toString());
      console.error(o.stderr.toString());
      console.log("Done Extracting");
      data.module = require(indexPath);
      callback(null, data);
    });
  }).on("error", (err) => {
    console.log("Error Downloading", err);
    callback(err);
  });
}

async function buildEvent() {
  if (!process.env.LEO_EVENT && (!process.env.AWS_LAMBDA_FUNCTION_NAME || !process.env.BOT) && (!process.env.LEO_CRON && !process.env.AWS_LAMBDA_FUNCTION_NAME && !process.env.BOT)) {
    console.log("(LEO_CRON and Bot) or (AWS_LAMBDA_FUNCTION_NAME and BOT) or LEO_EVENT are required as environment variables");
    process.exit();
  }

  const event = process.env.LEO_EVENT && JSON.parse(process.env.LEO_EVENT);
  if (event) {
    return event;
  }

  const docClient = new DynamoDBClient({
    region: process.env.AWS_REGION,
    maxRetries: 2,
    convertEmptyValues: true,
    httpOptions: {
      connectTimeout: 2000,
      timeout: 5000,
      agent: new Agent({
        ciphers: 'ALL',
        secureProtocol: 'TLSv1_3_method'
      })
    }
  });

  let id = process.env.BOT;
  let lambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  let entry;

  if (!id) {
    entry = await docClient.send(new ScanCommand({
      TableName: process.env.LEO_CRON,
      FilterExpression: "lambdaName = :value",
      ExpressionAttributeValues: {
        ":value": { S: lambdaName }
      }
    })).then(data => data.Items[0]);
    id = entry.id.S;
  }

  if (!lambdaName) {
    entry = await docClient.send(new GetItemCommand({
      TableName: process.env.LEO_CRON,
      Key: {
        id: { S: id }
      }
    })).then(data => data.Item);
    lambdaName = entry.lambdaName.S;
  }

  const overrides = {};
  Object.keys(process.env).forEach(k => {
    const p = k.match(/^EVENT_(.*)/);
    if (p) {
      let v = process.env[k];
      if (v.match(/^[\d.]+$/)) {
        v = parseFloat(v);
      }
      console.log("Setting Event data", p[1], v);
      overrides[p[1]] = v;
    }
  });

  return Object.assign({}, entry.lambda && entry.lambda.settings && entry.lambda.settings[0] || {}, overrides, {
    __cron: {
      id: id,
      name: lambdaName,
      ts: Date.now(),
      iid: "0",
      force: true
    },
    botId: id
  });
}

function createContext(config) {
  const start = new Date();
  const maxTime = config.Timeout ? config.Timeout * 1000 : (10 * 365 * 24 * 60 * 60 * 1000); // Default is 10 years
  return {
    awsRequestId: "requestid-local" + Date.now().toString(),
    getRemainingTimeInMillis: function () {
      const timeSpent = new Date() - start;
      return timeSpent < maxTime ? maxTime - timeSpent : 0;
    }
  };
}
