import * as swarmUtils from './swarm-utils';
import * as utils from './utils';
import configValidator, { showDepreciations, showErrors } from './validate/index';
import { hooks, runRemoteHooks } from './hooks';
import chalk from 'chalk';
import childProcess from 'child_process';
import { commands } from './commands';
import debug from 'debug';
import fs from 'fs';
import { getOptions } from './swarm-options';
import nodemiral from 'nodemiral';
import parseJson from 'parse-json';
import path from 'path';
import { runConfigPreps } from './prepare-config';
import { scrubConfig } from './scrub-config';
import serverInfo from './server-info';

const { resolvePath } = utils;
const log = debug('mup:api');

export default class PluginAPI {
  constructor(base, filteredArgs, program) {
    this.base = program.config ? path.dirname(program.config) : base;
    this.args = filteredArgs;
    this.config = null;
    this.settings = null;
    this.sessions = null;
    this._enabledSessions = program.servers ? program.servers.split(',') : [];
    this.configPath = program.config ? resolvePath(program.config) : path.join(this.base, 'mup.js');
    this.settingsPath = program.settings;
    this.verbose = program.verbose;
    this.program = program;
    this.commandHistory = [];

    this.validationErrors = [];

    this.resolvePath = utils.resolvePath;
    this.runTaskList = utils.runTaskList;
    this.getDockerLogs = utils.getDockerLogs;
    this.runSSHCommand = utils.runSSHCommand;
    this._createSSHOptions = utils.createSSHOptions;
  }

  getArgs() {
    return this.args;
  }

  getBasePath() {
    return this.base;
  }

  getVerbose() {
    return this.verbose;
  }

  getOptions() {
    return this.program;
  }

  hasMeteorPackage(name) {
    // Check if app is using the package
    try {
      const contents = fs
        .readFileSync(resolvePath(this.getBasePath(), this.getConfig().meteor.path, '.meteor/versions'))
        .toString();
      // Looks for "package-name@" in the beginning of a
      // line or at the start of the file
      const regex = new RegExp(`(^|\\s)${name}@`, 'm');

      return regex.test(contents);
    } catch (e) {
      console.log(`Unable to load file ${resolvePath(this.getBasePath(), this.getConfig().meteor.path, '.meteor/versions')}`);

      return false;
    }
  }

  validateConfig(configPath) {
    // Only print errors once.
    if (this.validationErrors.length > 0) {
      return this.validationErrors;
    }

    const { errors, depreciations } = configValidator(this.getConfig());
    const problems = [...errors, ...depreciations];

    if (problems.length > 0) {
      console.log(`loaded config from ${configPath}`);
      console.log('');

      if (errors.length) {
        showErrors(errors);
      }

      if (depreciations.length) {
        showDepreciations(depreciations);
      }

      console.log(
        'Read the docs and view example configs at'
      );
      console.log('    http://meteor-up.com/docs');
      console.log('');
    }

    this.validationErrors = problems;

    return problems;
  }
  _normalizeConfig(config) {
    if (typeof config !== 'object') {
      return config;
    }
    if (config.meteor && typeof config.app !== 'object') {
      config.app = Object.assign({}, config.meteor);
      config.app.type = 'meteor';
    } else if (typeof config.app === 'object' && !('type' in config.app)) {
      config.app.type = 'meteor';
    }

    return runConfigPreps(config);
  }
  getConfig(validate = true) {
    if (!this.config) {
      try {
        delete require.cache[require.resolve(this.configPath)];
        // eslint-disable-next-line global-require
        this.config = require(this.configPath);
      } catch (e) {
        if (!validate) {
          return {};
        }
        if (e.code === 'MODULE_NOT_FOUND') {
          console.error('"mup.js" file not found at');
          console.error(`  ${this.configPath}`);
          console.error('Run "mup init" to create it.');
        } else {
          console.error(e);
        }
        process.exit(1);
      }
      this.config = this._normalizeConfig(this.config);

      if (validate) {
        this.validateConfig(this.configPath);
      }
    }

    return this.config;
  }

