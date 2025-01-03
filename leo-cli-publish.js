#!/usr/bin/env node

const path = require('path');
const { Command } = require('commander');
const program = new Command();

program
	.version('0.0.1')
	.option("-e, --env [env]", "Environment")
	.option("--build", "Only build")
	.option("--tag [tag]", "Tag name")
	.option("--changeset", "Only build changeset")
	.option("-c --cloudformation", "Only build cloudformation")
	.option("-d, --deploy [env]", "Deploys the published cloudformation")
	.option("-f, --force [force]", "Force bots to publish")
	.option("--filter [filter]", "Filter bots to publish")
	.option("--public [public]", "Publish as public")
	.option("-s --save [save]", "Save the cloudformation.json to the microservice directory")
	.option('-F --force-deploy', 'Automatically deploy without requesting verification of changeset')
	.option("-p --patch [env]", "Patch from existing environment's deployed cloudformation.")
	.option("-m --merge", "Merge build from existing environment's deployed cloudformation.")
	.arguments('[directory] [options]')
	.usage('[directory] [options]');

const progressInterval = {
	interval: undefined,
	start: () => {
		this.interval = setInterval(() => {
			process.stdout.write(".");
		}, 2000);
	},
	stop: () => {
		clearInterval(this.interval);
	}
};

