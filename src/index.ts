import * as filenamify from 'filenamify';
import * as fs from 'fs';
import * as inquirer from 'inquirer';
import * as path from 'path';
import * as yaml from 'yamljs';
import expandTilde = require('expand-tilde');
import Logger = require('clix-logger');
import tildify = require('tildify');

const logger = Logger({
  appendTime: false,
  coloredOutput: true,
});

main();

/* ============================================================================
 * Interfaces */

interface LiveLinkConfig {
  items: {
    [name: string]: string[];
  };
}

/* ============================================================================
 * Main */

async function main() {
  const rootDir = await inquireRootDir();

  // prompt the user for the sync directory (DONE)
  // whether they're trying to do a backup or a restore
  // and whether or not they want to be prompted for each individual conflict
  // options are: prompt individually / prefer sync folder item / prefer source

  const config = loadYamlConfig(rootDir);
  const linkGroups = generateLinkGroups(rootDir, config);

  linkGroups.forEach(linkGroup => {
    Object.keys(linkGroup.links).forEach(linkName => {
      const targetPath = linkGroup.links[linkName];
      const linkPath = path.join(linkGroup.syncDir, linkName);
      logger.subtle(`${linkPath} -> ${targetPath}`);
    });
  });
}

/* ============================================================================
 * Helpers */

function resolveFullPath(somePath: string) {
  return path.resolve(expandTilde(somePath));
}

function resolveYamlConfigPath(rootDir: string) {
  return resolveFullPath(path.join(rootDir, 'livelink.yml'));
}

function loadYamlConfig(rootDir: string): LiveLinkConfig {
  const yamlPath = resolveYamlConfigPath(rootDir);

  if (!fs.existsSync(yamlPath)) {
    logger.error('No configuration file found at', yamlPath);
    process.exit(1);
  }

  return yaml.load(yamlPath);
}

function generateLinkGroups(rootDir: string, config: LiveLinkConfig) {
  const items = Object.keys(config.items).map(name => {
    const syncDir = resolveFullPath(path.join(rootDir, 'links', name));

    const links = config.items[name].reduce((acc, bakPath) => {
      const resolvedPath = resolveFullPath(bakPath);
      const linkFileName = filenamify(resolvedPath).toLowerCase();

      return {
        ...acc,
        [linkFileName]: resolvedPath,
      };
    }, {});

    return { name, syncDir, links };
  });

  return items;
}

async function inquireRootDir() {
  const answers = await inquirer.prompt({
    name: 'rootDir',
    message: 'Enter your LiveLink sync directory',
    default: tildify(process.cwd()),
    validate: dir => {
      const resolvedRoot = resolveFullPath(dir);
      if (
        !fs.existsSync(resolvedRoot) ||
        !fs.statSync(resolvedRoot).isDirectory()
      ) {
        return `Invalid directory: ${tildify(resolvedRoot)}`;
      }

      const configPath = resolveYamlConfigPath(resolvedRoot);

      if (!fs.existsSync(configPath)) {
        return `No configuration file found at: ${tildify(configPath)}`;
      }

      return true;
    },
  });

  return answers.rootDir;
}