  scrubConfig() {
    const config = this.getConfig();

    return scrubConfig(config);
  }

  getSettings() {
    if (!this.settings) {
      let filePath;
      if (this.settingsPath) {
        filePath = resolvePath(this.settingsPath);
      } else {
        filePath = path.join(this.base, 'settings.json');
      }

      try {
        this.settings = fs.readFileSync(filePath).toString();
      } catch (e) {
        console.log(`Unable to load settings.json at ${filePath}`);
        if (e.code !== 'ENOENT') {
          console.log(e);
        } else {
          [
            'It does not exist.',
            '',
            'You can create the file with "mup init" or add the option',
            '"--settings path/to/settings.json" to load it from a',
            'different location.'
          ].forEach(text => console.log(text));
        }
        process.exit(1);
      }
      try {
        this.settings = parseJson(this.settings);
      } catch (e) {
        console.log('Error parsing settings file:');
        console.log(e.message);

        process.exit(1);
      }
    }

    return this.settings;
  }

  setConfig(newConfig) {
    this.config = newConfig;
  }

  _runHookScript(script) {
    try {
      childProcess.execSync(script, {
        cwd: this.getBasePath(),
        stdio: 'inherit'
      });
    } catch (e) {
      // do nothing
    }
  }
  _runHooks = async function(handlers, hookName) {
    const messagePrefix = `> Running hook ${hookName}`;
    for (const hookHandler of handlers) {
      if (hookHandler.localCommand) {
        console.log(`${messagePrefix} "${hookHandler.localCommand}"`);
        this._runHookScript(hookHandler.localCommand);
      }
      if (typeof hookHandler.method === 'function') {
        try {
          await hookHandler.method(this, nodemiral);
        } catch (e) {
          this._commandErrorHandler(e);
        }
      }
      if (hookHandler.remoteCommand) {
        console.log(
          `${messagePrefix} remote command "${hookHandler.remoteCommand}"`
        );
        await runRemoteHooks(
          this.getConfig().servers,
          hookHandler.remoteCommand
        );
      }
    }
  }
  _runPreHooks = async function(name) {
    const hookName = `pre.${name}`;

    if (this.program['show-hook-names']) {
      console.log(chalk.yellow(`Hook: ${hookName}`));
    }

    if (hookName in hooks) {
      const hookList = hooks[hookName];
      await this._runHooks(hookList, name);
    }
  };
  _runPostHooks = async function(commandName) {
    const hookName = `post.${commandName}`;

    if (this.program['show-hook-names']) {
      console.log(chalk.yellow(`Hook: ${hookName}`));
    }

    if (hookName in hooks) {
      const hookList = hooks[hookName];
      await this._runHooks(hookList, hookName);
    }
  };
  _commandErrorHandler(e) {
    log('_commandErrorHandler');
    process.exitCode = 1;

    // Only show error when not from nodemiral
    // since nodemiral would have already shown the error
    if (!(e.nodemiralHistory instanceof Array)) {
      log('_commandErrorHandler: nodemiral error');
      console.error(e.stack || e);
    }

    if (e.solution) {
      console.log(chalk.yellow(e.solution));
    }

    process.exit(1);
  }
  runCommand = async function(name) {
    if (!name) {
      throw new Error('Command name is required');
    }

    if (!(name in commands)) {
      throw new Error(`Unknown command name: ${name}`);
    }

    this.commandHistory.push({ name });

    await this._runPreHooks(name);
    let potentialPromise;
    try {
      log('Running command', name);
      potentialPromise = commands[name].handler(this, nodemiral);
    } catch (e) {
      this._commandErrorHandler(e);
    }

    if (potentialPromise && typeof potentialPromise.then === 'function') {
      return potentialPromise
        .then(() => this._runPostHooks(name));
    }

    return await this._runPostHooks(name);
  }

