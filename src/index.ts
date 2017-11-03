import * as filenamify from 'filenamify';
import * as path from 'path';
import * as yaml from 'yamljs';
import { argv } from 'yargs';
import expandTilde = require('expand-tilde');
import Logger = require('clix-logger');

const rootDir = argv.dir ? path.resolve(argv.dir) : __dirname;

const logger = Logger({
  appendTime: false,
  coloredOutput: true,
});

/* ============================================================================
 * Interfaces */

interface LiveLinkConfig {
  items: {
    [name: string]: string[];
  };
}

/* ============================================================================
 * Main */

logger.log('Using directory:', rootDir);
const config = loadYamlConfig();
Object.keys(config.items).forEach(name => {
  const paths = config.items[name];
  paths.forEach(bakPath => {
    const resolvedPath = resolveFullPath(bakPath);
    const linkFileName = filenamify(resolvedPath).toLowerCase();
    logger.subtle(`${resolvedPath} -> ${linkFileName}`);
  });
});

/* ============================================================================
 * Helpers */

function loadYamlConfig(): LiveLinkConfig {
  const yamlPath = path.join(rootDir, 'livelink.yml');

  return yaml.load(yamlPath);
}

function resolveFullPath(somePath: string) {
  return path.resolve(expandTilde(somePath));
}