(async function run() {
	program.parse(process.argv);
	let [dir] = program.args;
	let rootDir;
	if (!dir) {
		rootDir = process.cwd();
	} else {
		rootDir = path.resolve(process.cwd(), dir);
	}

	const options = program.opts();
	// console.log("[opts[", options)

	// if using just '-d' then set the deploy to 'dev'
	if (options.env === true || options.deploy === true) {
		delete options.env;
		options.deploy = "dev";
	}

	let env = options.env || options.deploy || "dev";
	options.run = options.run || options.deploy;
	let filter = options.filter;
	let force = options.force;

	process.env.NODE_ENV = process.env.LEO_ENV = env;
	process.env.LEO_REGION = options.region;
	process.env.NODE_ENV = process.env.NODE_ENV || 'development'

	let config = require("./leoCliConfigure.js")(process.env.NODE_ENV);
	let buildConfig = require("./lib/build-config").build;
	let pkgConfig = buildConfig(rootDir);
	console.log("BUILDING ", rootDir);

	if (pkgConfig.type !== "microservice" && pkgConfig._meta.microserviceDir) {
		filter = rootDir.replace(/^.*?[\\/](bots|api)[\\/]/, "");
		force = filter;
		rootDir = pkgConfig._meta.microserviceDir;
		pkgConfig = buildConfig(rootDir);
	}

	let publishConfig = config.publish;
	if (!publishConfig) {
		console.log("YOU HAVE NOT SETUP YOUR LEOPUBLISH");
		process.exit();
	}
	// console.log("[publishConfig]", publishConfig);

	let startingCloudformation = undefined;
	if (options.patch) {
		if (options.patch === true) {
			options.patch = env;
		}
		if (options.patch == undefined) {
			console.log("--patch requires a value or --deploy to be set");
			process.exit();
		}
		let patch = config.deploy[process.env.NODE_ENV];
		if (patch == undefined) {
			console.log(`Environment ${process.env.NODE_ENV} is not configured.  Cannot create patch.`);
			process.exit();
		}
		let deployRegions = patch.region || [];
		let target = config.publish.filter(p => (deployRegions.length == 0 || (p.region && deployRegions.indexOf(p.region) > -1) ||
			(p.leoaws && p.leoaws.region && deployRegions.indexOf(p.leoaws.region) > -1)
		))[0];

		if (target == undefined) {
			console.log(`Cannot determine base cloudformation from ${process.env.NODE_ENV}.  Cannot create patch.`);
			process.exit();
		}

		try {
			startingCloudformation = await require("leo-aws")(target.leoaws).cloudformation.get(patch.stack, {});
		} catch (err) {
			console.log(`Error getting base cloudformation from ${process.env.NODE_ENV}.  Cannot create patch.`);
			console.log(err);
			process.exit();
		}
	}
	let mergeBase = [];
	if (options.merge) {
		config.publish.map(target => {
			Object.keys(config.deploy || {}).map(deployEnv => {
				let deployConfig = config.deploy[deployEnv];
				let deployRegions = deployConfig.region || [];
				if (!Array.isArray(deployRegions)) {
					deployRegions = [deployRegions];
				}
				if (deployRegions.length == 0 || deployRegions.indexOf(target.leoaws.region) >= 0) {
					mergeBase.push(require("leo-aws")(target.leoaws).cloudformation.get(deployConfig.stack, {}).then(template => {
						return {
							name: `${deployConfig.stack}-${target.leoaws.region}.patch`,
							template: template
						}
					}).catch(err => console.log(err)));

				}
			})
		})
	}
	mergeBase = (await Promise.all(mergeBase)).filter(cf => !!cf);

	try {
		let cf = require("./lib/cloud-formation.js")
		
		let data = await cf.createCloudFormation(rootDir, {
			linkedStacks: config.linkedStacks,
			config: pkgConfig,
			force: force,
			targets: publishConfig,
			filter: filter,
			alias: process.env.NODE_ENV,
			publish: options.run || !options.build,
			tag: options.tag,
			public: options.public || false,
			cloudFormationOnly: options.cloudformation || false,
			saveCloudFormation: options.save || false ,
			cloudformation: startingCloudformation,
			variations: mergeBase
		});

		if (options.run || !options.build) {
			console.log("\n---------------Publish Complete---------------");
			data.forEach(publish => {
				console.log(publish.url + `cloudformation${publish.version ? ("-" + publish.version) : ""}.json`);
			});
		} else {
			console.log("\n---------------Build Complete---------------");
		}
		if (!options.run) {
			// Nothing more to do
			process.exit();
		} else {
			let tasks = [];
			let devConfig = config.deploy[process.env.NODE_ENV];
			let deployRegions = devConfig.region || [];
			if (!Array.isArray(deployRegions)) {
				deployRegions = [deployRegions];
			}
			let deployErrors = 0;
			data.filter(p => deployRegions.length == 0 || deployRegions.indexOf(p.region) >= 0).map(publish => {
				if (publish == undefined) {
					console.log(`\n---------------"${process.env.NODE_ENV} ${devConfig.stack} ${publish.region}"---------------`);
					return;
				}

				let url = publish.url + "cloudformation.json";
				console.time("Update Complete");
				console.log(`\n---------------Creating Stack ChangeSet "${process.env.NODE_ENV} ${devConfig.stack} ${publish.region}"---------------`);
				console.log(`url: ${url}`);
				progressInterval.start();

				let Parameters = [].concat(Object.keys(devConfig.parameters || {}).map(key => {
					let value = devConfig.parameters[key];
					let noEcho = false;
					if (typeof value.NoEcho !== 'undefined') {
						noEcho = value.NoEcho;
						value = value.value;
					}
					return {
						ParameterKey: key,
						ParameterValue: value,
						NoEcho: noEcho
					};
				}));
				if (pkgConfig.no_env_param !== true) {
					Parameters.push({
						ParameterKey: 'Environment',
						ParameterValue: process.env.NODE_ENV
					});
				}

				tasks.push(publish.target.leoaws.cloudformation.runChangeSet(
					devConfig.stack, 
					url, 
					{
						Parameters: Parameters
					}, {
						forceDeploy: options.forceDeploy,
						progressInterval: progressInterval
				}).then(() => {
					console.log("");
					console.timeEnd("Update Complete");
				}).catch(err => {
					console.log(` Update Error: ${publish.region}`, err);
					deployErrors++;
				}));
			});
			Promise.all(tasks).then(() => {
				if (deployErrors > 0) {
					throw new Error(`Deployment errors, see log for details.`, deployErrors);
				}
				progressInterval.stop();
				tasks.length > 0 && console.log("Ran all deployments");
				process.exit();
			}).catch((err) => {
				progressInterval.stop();
				tasks.length > 0 && console.log("Failed on deployments", err);
				process.exit(1);
			});
		}
	} catch (err) {
		console.log(err);
		process.exit(1);
	}
})();
