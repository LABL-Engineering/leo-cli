'use strict';

const { S3Client, STSClient, SharedIniFileCredentials } = require("@aws-sdk/client-s3");
const { fromIni } = require("@aws-sdk/credential-provider-ini");
const fs = require("fs");
const ini = require('ini');
const execSync = require("child_process").execSync;
const path = require("path");

module.exports = function (profile) {
	let credentials;
	if (profile) {
		let home = process.env.HOME || process.env.HOMEPATH;
		let configFile = path.normalize(`${home}/.aws/config`);

		if (fs.existsSync(configFile)) {
			let config = ini.parse(fs.readFileSync(configFile, 'utf-8'));
			let p = config[`profile ${profile}`];
			if (p && p.mfa_serial) {
				p.role_arn = p.role_arn || "";
				let cacheFile = `${home}/.aws/cli/cache/${profile}--${p.role_arn.replace(/:/g, '_').replace(/[^A-Za-z0-9\-_]/g, '-')}.json`;
				let data = {};
				try {
					data = JSON.parse(fs.readFileSync(cacheFile));
				} catch (e) {
					// Ignore error, Referesh Credentials
					data = {};
				} finally {
					console.log("Using cached AWS credentials", profile);
					if (!data.Credentials || new Date() >= new Date(data.Credentials.Expiration)) {
						execSync(`aws sts get-caller-identity --duration-seconds 28800 --profile ${profile}`);
						data = JSON.parse(fs.readFileSync(cacheFile));
					}
				}
				credentials = fromIni({ profile, data });
			} else {
				console.log("Switching AWS Profile", profile);
				credentials = fromIni({ profile });
			}
		} else {
			console.log("Switching AWS Profile", profile);
			credentials = fromIni({ profile });
		}
	}

	return credentials;
};