  async getServerInfo(selectedServers, collectors) {
    if (this._cachedServerInfo && !collectors) {
      return this._cachedServerInfo;
    }

    const servers = selectedServers ||
      Object.values(this.getConfig().servers);

    if (!collectors) {
      console.log('=> Collecting Docker information');
    }

    const result = await serverInfo(servers, collectors);
    if (!collectors) {
      this._cachedServerInfo = result;
    }

    return result;
  }

  serverInfoStale() {
    this._cachedServerInfo = null;
  }

  getSessions(modules = []) {
    const sessions = this._pickSessions(modules);

    return Object.keys(sessions).map(name => sessions[name]);
  }

  getSessionsForServers(servers = []) {
    if (!this.sessions) {
      this._loadSessions();
    }

    return servers.map(name => this.sessions[name]);
  }

  async getManagerSession() {
    const managers = await this.currentSwarmManagers();

    return this.getSessionsForServers(managers)[0];
  }

  _pickSessions(plugins = []) {
    if (!this.sessions) {
      this._loadSessions();
    }

    const sessions = {};

    plugins.forEach(moduleName => {
      const moduleConfig = this.getConfig()[moduleName];
      if (!moduleConfig) {
        return;
      }

      for (const name in moduleConfig.servers) {
        if (!moduleConfig.servers.hasOwnProperty(name)) {
          continue;
        }

        if (this.sessions[name]) {
          sessions[name] = this.sessions[name];
        }
      }
    });

    return sessions;
  }

  _loadSessions() {
    const config = this.getConfig();
    this.sessions = {};

    // `mup.servers` contains login information for servers
    // Use this information to create nodemiral sessions.
    for (const name in config.servers) {
      if (!config.servers.hasOwnProperty(name)) {
        continue;
      }

      if (
        this._enabledSessions.length > 0 &&
        this._enabledSessions.indexOf(name) === -1
      ) {
        continue;
      }

      const info = config.servers[name];
      const auth = {
        username: info.username
      };
      const opts = {
        ssh: {}
      };

      const sshAgent = process.env.SSH_AUTH_SOCK;

      if (info.opts) {
        opts.ssh = info.opts;
      }

      opts.ssh.keepaliveInterval = 1000 * 28;
      opts.ssh.keepaliveCountMax = 12;

      if (info.pem) {
        try {
          auth.pem = fs.readFileSync(resolvePath(info.pem), 'utf8');
        } catch (e) {
          console.error(`Unable to load pem at "${resolvePath(info.pem)}"`);
          console.error(`for server "${name}"`);
          if (e.code !== 'ENOENT') {
            console.log(e);
          }
          process.exit(1);
        }
      } else if (info.password) {
        auth.password = info.password;
      } else if (sshAgent && fs.existsSync(sshAgent)) {
        opts.ssh.agent = sshAgent;
      } else {
        console.error(
          "error: server %s doesn't have password, ssh-agent or pem",
          name
        );
        process.exit(1);
      }

      const session = nodemiral.session(info.host, auth, opts);
      this.sessions[name] = session;
    }
  }

  async swarmInfo() {
    const info = await this.getServerInfo();
    const currentManagers = swarmUtils.currentManagers(this.getConfig(), info);
    const desiredManagers = swarmUtils.desiredManagers(this.getConfig(), info);
    const nodes = swarmUtils.findNodes(this.getConfig(), info);
    const nodeIdsToServer = swarmUtils.nodeIdsToServer(this.getConfig(), info);
    const desiredLabels = getOptions(this.getConfig()).labels;
    const currentLabels = swarmUtils.currentLabels(this.getConfig(), info);

    return {
      currentManagers,
      desiredManagers,
      nodes,
      nodeIDs: nodeIdsToServer,
      desiredLabels,
      currentLabels
    };
  }
}
